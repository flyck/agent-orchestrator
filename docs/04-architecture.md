# Architecture

Direction C: **OpenCode** as the engine, Bun backend, Angular frontend, SQLite (`bun:sqlite`) for persistence, in-process job queue with configurable concurrency. Each agent role runs as a long-lived **OpenCode session** the user can read from and write into via the browser.

## High-level diagram

```
┌──────────────────────────────────────────────────────────────────┐
│  Angular frontend (browser) — paper design system                 │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌─────────────┐ ┌──────────┐   │
│  │ Review │ │Feature │ │ Bugfix │ │ Arch.Compare│ │ Settings │   │
│  └────────┘ └────────┘ └────────┘ └─────────────┘ └──────────┘   │
│        │                  ▲ live stream + send-message            │
└────────┼──────────────────┼───────────────────────────────────────┘
         │ REST + WebSocket │
┌────────▼──────────────────┴───────────────────────────────────────┐
│  Bun backend (Hono)                                                │
│                                                                    │
│   API ─► Orchestrator ─► Job Queue (concurrency-bound)             │
│                │                  │                                │
│                ▼                  ▼                                │
│        ┌────────────────┐  ┌────────────────────┐                  │
│        │ EngineAdapter  │◄─┤ Per-task agent     │                  │
│        │ (OpenCode)     │  │ scheduler          │                  │
│        └───────┬────────┘  └────────────────────┘                  │
│                │                                                   │
│                ▼ one session per agent role                        │
│        ┌────────────────┐                                          │
│        │ Session pool   │  send(msg) / events / cancel / close     │
│        └───────┬────────┘                                          │
│                │                                                   │
│   ┌────────────▼─────────────┐                                     │
│   │  SQLite (bun:sqlite)     │  tasks, agent_runs, sessions,       │
│   │                          │  messages, agents, settings,        │
│   │                          │  cost_events                        │
│   └──────────────────────────┘                                     │
└────────────────────────────────────────────────────────────────────┘
                               │
                               ▼ persistent process / API client
                       ┌────────────────┐
                       │  OpenCode      │
                       │  sessions      │
                       └────────────────┘
```

## Engine integration model (the important change)

**Each agent role = one long-lived OpenCode session.** Not a subprocess invocation per turn.

The `EngineAdapter` interface:

```ts
// engine/types.ts
export interface EngineSession {
  id: string;
  send(message: string, opts?: { fromUser?: boolean }): Promise<void>;
  events: AsyncIterable<EngineEvent>;   // text deltas, tool calls, usage, done
  cancel(): Promise<void>;              // stop current turn
  close(): Promise<void>;               // end session, free resources
}

export interface EngineAdapter {
  openSession(spec: {
    systemPromptMd: string;             // the agent's editable markdown
    cwd: string;                        // target repo path
    model?: string;
    tools?: string[];                   // restrict tools per role
  }): Promise<EngineSession>;
}
```

The `OpenCodeAdapter` uses **HTTP server mode** — verified available on the user's machine (anomalyco/opencode 1.1.6). Backend boots `opencode serve` once, then drives the HTTP API. Full surface is documented in [`09-opencode-integration-notes.md`](09-opencode-integration-notes.md). PTY wrapping was the considered fallback; it isn't needed.

Per-session, the adapter:
- `POST /session` to create.
- `POST /session/:id/prompt_async` with the agent's `system` prompt (sourced from our `agents.system_prompt_md`) and the input as `parts`.
- Subscribes to a single shared `GET /event` SSE stream and demultiplexes by `sessionID`.
- `POST /session/:id/abort` for cancel; `DELETE /session/:id` on close.

## "Jump in and comment" — bidirectional flow

WebSocket per task. Client subscribes to `/api/tasks/:id/ws` and receives:

- `agent.event` — text deltas, tool calls, usage from any agent in the task
- `agent.status` — started / waiting-for-input / done / errored
- `task.synthesis` — synthesizer output

Client sends back:

