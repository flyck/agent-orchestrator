# Prototype — Direction C (OpenCode engine + Bun/Angular shell)

Local-first multi-agent review dashboard. See `../docs/` for the full design.

## Layout

```
prototype/
├── backend/      Bun + Hono + bun:sqlite + job queue + engine adapter
├── frontend/     Angular workbench
└── README.md     this file
```

## Status

Not yet scaffolded. Build order is in `../docs/05-implementation-plan.md`.

## Running locally (target dev loop)

Once scaffolded:

```sh
# terminal 1
cd backend && bun run dev

# terminal 2
cd frontend && bun --bun ng serve
```

Backend default port: `3000`. Frontend default port: `4200` with a dev proxy to `/api/*` → backend.

SQLite database file: `backend/data/orchestrator.sqlite`.

## Prerequisites

- Bun (https://bun.sh)
- Node + Angular CLI (for frontend tooling) — installed via `bunx @angular/cli`
- OpenCode on PATH — pinned version recorded in `backend/README.md` after the Phase 0 spike
