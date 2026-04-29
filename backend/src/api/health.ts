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

/**
 * Engine (opencode) health — separate from backend health so the topbar
 * can show "engine cold" without falsely reporting the backend down.
 *
 * Three states:
 *   - cold:    no engine has been started yet (lazy init on first task)
 *   - ok:      engine started and a /global/health probe succeeded
 *   - stalled: engine started but the probe failed
 */
health.get("/engine", async (c) => {
  // Lazy import: avoids paying engine module load cost on backend boot,
  // and lets this endpoint stay reachable even if the engine module
  // throws during construction (it shouldn't, but be defensive).
  const { peekEngine } = await import("../engine/singleton");
  const engine = peekEngine();
  if (!engine) {
    return c.json({ state: "cold", checked_at: Date.now() });
  }
  const ok = await engine.health().catch(() => false);
  return c.json({ state: ok ? "ok" : "stalled", checked_at: Date.now() });
});

const STARTED_AT = Date.now();
