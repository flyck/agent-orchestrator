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

### Step 1 — extract resume.ts (small, mechanical) — DONE (1d829b9)

`resumeFrom(task, pipeline, opts) → ResumeDecision` lives in
`orchestrator/resume.ts`. Returns `{ phaseIdx, reason, followUp }`;
the `reason` tag (approve/sendback/fresh) flows into the runner's
log so we can tell at a glance why a run started where it did.

### Step 2 — persist.ts + explorer parser — DONE (bd146c3, 0139805)

`orchestrator/persist.ts` owns the YAML→DB write paths via a single
`persistAgentReply(taskId, agentSlug, phaseId, reply)` dispatch.
`orchestrator/explorer.ts` owns the explorer YAML parser (sister to
`reviewer.ts`'s existing parser). The `runPipelineAgent` post-pump
section shrinks to one call. The reviewer-side helpers
(`parseReviewerScoring` etc.) were NOT renamed to
`parseRadarScoring` — kept the existing names since the diff felt
out of scope; rename can land later if/when a third agent uses the
same shape.

### Step 4 — extract agentPrompts.ts — DONE (94fd451)

`orchestrator/agentPrompts.ts` owns `loadAgentPrompt`,
`PIPELINE_AGENTS`, `PIPELINE_AGENT_PROMPTS`, `getAgentOutputSpec`,
and `buildPipelinePhaseMessage`. Pure data + pure functions, no
runtime coupling. `index.ts` lost ~140 LOC. Did NOT do the proposed
"phase.builder dispatch table" rewrite — the existing if-tree in
`buildPipelinePhaseMessage` is fine for the four phases that exist;
table dispatch would just be a different shape of branch. Land
that if a fifth phase appears.

### Step 5 — collapse runLifecycle into CODE_TASK_PIPELINE — NOT YET

Investigated and DEFERRED. The pipeline runner today walks distinct
phases with distinct sessions per agent; `runLifecycle` does
something genuinely different that the pipeline runner can't do
yet:

  - Watchdog-triggered phase advancement (`watchdogRecovered` flag
    treats a hung session as the phase finishing cleanly).
  - Cycle-budget for the review→code loop (`MAX_REVIEW_CYCLES`,
    `incrementReviewCycles`).
  - Fail-open semantics per phase (plan-error → still try code;
    review-error → accept; coder-restart failure → finalize done).
  - Per-phase session rolling (the same `a.session` gets replaced
    by `switchToReviewer`/`switchToCoder`, not closed and reopened
    per agent like the pipeline runner does).

A clean collapse needs the pipeline runner to learn those tricks
first. Two-step path:

  - Step 5a — extend `PhaseDef` with `on_error: 'fail' | 'fall_through' |
    'fail_open'` and `cycle_with: { phase_id, max }`. Runner reads
    these. No `runLifecycle` deletion yet; just teach the new
    runner to handle the same edge cases.
  - Step 5b — express `CODE_TASK_PIPELINE` with the new fields,
    behind a feature flag (settings.pipeline_runner_v2 = true|false).
    Run both for a release; flip the default once metrics agree.
  - Step 5c — delete `runLifecycle` once the flag has been on by
    default for a release.

This is bigger than originally sketched. Don't try to collapse it
in one PR.

### Step 3 — extract runner.ts — DEFERRED until after step 5

Originally planned before step 5; reordering. Extracting the runner
without first unifying the two lifecycles means the new runner
module immediately has to host BOTH `runLifecycle` and
`runPipelineLifecycle` plus their helpers (`switchToCoder`,
`switchToReviewer`), which is most of `index.ts`. Better to unify
first, then extract the unified runner.

### Step 6 — strip legacy comments — DEFERRED

Tied to Step 5 — many of the comments explain `runLifecycle`'s
quirks, which only become safe to delete once the lifecycle
collapses.

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
