/**
 * Endpoints scoped to internal agents (the orchestrator-debugger and
 * future self-monitoring agents). Kept under /api/internal/* so the
 * surface is easy to firewall or rate-limit later.
 *
 * v1: read-only access to log files. Future: read-only access to
 * recent task failures, error rates per agent role, etc.
 */

import { Hono } from "hono";
import { listLogFiles, readLogTail } from "../log";

export const internal = new Hono();

internal.get("/logs/files", (c) => {
  return c.json({ files: listLogFiles() });
});

/**
 * GET /api/internal/logs?date=YYYY-MM-DD&limit=500&since=<unix-ms>
 * Defaults: today, 500 lines, no since filter.
 */
internal.get("/logs", (c) => {
  const date = c.req.query("date") ?? undefined;
  const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;
  const since = c.req.query("since") ? Number(c.req.query("since")) : undefined;
  const entries = readLogTail({ date, limit, sinceMs: since });
  return c.json({ entries });
});
