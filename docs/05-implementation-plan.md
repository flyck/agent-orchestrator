# Implementation Plan — v1 Prototype

Concrete, ordered steps to build the local prototype on Direction C (OpenCode + interactive sessions).

## Phase 0 — OpenCode integration smoke test

Most of the original Phase 0 research is already done — see [`09-opencode-integration-notes.md`](09-opencode-integration-notes.md). What remains is a 30-minute smoke test against the user's installed `opencode` 1.1.6 (anomalyco fork) to confirm the HTTP API behaves as documented:

1. Start `opencode serve --port 4096 --hostname 127.0.0.1` with `OPENCODE_SERVER_PASSWORD` set.
2. `curl /global/health` → 200.
3. `curl -N /event` → first event is `server.connected`.
4. `POST /session` → record session id.
5. `POST /session/:id/prompt_async` with `{ system, parts }` → SSE shows the streamed response with that session id, terminating with a `done`-class event and a `usage` payload.
6. `POST /session/:id/abort` cancels mid-stream.
7. Run two sessions concurrently and confirm their event streams interleave (not serialize).

Write the observed event-type names down at the bottom of `09-opencode-integration-notes.md` — those are the strings the adapter parses. Then proceed.

## Phase 1 — Repo bootstrap

1. `git init` at repo root; `.gitignore` for `node_modules`, `dist`, `.bun`, `*.sqlite`, `.DS_Store`.
2. Initial commit including current docs.

## Phase 2 — Backend skeleton (Bun + Hono + SQLite)

1. `cd prototype/backend && bun init -y`.
2. Deps: `hono`, `zod`, `nanoid`. (Bun has native WebSocket and `bun:sqlite`.)
3. `src/db/schema.sql` — all tables from `docs/04-architecture.md`.
4. `src/db/index.ts` — open `bun:sqlite` at `./data/orchestrator.sqlite`, run schema, seed default settings + built-in agents.
5. Repositories: `tasks`, `agentRuns`, `sessions`, `messages`, `engineEvents`, `agents`, `settings`.
6. `/api/health` and `/api/settings` endpoints.

**Verify**: `curl localhost:PORT/api/settings` returns defaults.

## Phase 3 — Built-in agents seeded from markdown

1. Author starting prompts in `prototype/backend/agents/builtin/`:
   - `planner-review.md`
   - `reviewer-security.md`
   - `reviewer-performance.md`
   - `reviewer-architecture.md`
   - `synthesizer.md`
2. Each file has frontmatter (`slug`, `name`, `icon`, `role`) and a markdown body (the system prompt).
3. On startup, upsert into the `agents` table with `is_builtin=1` if the slug doesn't exist; existing rows are *not* overwritten (so user edits survive).
4. `POST /api/agents/:id/reset` re-reads the file and overwrites the row.

**Verify**: `GET /api/agents` returns five rows with markdown.

## Phase 4 — Engine adapter (OpenCode)

1. `src/engine/types.ts` — `EngineAdapter`, `EngineSession`, `EngineEvent`.
2. `src/engine/opencode.ts` — implementation per the strategy decided in Phase 0.
3. `src/sessions/pool.ts` — opens / tracks / closes sessions; publishes events to a `Hub`.
4. CLI smoke script `scripts/smoke-engine.ts` — open session with a built-in agent's prompt, send a message, print events.

**Verify**: smoke script streams a real OpenCode response.

## Phase 5 — Job queue with configurable concurrency

1. `src/queue/semaphore.ts` — async semaphore.
2. `src/queue/index.ts` — global + per-task semaphores; reads settings on each admit.
3. Optional `daily_token_budget_usd` enforcement using `cost` repo.

**Verify**: scripted test — submit 5 tasks with `max_parallel_tasks=2`, observe at most 2 running.

## Phase 6 — Orchestrator (Review workspace, end-to-end)

