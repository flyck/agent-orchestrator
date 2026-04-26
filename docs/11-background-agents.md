# Background Agents

A separate workspace for **agent-initiated** work — refactoring, hygiene, and observation tasks the user did not ask for directly. Distinct from Review/Feature/Bugfix, which are user-initiated and operate under the spec-driven gates.

## Why a separate workspace

User-initiated work is bounded: the user wrote a spec, the user is paying attention, the user reviews the synthesis. Background work is unbounded by default — an agent that "looks for things to fix" can find infinite things to fix. Without structure it spams PRs, churns the codebase, and creates a haystack of small deployments where bugs become hard to trace back to a cause.

Background agents need their own:
- **Queue** with strict, conservative concurrency (default `1`).
- **Cadence policy** — they don't run constantly; they run on schedule or on signal.
- **Output model** that is *findings*, not *changes* — the user still has to decide to act and (for non-trivial work) author a spec.
- **Visibility surface** so the user can see what background agents are looking at without it polluting the focused workspaces.

## Relation to spec-driven workflow

Background agents do **not** draft specs for the user. The spec-driven principle ([10-spec-driven-workflow.md](10-spec-driven-workflow.md)) holds: the user writes the spec.

What background agents *can* produce is a **finding** — a structured observation:

```yaml
finding:
  agent: dead-code-detector
  detected_at: 2026-04-26T13:00:00Z
  severity: low | medium | high
  location: src/legacy/format.ts:120-180
  title: "Unused export `formatLegacy` — last referenced 2025-08"
  evidence: |
    grep across src/ shows zero callers; last commit touching it was
    8 months ago; not in public API surface (not in src/index.ts).
  action_options:
    - Dismiss (won't fix)
    - Snooze for 30 days
    - Open as Feature task (user authors spec from scratch — finding becomes context)
```

The "Open as Feature task" path **does not pre-fill the spec**. It opens the Feature tab with the finding pinned as a context note and the spec editor blank. The user authors the spec themselves.

## Agent definition: hybrid file + DB

For background agents specifically, and consistently for **all agents** going forward, the storage model is:

- **System prompt and instructions** live as markdown files on disk.
- **Metadata** (slug, name, icon, role, enabled, frequency, targets, file path, last run) lives in the SQLite `agents` table.
- The Settings UI markdown editor reads/writes the file; the DB row's `updated_at` and `prompt_hash` are bumped on save.

Why hybrid:
- The file is the source of truth; DB is the index.
- `git diff` works on prompts. Users can version control their agent definitions if they want.
- Easy to ship built-ins as files in the repo (`prototype/backend/agents/builtin/*.md`).
- The UI editor still works — it just writes the file under the hood.

Layout:

```
prototype/backend/agents/
  builtin/                  # ships with the app, read-only by default
    review/
      planner.md
      reviewer-security.md
      reviewer-performance.md
      reviewer-architecture.md
      synthesizer.md
    background/
      dead-code-detector.md
      todo-aging.md
      dependency-hygiene.md
      doc-drift.md
  custom/                   # user-created (gitignored from the app's repo;
                            # the user can move them into their own repo if they want)
    ...
```

Built-ins are seeded on first run by reading their frontmatter into the DB. Subsequent edits go via the UI (writes file, bumps DB) or directly to the file (next startup notices the hash change and re-syncs).

## Background agent file format

```markdown
---
slug: dead-code-detector
name: Dead Code Detector
icon: scissors
role: background
enabled: false
concurrency_class: background
cadence:
  base: weekly
  churn_signal:                  # optional — see git-history below
    target: ["src/**/*.ts"]
    rule: "skip if path changed in last 14 days"
limits:
  max_findings_per_run: 10
  max_session_tokens: 30000
model:
  providerID: github-copilot
  modelID: claude-haiku-4.5      # cheap model for background work
---

# Dead Code Detector

You scan the codebase for unused exports, unreachable functions, and
never-called API endpoints. You produce structured findings only — you do
not write code, you do not open PRs, you do not draft specs.

## What counts as dead code
...

## Output format
Each finding must include `location`, `evidence`, and `confidence`.
...

## Anti-patterns
- Do not flag entry points (main, index, public exports) without
  cross-checking external consumers.
- Do not flag generated code.
- Do not flag test fixtures.
```

