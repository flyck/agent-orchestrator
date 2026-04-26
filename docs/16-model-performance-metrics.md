# Model Performance Metrics

A meta-knowledge layer that lets the user see, over time, **which models are worth using for which kinds of tasks** in their codebase.

## The idea

Two pieces of data about every completed task:

1. A **difficulty score** (1–10) assigned by a small "scoring agent" at task creation, calibrated against a handful of user-editable example tasks at known difficulty.
2. Recorded outcomes: token usage, wall-clock time, success/failure, model(s) used.

A historic view in the UI lets the user compare models on cost-per-difficulty, time-per-difficulty, and success-rate-by-difficulty, filtered by model / date range / agent role.

## Why

Without this, model choice is anecdotal: "I think Sonnet 4.6 has been better lately." With it, the user can see whether a model is regressing, whether a cheaper model is fine for low-difficulty tasks, and whether a specific agent role benefits from a more expensive model.

The point is to make the user's "which model where" decisions evidence-based, not vibes-based. Pairs naturally with Mandate 4 (bounded agent work): if you can show that Haiku gets 80% of the value at 10% of the cost on difficulty-3 reviews, defaulting Haiku for low-difficulty work becomes obvious.

## Difficulty scoring

A dedicated **scoring agent** runs once at task creation. Inputs: the task's spec (or input diff for Review), repo context summary, and a small set of calibration examples (the anchors). Output: an integer 1–10 plus a one-line justification stored alongside the score.

### Calibration anchors

A user-editable file (`prototype/backend/agents/builtin/scoring/calibration.md`) lists a handful of canonical example tasks at known difficulty levels. The scoring agent uses these as anchors. Initial seed:

```
1 — Rename a single local variable in one file.
3 — Add a new field to an existing form, including the API change.
5 — Add a new HTTP endpoint with handler, tests, and documentation update.
7 — Refactor a module to extract a shared abstraction without behaviour change.
9 — Redesign a subsystem (e.g. authentication) with a multi-step migration plan.
10 — Cross-cutting architectural change touching most of the codebase.
```

Users edit this to reflect their codebase. The scoring agent reads the calibration file at every invocation, so changes take effect immediately. The user can also override a score post-hoc if they disagree.

### When scoring runs

| Workspace | Score basis |
|---|---|
| Review | Diff size + structural complexity inferred by the agent |
| Feature | The spec |
| Bugfix | The spec |
| Architecture Compare | The current vs. proposed spec |
| Background | Auto-set to `2` (most background work is small) |

Scoring is fast and cheap: a single Haiku-class call with a few hundred tokens of context. Cost rounding error.

## Recording

A `task_metrics` table:

```sql
CREATE TABLE task_metrics (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  difficulty INTEGER NOT NULL,           -- 1–10 from scoring agent
  difficulty_justification TEXT,         -- one-line reasoning
  difficulty_overridden_by_user INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL,         -- sum across all agent runs
  output_tokens INTEGER NOT NULL,
  cost_usd_micros INTEGER NOT NULL,      -- sum across all agent runs
  wall_clock_ms INTEGER NOT NULL,        -- task created → terminal status
  models_used_json TEXT NOT NULL,        -- ["github-copilot/claude-sonnet-4.5", ...]
  primary_model TEXT,                    -- the model used by most agents
  outcome TEXT NOT NULL,                 -- accepted | sent_back | archived | failed | canceled
  recorded_at INTEGER NOT NULL
);
```

One row per task, written when the task reaches a terminal state. Per-agent token rows already live in `agent_runs`; this is the task-level rollup that joins to difficulty.

## Historic view

A **Performance** sub-section in the Cost tab (could become its own tab later if it grows). Charts:

- **Cost vs. difficulty**, per model. Scatter or line — each task is a dot.
- **Time vs. difficulty**, per model.
- **Success rate by difficulty band** (1–3 / 4–6 / 7–10), per model.
- **Trend over time** for a chosen model (cost-per-difficulty-point per week).

Filters: model, date range, workspace (Review / Feature / Bugfix / etc.), agent role.

The visual treatment follows the paper aesthetic — small charts, hairline axes, monospace numbers, no fills. Inspired by Tufte / FT graphics, not dashboard-default Highcharts.

## Anti-patterns

- ❌ Scoring without calibration anchors. The scoring agent must have anchors; otherwise scores drift.
- ❌ Auto-switching models based on metrics without the user's say-so. The metrics inform the user's decisions; they do not make decisions automatically.
- ❌ Hiding low-confidence scores. If the scoring agent is uncertain, surface that in the UI; don't pretend confidence.

## Status

**Not in v1.** Documented as a v2 feature requirement.

When implemented, it depends on:
- Cost accounting from the OpenCode adapter (already planned for v1).
- Per-agent runs and tokens persisted (already in v1 schema).
- A scoring agent definition (file in `agents/builtin/scoring/`, plus the calibration anchor file).
- The Cost tab being built first (already in v1 scope, even if minimal).

## v2 scope

- Scoring agent + calibration file.
- `task_metrics` table populated on terminal status.
- Performance sub-section in the Cost tab with the four chart types above.
- Manual override UI for difficulty.
