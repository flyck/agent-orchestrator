# Pipeline orchestrator simplification plan

The orchestrator code (`backend/src/orchestrator/`) has grown organically.
`index.ts` is 1,559 lines and mixes five concerns; comments explaining
quirks have replaced clear interfaces in several places. This is a plan
to cut it apart without changing behavior, in commit-sized steps.

## What's actually wrong today

### 1. `index.ts` is the orchestrator, the runner, the gate logic, the persistence layer, and the prompt assembly

```
index.ts (1,559 LOC)
├── startRun / startRunInternal       — queue + session bring-up
├── runLifecycle                      — legacy plan→code→review pump
├── runPipelineLifecycle              — phase walker
├── runPipelineAgent                  — single-phase session driver
├── persistReviewSideEffects          — yaml → DB
├── PIPELINE_AGENT_PROMPTS            — agent prompt registry
├── buildPipelinePhaseMessage         — per-phase user-message builder
├── finalizeTask                      — terminal-state handling
└── pumpUntilTerminal                 — engine-event drain
```

Eight concerns in one file. New gate semantics like the
`gate/sendback` rewind ended up wedged into `runPipelineLifecycle`
because that's where `awaiting_gate_id` is read; the read should
have moved to a small `resumeStrategy()` helper instead.

### 2. Two near-identical lifecycle pumps

`runLifecycle` (legacy code-task) and `runPipelineLifecycle` (the new
phase walker) duplicate session bring-up, error handling, and
terminal-state stamping. The legacy one is just the code-task pipeline
hard-coded; the spec already says it should be expressed as a pipeline
config.

### 3. The "resume" decision is implicit

`runPipelineLifecycle` reads `awaiting_gate_id` and `current_state` to
decide where to start, in three layered ifs added across three commits:

```ts
if (task.awaiting_gate_id) return idxOfGate + 1;        // approve
if (followUp && current_state matches phase) return idx; // sendback
return 0;                                                 // fresh
```

The state machine is **(awaiting_gate_id, current_state, followUp)** but
nowhere is that triple typed. `gate/sendback` sets two of the three
explicitly to nudge the runner; that's a code smell. It should be one
function call: `resumeFrom(task, opts) → PhaseIdx`.

### 4. YAML parsing is reviewer-only

`reviewer.ts` has `parseReviewerDecision` which extracts scoring +
alternatives + findings. The explorer has the same prompt shape but no
parser; explorer YAML output never makes it to the DB, so the Review
tab's radar + alternatives panels are always empty for review tasks.

### 5. Comments doing the work of code

Examples from this week alone:

```ts
// Splice the user's send-back feedback into the first agent
// call we make after resume. Subsequent agent calls (e.g.
// parallel reviewers) get their plain builder output.
const followUpForThis = pendingFollowUp;
pendingFollowUp = null;
```

vs. what it should be:

```ts
const builder = pendingFollowUp.takeOnce();
const message = buildAgentMessage(task, phase, agentSlug, builder);
```

The behavior is in the variable lifetime; the meaning is in the
comment. Move the meaning into a named type.

### 6. Pipeline definitions and runner coupled by string-key lookup

`PIPELINE_AGENT_PROMPTS` is a `Record<string, string>` of agent slugs
to system-prompt bodies, populated at module load via
`loadAgentPrompt(...)` calls. The runner looks up `phase.agents[i]` in
that record. New agents need edits in two places (pipelines.ts +
index.ts) and a typo silently skips the agent.

## Target shape