1. `runReview(taskId)`:
   - Open planner session, send the input, await first complete output.
   - Open 3 reviewer sessions in parallel (each gets the input + planner's map). Use per-task semaphore.
   - When all 3 reviewers finish their first turn, open synthesizer session with all reviewer outputs.
   - Sessions stay open until task is closed — user can keep talking to any of them.
2. Persist messages and events at every step.

**Verify**: from a script, submit a small diff; all 5 sessions complete and synthesis is written.

## Phase 7 — WebSocket layer

1. `src/streams/hub.ts` — pub/sub keyed by `taskId`.
2. `WS /api/tasks/:id/ws` — Hono / Bun WebSocket upgrade.
   - Outbound: `agent.event`, `agent.status`, `task.synthesis`.
   - Inbound: `user.message { agent_run_id, text }`, `user.message { broadcast: true, text }`, `agent.cancel`.
3. Inbound `user.message` is persisted to `messages` and forwarded to the matching `EngineSession.send()`.

**Verify**: a `wscat` client receives streamed events and can send a message that produces a follow-up agent response.

## Phase 8 — Frontend skeleton (Angular)

1. `cd prototype/frontend && bunx @angular/cli new app --routing --style=scss --skip-git --standalone`.
2. Install Tailwind; configure paper palette per `docs/08-design-system.md`.
3. Install `lucide-angular` for icons; `ngx-markdown` for rendering.
4. Routes: `/review`, `/feature`, `/bugfix`, `/arch`, `/settings`, `/cost`.
5. Services: `ApiService`, `TaskWsService` (wraps WebSocket as RxJS subjects), `AgentsService`, `SettingsService`.

**Verify**: `bun --bun ng serve` loads the empty shell with the paper layout and tab bar.

## Phase 9 — Review tab end-to-end

1. Input picker (paste diff, local path).
2. "Run review" → `POST /api/tasks` → opens WebSocket → renders panes.
3. Per-agent pane:
   - Header: agent icon + name + status dot.
   - Streaming markdown body.
   - **Bottom input strip** for typing into this agent's session. Enter sends; Cmd+Enter sends as broadcast to all reviewers.
4. Synthesis pane below the reviewer row.
5. Cost line under the synthesis (in/out tokens, USD).
6. "Raw events" toggle reveals `engine_events` rows for debugging.

**Verify**: paste a small diff, click Run, watch four panes stream, type a follow-up question into the security pane, see it respond, see synthesis update if the user requests a re-synth.

## Phase 10 — Settings page: general + agents

1. **General** section: bound to `/api/settings` (concurrency, budget, nudge cadence).
2. **Agents** section:
   - List of agents as paper cards with icon, name, role tag, enabled toggle.
   - "Edit prompt" opens a full-screen markdown editor (e.g. CodeMirror 6 with markdown mode + preview).
   - "Reset to default" for built-ins; "Delete" for custom; "+ New custom agent" CTA at the bottom.
   - Icon picker is a dialog showing a curated set of Lucide icons (≈40 muted line icons).
3. Save bumps `updated_at`; running sessions keep their snapshot, new sessions use the new prompt.

**Verify**: edit the security reviewer's prompt; start a new review; observe the changed behavior. Reset; re-run; default behavior returns.

## Phase 11 — Manual-coding nudge

1. After every Nth completed task, show a paper-toned banner reminding the user to do the next change manually.
2. Counter persisted in `settings` (`completed_since_last_nudge`).
3. Banner stays until acknowledged.

**Verify**: complete N reviews; banner appears.

## Phase 12 — Spec gate UI for Feature & Bugfix tabs

The spec-writing experience is in v1; downstream agent execution is v2. See [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md) for the full spec.

1. Spec editor component shared between Feature and Bugfix tabs:
   - Markdown editor (CodeMirror 6) with required section headers pre-rendered (Goal, Non-goals, Acceptance criteria, Scope, Open questions). Section bodies start empty.
   - Section-completeness validator — Submit disabled until each section has non-whitespace content.
   - "Critique my spec" button — fires a single fast-model agent with a strict critique-only prompt; output renders in a sidebar; cannot edit the spec.
   - Tab-specific labels: Feature uses these section names verbatim; Bugfix renames Goal→"Bug summary", adds Repro steps and Expected vs. Observed.
2. Persistence: spec markdown stored in `tasks.input_payload`; revisions stored as a `spec_revisions` side table keyed by `task_id` with monotonic `version` and timestamp.
3. Lock-on-advance: clicking Submit transitions the task to `plan_pending` and freezes the spec. An "Edit spec" button re-opens the editor and writes a new revision row.
4. Gate visualization: horizontal row of section markers above the editor (Spec ● — Plan ○ — Implement ○ — Review ○ — Accept ○). Future gates render with a "v2 — coming" placeholder when clicked.

## Phase 13 — Architecture Compare stub

Render a placeholder describing the planned agent composition. Shares `Orchestrator`, `JobQueue`, and the WS hub.

## Out of scope for v1 (explicit)

- GitHub/GitLab PR ingestion or comment posting.
- Architecture diagram rendering (we render the analyst's markdown).
- Counter-architecture side-by-side compare UI.
- Multi-user, auth, RBAC.
- A second engine adapter (interface exists; only OpenCode is wired).
- Test-quality / maintainability / usability reviewers.
- Packaging as desktop app (Tauri/Electron).

## Running locally (target dev loop)

```sh
# terminal 1 — backend
cd prototype/backend && bun run dev

# terminal 2 — frontend
cd prototype/frontend && bun --bun ng serve

# terminal 3 — opencode (if running in server mode rather than spawned per session)
opencode serve  # exact command pinned in Phase 0 notes
```

Frontend dev server proxies `/api/*` and `/ws/*` to the backend. SQLite at `prototype/backend/data/orchestrator.sqlite`.
