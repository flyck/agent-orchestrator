# PR Review Pipeline

How a GitHub PR review actually runs end-to-end. Distinct from the local code-task pipeline (Spec → Plan → Code → Review → Ready → Finalize) — the work has already shipped, we're not editing it, and the input is a diff + author intent rather than a user-authored spec.

Two designs are on the table. Both share the same set of underlying agents (some new, some already in `agents/builtin/review/`); the difference is the shape of the pipeline they form.

## Design A — Gate-driven (the sketch)

The user's original idea, refined:

```
┌───────────────┐
│ spec-intake   │ ← reads PR body, extracts linked issues (#NN, "Fixes:"
└──────┬────────┘   "Closes:"), fetches their bodies, infers from commits.
       │            Output: synthesized spec_md.
       ▼
┌────────────────────┐
│ solution-explorer  │ ← single agent. Scores the implementation on the
└──────┬─────────────┘   five-axis radar + proposes 0–3 viable alternatives,
       │                 each with its own radar + verdict (better/equal/worse).
       │                 Output: implementation radar + alternatives table.
       ▼
┌────────────────┐
│ DIRECTION GATE │ ← user clicks "approve direction" or "send back with
└──────┬─────────┘   feedback". Pipeline pauses until clicked. Send-back
       │             feedback re-runs the explorer with the user's note.
       ▼
┌──────────────────────────────────────────────────────────────┐
│ parallel: reviewer-security · -performance · -bug-finder     │
└──────┬───────────────────────────────────────────────────────┘
       │  3 specialists, independent sessions, run in parallel.
       │  Each emits structured findings (severity, confidence,
       │  location, title, detail) — no overlap policed at this layer.
       ▼
┌─────────────┐
│ synthesizer │ ← dedups overlapping findings, ranks by
└──────┬──────┘   severity × confidence, drops nitpicks.
       │
       ▼
   ready (user reads the synthesis; can copy as a PR comment)
```

**Strengths**
- The gate enforces engagement: you don't get a 50-finding wall-of-text without first agreeing the PR's direction is sound. Matches the manifesto's stance against auto-accepting agent output.
- Solution-explorer up front is cheap (one agent) and pre-empts the "we deep-reviewed a PR that should have been rewritten from scratch" failure mode.
- Each phase has one purpose; easy to debug when something misfires.

**Weaknesses**
- Latency. Five sequential phases (counting parallel as one) and a manual gate. A small PR that didn't need direction-checking still pays for the gate click.
- Explorer + parallel reviewers can disagree about complexity — the radar is set in phase 2, then the deep reviewers might surface findings that retroactively change "this looks simple" to "actually it's tangled." The radar ends up stale.
- The gate is binary. "Approve direction" vs "send back" loses nuance; in practice the user often wants "proceed but skip arch review since it's a bug fix."

## Design B — Triage-first, parallel from the start (counter-idea)

```
┌────────────┐
│ triage     │ ← cheap fast-model agent. Looks at the PR title + body +
└──────┬─────┘   file paths. Decides:
       │           - skip (draft / dependabot / lockfile / generated /
       │             trivial)        → finalize, done.
       │           - light    (≤200 LOC, 1 area)  → bugs only
       │           - standard (medium)             → security + bugs
       │           - deep    (large / cross-cutting) → full panel
       │         Output: depth tag + a one-line rationale.
       │
       ▼ (parallel)
┌──────────────┐  ┌──────────────┐
│ spec-intake  │  │ planner-map  │ ← parallel: intake reads PR/issue/commits,
└──────┬───────┘  └──────┬───────┘   planner-map produces a structural map of
       │                 │           the diff (modules/files/cross-cutting).
       └────────┬────────┘
                ▼
   ┌────────────────────────────────────────────────────────────┐
   │ parallel reviewers (depth-gated):                          │
   │   bugs            (always)                                 │
   │   security        (depth ≥ standard)                       │
   │   performance     (depth ≥ standard)                       │
   │   architecture    (depth = deep)                           │
   │   solution-explorer (depth = deep)  ← alternatives produced │
   │                                       inside the panel,    │
   │                                       not before it        │
   └──────┬─────────────────────────────────────────────────────┘
          │
          ▼
    ┌─────────────┐
    │ synthesizer │ ← merges, dedups, ranks, attaches the
    └──────┬──────┘   solution-explorer's alternatives where relevant.
           │
           ▼
       ready
```

**Strengths**
- The cheap triage front-runs the gate. A trivial PR finalizes in seconds with one agent run; you don't pay for explorer + 3 deep reviewers + synthesis on a one-line typo fix.
- All reviewers (and the explorer) run in parallel after intake/map. Wall-clock time = max(reviewer durations) + intake/synth, not sum.
- Depth tagging means the user always gets *something* but spend scales with the diff. The radar is computed during synthesis from all reviewers' inputs, so it can't go stale relative to findings.
- No mid-pipeline gate — fewer interruptions for the user, who can still send back from Ready.

**Weaknesses**
- Triage is a model call, which means it can be wrong. A PR triaged "light" might actually deserve a security pass; mitigation is conservative defaults and a one-click "deepen" action on the result.
- More agents per task = more cost on standard/deep PRs. (Light / skip cases dominate in practice, so the average is fine.)
- Loses the "user approves direction before deep review" affordance that Design A has. If you really want direction-checking, it has to be opt-in (e.g. a Settings toggle "always show solution-explorer first") or surfaced by the explorer's output ("I'd actually take a different approach — confidence: high").

## Recommendation

**Ship Design B as the default; expose Design A as a per-repo opt-in.**

Reasoning:
- Design B's median PR finishes faster and burns fewer tokens; the user complaint we'd most likely hear is "I clicked review and got nothing useful for two minutes," and B is built to avoid exactly that.
- Design A's direction gate is genuinely useful for high-stakes PRs (architecture changes, new public APIs, junior-dev contributions). Per-repo opt-in lets the user keep that discipline where it matters without paying its latency on every dependabot bump.
- A Settings toggle `pipeline_kind: triage_first | direction_gated` per watched repo is one DB column and one branch in the orchestrator.

## Agents involved

- `pr-spec-intake` (new) — synthesizes a spec from PR + linked issues + commits.
- `solution-explorer` (new) — radar scoring + alternatives. In Design A: standalone phase. In Design B: a depth=deep reviewer.
- `triage` (new, Design B only) — fast-model classifier.
- `review-planner` (existing in `agents/builtin/review/planner.md`) — module/file map.
- `reviewer-security`, `reviewer-performance`, `reviewer-architecture` (existing) — specialists.
- `reviewer-bug-finder` (new alias / refactor of `reviewer-coder` for the bug-only specialty).
- `synthesizer` (existing) — dedup + rank.

## Storage / runtime model

A `pipelines` config (initially in code, later promotable to DB) defines named pipelines with phases. Each phase declares: id, label, kind (`agent | parallel | gate`), agent slug(s), and how to build the user message + system prompt.

The orchestrator's `runLifecycle` becomes pipeline-driven: instead of hard-coded plan → code → review branches, it walks the phases of the task's pipeline and dispatches accordingly. `ActiveTask.phase: string` becomes opaque to the lifecycle; the pipeline definition owns the transitions.

User gates are modeled as task-level `awaiting_user_decision` states — the orchestrator pauses the run, surfaces a UI affordance, resumes on the user's response.

This change is the bulk of the implementation work; the agent prompts and the per-pipeline phase list are comparatively small.