```
orchestrator/
├── index.ts             — public API: startRun, getEngine wiring (≤200 LOC)
├── pipeline/
│   ├── definitions.ts   — PipelineDef + the three pipelines (~150 LOC, mostly data)
│   ├── runner.ts        — runPipeline(task, opts) → walks phases until pause/done (~200 LOC)
│   ├── resume.ts        — resumeFrom(task, opts) → { phaseIdx, followUp } (~50 LOC)
│   ├── messageBuilders.ts — per-phase user-message composition (~150 LOC)
│   └── persist.ts       — writes phase outputs / scoring / alts / reviews (~120 LOC)
├── agents/
│   ├── prompts.ts       — agent slug → system prompt (loadAt module init)
│   └── parsers/
│       ├── reviewer.ts  — parseReviewerDecision (existing, moved)
│       └── explorer.ts  — parseExplorerOutput (NEW — same YAML shape)
├── lifecycle.ts         — finalizeTask + status stamping + nudge bump (~80 LOC)
└── prompts.ts           — shared system prompt assembly (already separate)
```

**Wins:**
- Each file has one job; the file name advertises it.
- Resume logic is a 50-line function with three explicit branches and
  the state-tuple as its argument type — no implicit globals.
- Adding an agent = add a row in `agents/prompts.ts`. Adding a parser
  = drop a file in `agents/parsers/`. The runner stays untouched.
- The legacy `runLifecycle` collapses into `CODE_TASK_PIPELINE` walked
  by the same runner. ~300 LOC deleted on that step alone.

## Migration steps (one PR each)

### Step 1 — extract resume.ts (small, mechanical)

Move the `startIdx` IIFE from `runPipelineLifecycle` into a pure
function `resumeFrom(task, opts) → ResumeDecision`. No behavior change.

```ts
type ResumeDecision = { phaseIdx: number; followUp: string | null };
function resumeFrom(task: TaskRow, pipeline: PipelineDef, opts: { followUp?: string }): ResumeDecision;
```

### Step 2 — extract persist.ts and explorer.ts parser

Move `persistReviewSideEffects` to its new home. Add
`parseExplorerOutput` that calls the existing `parseReviewerScoring`
and `parseReviewerAlternatives` (rename to
`parseRadarScoring`/`parseRadarAlternatives` — they were never
reviewer-specific). Wire `runPipelineAgent` to call the right parser
based on `agentSlug`.

This unlocks the explorer-YAML→DB path that's been silently broken.

### Step 3 — extract runner.ts

Move `runPipelineLifecycle` and `runPipelineAgent` to
`pipeline/runner.ts`. Inject the engine + DB writers as parameters
rather than module imports — makes the runner testable in isolation.

### Step 4 — extract messageBuilders.ts

`buildPipelinePhaseMessage` becomes a tiny dispatch table keyed on
`phase.builder`. Each builder is a pure function of `(task, phase,
priorOutputs)` returning the user message. New phases add a row, no
runner edits.

### Step 5 — collapse runLifecycle into CODE_TASK_PIPELINE

Express the legacy plan→code→review→ready→finalize lifecycle as the
existing `CODE_TASK_PIPELINE` and walk it with the same runner. Delete
`runLifecycle`. This is the biggest LOC win and the riskiest step;
gate it behind a feature flag for a release.

### Step 6 — strip legacy comments

After the above, the explanatory comments justifying the quirks
become obsolete because the quirks are gone. Sweep them.

## What NOT to do

- **Don't** redesign the gate semantics. The two-action model
  (approve / sendback) is right; only the implementation is messy.
- **Don't** add a third pipeline definition while the runner is
  fragile. Land the refactor first.
- **Don't** wrap the engine in another abstraction layer. The
  `EngineSession` interface is already the right boundary.

## Open questions

- Should the runner own the queue interaction, or should it stay in
  `startRun`? Today queue.submit / queue.release are scattered across
  both `startRunInternal` and the runner's `finally`. I lean toward
  keeping queue logic in `startRun` and treating the runner as a pure
  pump.
- Is there value in making each phase a class with `prepare/run/persist`
  methods? Probably no — pure functions composing better, and most
  phases share the same `run` shape. Revisit if a phase needs
  per-phase state beyond the message-builder dispatch.
- Once explorer YAML lands in the DB, do we still need
  `task_phase_outputs.output_md`? The structured fields cover the
  Review tab; the raw markdown is only displayed in the per-session
  transcript. Could be derived rather than stored. Worth a measurement
  pass.
