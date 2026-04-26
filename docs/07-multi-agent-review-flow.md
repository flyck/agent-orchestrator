# Multi-Agent Review Flow — Avoiding Agent Theater

The risk with parallel reviewer pipelines is that they look impressive but produce diffuse, redundant output that's *worse* than a single careful pass. These are the rules and structures that keep the v1 review pipeline useful.

## The pipeline

```
input (diff | path)
   │
   ▼
┌─────────────┐
│  Planner    │  produces: structural map of the change
│             │  - changed files grouped by module
│             │  - new vs modified vs deleted
│             │  - cross-module boundary effects
│             │  - explicit "things reviewers should focus on"
└──────┬──────┘
       │ map handed to all reviewers
       ▼
┌──────────────┐ ┌──────────────────┐ ┌──────────────────┐
│  Security    │ │  Performance     │ │  Architecture    │  (parallel)
│  reviewer    │ │  reviewer        │ │  reviewer        │
└──────┬───────┘ └────────┬─────────┘ └────────┬─────────┘
       │                  │                    │
       └──────────────────┼────────────────────┘
                          ▼
                 ┌────────────────┐
                 │  Synthesizer   │  produces: ONE ranked finding list
                 └────────────────┘
```

## Rules that earn the parallelism

### 1. The planner does the routing

Without a planner, every reviewer reads the whole change and produces overlapping findings. The planner's job is to:
- Tell each reviewer *which files matter most for their angle*.
- Surface the cross-cutting changes that need attention from more than one reviewer.
- Flag what's out of scope ("this PR doesn't touch auth, security review can be terse").

The planner output is the *input* to every reviewer alongside the raw diff.

### 2. Reviewers must produce structured output, not prose

Each reviewer returns findings in a strict shape:

```yaml
findings:
  - id: sec-001
    severity: high | medium | low | info
    location: path/to/file.ts:42-58
    title: short imperative phrase
    detail: one paragraph max
    confidence: high | medium | low
    suggested_fix: optional, one paragraph
```

Free-form prose is rejected by a schema check before the synthesizer runs. This is what makes dedup and ranking tractable.

### 3. The synthesizer's contract

The synthesizer is **not** a summary writer. Its contract:

- **Dedup**: collapse findings that point at the same root cause into one item, listing the reviewers that flagged it (signal-of-multiple-confirmation).
- **Rank**: severity first, then confidence, then "number of reviewers who found it."
- **Dissent**: if reviewers disagree (e.g. security says "fine," performance says "this is a hot loop"), surface the disagreement — don't average it away.
- **Drop noise**: low-severity + low-confidence findings get a "noise" section that's collapsed by default.
- **Nothing new**: synthesizer cannot introduce findings that no reviewer raised. If it wants to, it must label them clearly as `synthesizer-observation` and explain.

### 4. Cost and time budgets

Each reviewer runs with a max input size (planner pre-filters the diff for it) and a soft output token cap. The synthesizer is the only agent allowed unrestricted context across all reviewer outputs.

### 5. Agent prompts are user-editable, but versioned

Built-in agents ship as markdown files in `prototype/backend/agents/builtin/` (frontmatter + system prompt). On first startup they're seeded into the `agents` table; from then on the user edits them in the Settings UI.

Each prompt covers:
- The role's responsibility in one paragraph.
- The required output schema.
- Anti-patterns ("don't do X").
- Examples of good output.

The DB row stores `updated_at`; every started session snapshots the prompt into `agent_runs.agent_prompt_snapshot` so we know exactly which version produced any given finding. "Reset to default" re-reads the shipped file. This is the highest-leverage tuning surface — keep prompts small, iterate often.

### 6. User comments are first-class inputs to the flow

Because sessions are interactive, the user can inject messages mid-review:

- **Direct to one agent**: "ignore the test files for this pass." Becomes an `inbound` message in that session.
- **Broadcast to all reviewers**: "the auth middleware is the part I care about." Same message to all parallel reviewers.
- **After synthesis**: "re-rank by security severity only." Triggers a synthesizer turn with the user note appended.

These messages are persisted in `messages` so the audit trail shows which findings were prompted by user steering vs. surfaced cold. The synthesizer's contract is updated: when a finding traces back to user steering, label it (`prompted-by-user`) so it doesn't get conflated with independent agent insight.

## Failure modes to watch for

| Failure | Symptom | Fix |
|---|---|---|
| **Reviewer drift** | Security reviewer comments on perf | Tighten role prompt; add explicit "out of scope" examples |
| **Synthesizer averaging** | Real findings get watered down to "consider X" | Stronger dissent rule; surface disagreement explicitly |
| **Confidence inflation** | Everything is "high confidence" | Calibrate prompt with examples of medium/low |
| **Findings without locations** | "There may be issues with concurrency" | Schema check rejects findings missing `location` |
| **Reviewer re-runs the planner** | Reviewers re-summarize the diff | Planner output is required input; reviewers must reference it by section, not redo it |

## Calibration loop (post-v1)

For each completed review the user can mark each synthesized finding as: `useful`, `noise`, or `missed-something`. Counts roll up per agent role and become the calibration signal for prompt tuning. This is cheap to add (one column on `agent_runs`'s findings, one button in the UI) and is the difference between "I think the security agent is good" and knowing.
