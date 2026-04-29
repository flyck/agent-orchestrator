# agent-orchestrator backend

Bun + Hono + `bun:sqlite`. Drives OpenCode sessions and serves the Angular frontend's REST/WebSocket needs.

> Read [`../../MANIFESTO.md`](../../MANIFESTO.md) and [`../../docs/`](../../docs/) before changing anything substantive.

## Run

```sh
bun install         # once
bun run dev         # hot-reload dev server, default port 3000
PORT=4000 bun run dev
```

## Layout

```
src/
├── api/         Hono routes (HTTP + WebSocket upgrade)
├── orchestrator/ task lifecycle, agent composition per workspace
├── queue/       concurrency-bounded job queue (foreground + background)
├── engine/      EngineAdapter interface + OpenCodeAdapter
├── sessions/    OpenCode session pool, lifetime management
├── streams/     WebSocket hub — fan-out events, route inbound user messages
├── db/          bun:sqlite schema, migrations, repositories
├── cost/        token + USD accounting
├── agents/      agent-definition file/DB sync
├── settings/    user-configurable knobs
└── index.ts     Bun.serve entry, mounts the Hono app
```

## Data

SQLite file: `./data/orchestrator.sqlite` (gitignored). Built-in agent prompts live in `agents/builtin/*.md` and seed the `agents` table on first startup.

## Phase 1 status

Skeleton + `/api/health`. SQLite, settings, agents, queue, engine adapter, sessions, streams: not yet wired. See [`../../docs/05-implementation-plan.md`](../../docs/05-implementation-plan.md).
