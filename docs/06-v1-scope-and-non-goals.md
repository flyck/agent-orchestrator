# v1 Scope & Non-Goals

The smallest credible version that proves the product idea on the user's local machine, on Direction C (OpenCode).

## In scope (v1)

### Workspaces
- **Review tab — fully working end-to-end.** Input: pasted diff or local path, plus an optional **Review focus** field. Output: planner map + 3 parallel reviewers (security, performance, architecture) + lead synthesis. **Sessions stay open** so the user can comment into any reviewer pane mid-review or after.
- **Feature & Bugfix tabs — Spec editor works; downstream stubbed.** The user-authored spec UI (template, soft hints, revisions, optional "Critique my spec" agent) ships in v1. The Plan / Implement / Review / Accept states render placeholders pointing to v2. See [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md).
- **Architecture Compare tab — scaffolded only**, placeholder describing the planned agent composition.
- **Settings tab** — general (concurrency, budget, nudge), agents (editable cards), engine (OpenCode model + provider config).
- **Cost tab** — today / 7-day token + USD totals, breakdown per agent role.

### Interactive sessions
- Each agent role runs in its own long-lived OpenCode session.
- Per-pane input strip: type into a single agent or broadcast to all reviewers.
- Cancel a single agent's current turn without killing the task.
- Messages and raw events persisted for replay.

### Editable agents
- Built-in agents seeded from markdown files on first startup.
- Settings → Agents lists every agent as a paper card with icon, name, role.
- Markdown editor for the system prompt (CodeMirror 6, preview pane).
- Lucide icon picker from a curated muted set.
- Enable / disable individual agents.
- Reset built-ins to shipped defaults; delete custom agents.
- Edits don't affect already-running sessions; next session uses the new prompt.

### Orchestration
- Configurable concurrency: `max_parallel_tasks`, `max_agents_per_task`.
- Optional `daily_token_budget_usd` — soft warning at 80%, hard block at 100%.
- Job queue persists across restarts.

### Engine
- Single adapter: OpenCode (strategy chosen in Phase 0 — server mode preferred, PTY fallback).
- `EngineAdapter` interface allows a second engine later.

### Persistence
- SQLite via `bun:sqlite`. Tables: tasks, agent_runs, sessions, messages, engine_events, agents, settings.

### Streaming
- Bidirectional WebSocket per task. Outbound events, inbound user messages.

### Design
- Paper aesthetic, near-monochrome. Full spec in [`08-design-system.md`](08-design-system.md).
- No bright colors except a single ink-red accent for high-severity findings.
- Serif headings, sans body, mono for code, hairline rules, no shadows.

### Spec-driven workflow (v1 partial)
- Spec template editor for Feature / Bugfix tabs with structured sections (Goal, Non-goals, Acceptance criteria, Scope, Open questions). Empty sections show soft inline hints; nothing is hard-blocked.
- Optional "Critique my spec" action runs a single fast-model agent that may suggest gaps but cannot edit the spec.
- Spec persisted as task input; revisions tracked in `spec_revisions`.
- State strip shows live progress through Spec → Plan → Implement → Review → Accept. States beyond Spec render placeholder UI pointing to v2.

### Human-in-the-loop nudge
- Banner after every Nth completed task. N configurable.
- Quiet companion to the spec discipline — keeps non-agent skills exercised.

## Non-goals (deferred)

- GitHub / GitLab / Bitbucket integrations. Local diffs and paths only.
- Architecture diagram rendering. We render the analyst's markdown; diagrams are v2.
- Counter-architecture side-by-side compare UI.
- Authentication, multi-user, RBAC.
- Cloud sync, telemetry, analytics.
- A second engine adapter (interface only).
- Additional reviewer types (test-quality, maintainability, usability) beyond the three.
- Real-time collaboration between humans.
- Desktop packaging (Tauri/Electron).
- Theming. Paper design is the only theme. (User-facing density toggle is the one allowed knob.)
- **Running tasks without a user-written spec ("auto-pilot").** Permanently rejected, not deferred. Per [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md).
- **Agent-drafted spec first drafts.** Permanently rejected. Critique-only.
- **Hard gates with disabled-until-complete buttons.** Permanently rejected — that's friction for friction's sake. The spec is the discipline; the rest of the workflow runs forward with visible state and on-demand interjection.

## Definition of done for v1

A user can:

1. Start backend, frontend, and OpenCode in three terminals (or two if PTY-spawn).
2. Open the Review tab.
3. Paste a diff or point at a local repo path.
4. Click "Run review" — watch four panes stream live.
5. Type a question into the security pane mid-review and see the agent respond.
6. Read a coherent synthesized review with ranked findings.
7. See the token/USD cost of that review.
8. Open Settings → Agents, edit the security reviewer's prompt, save, run a second review and see the changed behavior.
9. Add a custom agent (e.g. "Accessibility Reviewer"), enable it, see it appear in subsequent reviews.
10. Set `max_parallel_tasks=1` in Settings; submit two reviews; second queues.
11. After N reviews, see the manual-coding nudge banner.
12. Restart the backend; previous tasks, messages, and agent edits are still there.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| OpenCode upstream is stale or session API doesn't exist | Phase 0 spike before any other work; PTY fallback strategy documented |
| OpenCode session protocol changes | All engine specifics live in `OpenCodeAdapter`; pin a version in README |
| Token costs spike during interactive testing | Default `max_agents_per_task=3`, optional daily USD budget |
| Synthesizer becomes regurgitation (agent theater) | Rules in [`07-multi-agent-review-flow.md`](07-multi-agent-review-flow.md) — structured findings, dedup, dissent |
| User edits break a built-in agent | "Reset to default" restores the shipped prompt |
| Concurrent SQLite writes from many sessions | Single-writer pattern through repo layer; `bun:sqlite` synchronous API serializes |
| Long-lived sessions leak (process / token) | Idle timeout closes sessions; cost meter shows open-session count |