- `user.message { agent_run_id, text }` — injected into a specific agent's session
- `user.message { task_id, text, broadcast: true }` — sent to all running agents (e.g. "all reviewers: focus on the auth changes specifically")
- `agent.cancel { agent_run_id }`
- `agent.fork { agent_run_id }` — clone state and start a side conversation (v2)

All user messages are persisted to `messages` so you can replay later who said what when.

## Backend modules (`prototype/backend/src/`)

| Module | Responsibility |
|---|---|
| `api/` | Hono routes for tasks, agents, settings + WebSocket upgrade |
| `orchestrator/` | Task lifecycle, per-workspace agent composition |
| `queue/` | Concurrency-bounded job queue |
| `engine/` | `EngineAdapter` interface + `OpenCodeAdapter` |
| `sessions/` | Session pool, lifetime management, reconnect |
| `db/` | `bun:sqlite` schema, migrations, repositories |
| `streams/` | WebSocket hub — fan-out events, route inbound user messages |
| `cost/` | Token & USD accounting |
| `agents/` | CRUD for editable agent definitions |
| `settings/` | User-configurable knobs |

## Agent definitions: hybrid file + DB

System prompts and instructions live as **markdown files on disk**; the SQLite `agents` table is the **index**. The Settings UI reads/writes the file; the DB row tracks metadata for fast queries and stores the cached hash so we know when a file changed under us.

Why hybrid:
- File is the source of truth — `git diff` works, version control is natural, the user can edit in their IDE if they want.
- DB enables fast listing, sorting, status, joins to runs.
- Built-ins ship as files in the repo; user customs go in a separate dir that can be moved/versioned independently.

Layout:

```
prototype/backend/agents/
  builtin/                  # ships with the app
    review/
      planner.md            # frontmatter + system prompt
      reviewer-security.md
      reviewer-performance.md
      reviewer-architecture.md
      synthesizer.md
    background/
      dead-code-detector.md
      todo-aging.md
      dependency-hygiene.md
      doc-drift.md
  custom/                   # user-created
    ...
```

Schema:

