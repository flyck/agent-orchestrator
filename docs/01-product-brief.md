# Product Brief

## What we're building

A local-first desktop/web app that orchestrates multiple coding agents around a **review-first** workflow. One coherent product shell, not a collection of chat windows.

## Why this exists

Existing tools partially cover the space but none combine, in one open product:

- Dedicated **review tabs** (not just a `/review` slash command).
- **Multi-agent orchestration** with specialized roles.
- **PR architecture visualization** (impacted modules, dependency flow).
- **Counter-architecture proposals** with side-by-side comparison.
- Lightweight **token / cost oversight** per task and per agent.
- A **human-in-the-loop reminder** so the user keeps coding manually.

## Workspaces (tabs)

- **Review** — first-class. Reviews diffs, PRs, or paths from humans or agents.
- **Feature implementation** — spec → planner → implementer → self-review. User-authored spec is required (see [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md)).
- **Bugfix** — same gates as Feature, with a bug-shaped spec template.
- **Architecture compare / redesign** — current vs. proposed alternatives.
- **Background** — agent-initiated hygiene / refactoring / observation work, separate queue, conservative defaults. See [`11-background-agents.md`](11-background-agents.md).
- *(later)* broader analysis / audit views.

Each task that may modify code runs in its own **git worktree** so the user can open it in their normal IDE and watch agent changes live without polluting their working tree. See [`12-git-worktrees.md`](12-git-worktrees.md).

## Agent roles

| Role | Used in |
|---|---|
| Planner / architect | All tabs |
| Implementer | Feature, Bugfix |
| Self-reviewer | Feature, Bugfix |
| Security reviewer | Review (parallel) |
| Performance reviewer | Review (parallel) |
| Architecture analyst | Review, Architecture compare |
| Lead synthesizer | Review (always) |
| *(later)* test-quality, maintainability, usability reviewers | Review |

## Target review flow

1. Planner produces an implementation plan (or, for review, a structural map of the diff).
2. Implementation agent executes (only for Feature/Bugfix tabs).
3. Specialized review agents inspect the result **in parallel**.
4. Lead synthesizer reconciles findings, drops duplicates, ranks by severity.
5. UI presents **one coherent review output** with drill-down into per-reviewer transcripts.

## Beyond the review output

For PRs / diffs the UI should also show:

- Architecture visualization of impacted modules and changed boundaries.
- A counter-architecture or alternative design proposal.
- Token / cost overview per task and per agent.
- A nudge to occasionally code manually.

## Constraints

- Runs **locally** on the user's Linux machine.
- Frontend: Angular. Backend: Bun. (Both negotiable; this is the starting bet.)
- Open-source-friendly in spirit: even if a runtime engine is closed, the orchestration shell stays open and engine-pluggable.
- **Spec-driven by design.** The user authors a spec before any agent executes on Feature / Bugfix tabs. Workflow advances through explicit user-approved gates, never auto-completes. Full philosophy and UX in [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md). This is a structural defense against passive "auto-accept" agent use; it is not a process tax, it is the product.
