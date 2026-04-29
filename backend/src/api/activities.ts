/**
 * Activity timeline endpoint. Powers the home page activity squares +
 * agent/manual ratio pie. Read-only — events are recorded by the
 * relevant operations (task creation, finalize, run start, etc.).
 */

import { Hono } from "hono";
import { listActivities } from "../db/activities";

export const activities = new Hono();

activities.get("/", (c) => {
  const limitRaw = c.req.query("limit");
  const limit = Math.max(1, Math.min(500, Number(limitRaw) || 100));
  return c.json({ activities: listActivities(limit) });
});
