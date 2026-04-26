import { Hono } from "hono";

export const health = new Hono();

health.get("/", (c) =>
  c.json({
    ok: true,
    name: "agent-orchestrator-backend",
    started_at: STARTED_AT,
    uptime_ms: Date.now() - STARTED_AT,
  }),
);

const STARTED_AT = Date.now();