The `concurrency_class: background` tag routes the agent to the background queue, separate from the foreground review/feature/bugfix queue.

## Cadence and the git-history signal

Two cadence sources, combinable:

1. **Base interval** — `daily | weekly | monthly | manual`. `manual` means the agent only runs when the user clicks "Run now."
2. **Git churn signal** — for agents whose work is path-scoped, frequency can be modulated by churn:
   - High-churn paths (many recent commits) → **skip**, code is in flux, suggestions are likely stale before review.
   - Low-churn paths (no recent commits) → **prefer**, code is settled and ripe for hygiene.
   - Implementation: `git log --since=<window> --pretty=oneline -- <target>` count, threshold from agent's `churn_signal.rule`.

The orchestrator computes the eligible target set on each tick, then runs the agent against it (or against a sample if the set is large).

## Default agents shipped (all disabled by default)

Conservative starter pack. The user enables what they want. None of these auto-fix or auto-PR.

| Agent | What it finds | Cadence |
|---|---|---|
| `dead-code-detector` | Unused exports, unreachable functions, orphan files | weekly, skip-high-churn |
| `todo-aging` | TODO/FIXME comments older than N months (no LLM needed for first pass — pure grep + git blame) | monthly |
| `dependency-hygiene` | Outdated, deprecated, duplicate, or unused deps | monthly |
| `doc-drift` | Public API signatures changed without doc updates | on-demand after merges (manual in v1) |
| `test-coverage-gaps` | High-churn files with low test coverage | manual in v1 |

## Background queue

Separate from the foreground queue. Configurable in Settings:

- `max_parallel_background_agents` — default `1`, range `1–4`.
- `max_background_runs_per_day` — soft cap (warns, doesn't block).
- `background_token_budget_usd_per_day` — separate from the foreground budget.

This separation matters because background work should never starve the user's focused queue. If the foreground queue is full, background work is paused, not racing for the same slots.

## UI: the Background tab

Three sections, each as a paper-style list:

1. **Pending findings** — what background agents have surfaced for review. Each row: agent icon, title, location, age, action buttons (Dismiss / Snooze / Open as Feature).
2. **Schedule** — what's queued to run next, when, and why. Empty when nothing's scheduled.
3. **History** — completed runs with finding counts and cost. Click to drill into the agent's session transcript.

A "Run now" button per agent in the Settings → Agents → Background section lets the user trigger out of cadence.

## Anti-patterns (permanent rejections)

- ❌ Background agents that auto-create PRs.
- ❌ Background agents that auto-merge.
- ❌ Background agents that draft specs from findings.
- ❌ "Aggressive" cadence presets (e.g. "run every 5 minutes").
- ❌ Background agents that share the foreground queue.
- ❌ Findings that are persistent banners across the whole app (they live in the Background tab; the rest of the app does not know they exist).

## v1 scope

- Background tab UI (pending / schedule / history).
- Hybrid file+DB agent storage (refactored to apply to **all** agents — not just background).
- Background queue with `max_parallel_background_agents` (default 1) configurable in Settings.
- Built-in agents shipped as files, all disabled by default.
- Manual "Run now" works end-to-end for at least `todo-aging` (the simplest, no-LLM version is grep + git blame; useful proof of the pipeline).
- Cadence-based scheduling: a simple in-process scheduler that ticks every minute and admits eligible runs based on `cadence.base`.

Out of v1 (deferred to v2):

- Git-churn-signal cadence modulation. Foundation in DB, no scheduler logic yet.
- "Open as Feature" bridge — for now, dismiss/snooze only.
- Background agents with web/external tool access.
