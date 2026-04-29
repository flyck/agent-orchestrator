/**
 * Hono middleware: load the task referenced by a `:id` (or
 * `:taskId`) path param and stash it on `c.var.task`. 404s when the
 * row doesn't exist. Replaces the boilerplate
 *   `if (!getTask(id)) return c.json({error:"not_found"}, 404);`
 * that was repeated 23× across the per-task routes.
 *
 * Usage:
 *   const router = new Hono<{ Variables: TaskVar }>();
 *   router.use('/:id/*', requireTask);
 *   router.get('/:id/foo', (c) => c.json({ task: c.var.task }));
 */

import type { MiddlewareHandler } from "hono";
import { getTask, type TaskRow } from "../../db/tasks";

export type TaskVar = { task: TaskRow };

export const requireTask: MiddlewareHandler<{ Variables: TaskVar }> = async (c, next) => {
  // Accept both `:id` and `:taskId` so the middleware works under both
  // /api/tasks/:id/... routes (in api/tasks.ts) and the
  // /api/tasks/:taskId/suggestions style.
  const id = c.req.param("id") ?? c.req.param("taskId");
  if (!id) {
    return c.json({ error: "missing_id" }, 400);
  }
  const task = getTask(id);
  if (!task) {
    return c.json({ error: "not_found" }, 404);
  }
  c.set("task", task);
  await next();
};