```sql
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  icon TEXT NOT NULL,
  role TEXT NOT NULL,                    -- planner | reviewer | implementer | synthesizer | background | custom
  concurrency_class TEXT NOT NULL,       -- 'foreground' | 'background' — routes to the right queue
  file_path TEXT NOT NULL,               -- absolute path to the agent's .md file
  prompt_hash TEXT NOT NULL,             -- sha256 of the file contents at last sync
  model_provider_id TEXT,                -- nullable; falls back to default
  model_id TEXT,
  cadence_json TEXT,                     -- background only; { base, churn_signal? }
  limits_json TEXT,                      -- e.g. { max_findings_per_run, max_session_tokens }
  enabled INTEGER NOT NULL DEFAULT 0,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

On startup the backend walks `agents/builtin/` and `agents/custom/`, computes hashes, upserts. UI edits write the file then refresh the row. Out-of-band file edits are picked up on next start (and via a "rescan" button in Settings).

Full file format and the background-agent extensions in [`11-background-agents.md`](11-background-agents.md).

## Two job queues

The orchestrator runs **two independent queues** so background work never starves the user's focused work:

**Foreground queue** — Review, Feature, Bugfix, Architecture Compare:
- `max_parallel_tasks` — top-level concurrent tasks (default `2`).
- `max_agents_per_task` — concurrent agents within one task (default `3`).
- `daily_token_budget_usd` — soft gate; UI warns at 80%, blocks at 100%.

**Background queue** — agent-initiated runs from the Background workspace:
- `max_parallel_background_agents` — default `1`, range `1–4`.
- `max_background_runs_per_day` — soft cap (warns).
- `background_token_budget_usd_per_day` — separate from the foreground budget.

Each queue is an async semaphore reading settings on each admit. Sessions outlive a single "turn" — the queue accounts for open sessions, not just active turns. When the foreground queue is saturated, background work pauses (no slot stealing).

Background scheduling: a 1-minute tick scans enabled background agents whose cadence is due, admits eligible runs through the background queue. Cadence policy and the optional git-churn signal are documented in [`11-background-agents.md`](11-background-agents.md).

## Data model (SQLite)

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workspace TEXT NOT NULL,             -- review | feature | bugfix | arch_compare | background
  queue TEXT NOT NULL,                 -- foreground | background
  title TEXT NOT NULL,
  input_kind TEXT NOT NULL,            -- diff | path | prompt | spec
  input_payload TEXT NOT NULL,         -- spec markdown for feature/bugfix
  repo_path TEXT,                      -- parent git repo (required for feature/bugfix)
  worktree_path TEXT,                  -- created at Implement gate
  worktree_branch TEXT,                -- e.g. agent/feature-7f3a
  worktree_base_ref TEXT,              -- HEAD ref the worktree branched from
  status TEXT NOT NULL,                -- queued | spec | plan_pending | implementing | reviewing | synthesizing | done | failed | canceled | findings_pending
  current_gate TEXT,                   -- spec | plan | implement | review | accept (feature/bugfix)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE spec_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  version INTEGER NOT NULL,
  spec_md TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, version)
);

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),   -- nullable: background findings exist outside a task
  agent_id TEXT NOT NULL REFERENCES agents(id),
  severity TEXT NOT NULL,              -- info | low | medium | high
  location TEXT,                       -- file:lines or null
  title TEXT NOT NULL,
  detail_md TEXT NOT NULL,
  evidence_md TEXT,
  status TEXT NOT NULL,                -- open | dismissed | snoozed | accepted | converted_to_task
  snoozed_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  agent_prompt_snapshot TEXT NOT NULL, -- the system_prompt_md at run time
  status TEXT NOT NULL,                -- pending | running | waiting_for_user | done | canceled
  started_at INTEGER,
  finished_at INTEGER,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd_micros INTEGER DEFAULT 0,
  output_md TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id),
  engine TEXT NOT NULL,                -- 'opencode'
  external_session_id TEXT,            -- OpenCode's own id if applicable
  status TEXT NOT NULL,                -- open | closed | crashed
  opened_at INTEGER NOT NULL,
  closed_at INTEGER
);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  direction TEXT NOT NULL,             -- inbound (to agent) | outbound (from agent)
  sender TEXT NOT NULL,                -- user | agent | system | orchestrator
  content_md TEXT NOT NULL
);

-- raw engine events for replay/debug
CREATE TABLE engine_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- agents table — see "Editable agent definitions" above
```

## API surface (v1)

```
GET    /api/health
GET    /api/settings
PUT    /api/settings

GET    /api/agents                          → list
GET    /api/agents/:id
POST   /api/agents                          ← create custom
PUT    /api/agents/:id                      ← edit prompt / enable / disable
POST   /api/agents/:id/reset                ← only for builtin
DELETE /api/agents/:id                      ← only for custom

POST   /api/tasks
GET    /api/tasks                           → list
GET    /api/tasks/:id                       → task + runs + sessions + cost
POST   /api/tasks/:id/cancel
WS     /api/tasks/:id/ws                    ← bidirectional: events out, user messages in

GET    /api/cost/summary?range=today|7d
```

## Frontend shape (Angular)

- Top tab bar: Review | Feature | Bugfix | Arch Compare | Settings | Cost.
- Each workspace tab subscribes to its active task via WebSocket.
- Per-agent panes have an **input strip at the bottom** so you can type a comment directly into that agent's session. Enter sends; Cmd+Enter sends as a broadcast to all reviewers in this task.
- A `SessionService` (RxJS) wraps the WebSocket; per-agent observables fan out from the single connection.
- Settings page sections: **General** (concurrency, budgets, nudge cadence), **Agents** (editable cards), **Engine** (OpenCode model + provider config), **Appearance** (display density only — colors are fixed by the design system).

## Design system reference

Visual language is documented in [`08-design-system.md`](08-design-system.md). Summary: muted near-monochrome palette, serif headings, paper background, hairline rules, Lucide stroke icons, no shadows, no gradients. The content is the chrome.
