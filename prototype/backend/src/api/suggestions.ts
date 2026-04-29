/**
 * Suggested-next-steps API. Spec: docs/15-integrations-and-suggested-next.md.
 *
 * Mounted twice from index.ts:
 *   /api/tasks/:id/suggestions    — list + status mutations (per-task)
 *   /api/suggestions/pinned       — flat pinned feed for the dashboard
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  getSuggestion,
  listPinnedSuggestions,
  listSuggestionsForTask,
  setSuggestionStatus,
  SuggestionStatus,
} from "../db/suggestions";
import { generateGithubIssueSuggestions } from "../orchestrator/suggestions";
import { requireTask, type TaskVar } from "./middleware/requireTask";
import { log } from "../log";

/** Mount at /api/tasks (so the path becomes /api/tasks/:taskId/suggestions). */
export const suggestionsForTasks = new Hono<{ Variables: TaskVar }>();

suggestionsForTasks.use("/:taskId/suggestions/*", requireTask);
suggestionsForTasks.use("/:taskId/suggestions", requireTask);

suggestionsForTasks.get("/:taskId/suggestions", (c) => {
  return c.json({ suggestions: listSuggestionsForTask(c.var.task.id) });
});

const statusSchema = z.object({
  status: z.enum([SuggestionStatus.Pinned, SuggestionStatus.Dismissed]),
});

suggestionsForTasks.put("/:taskId/suggestions/:sid", async (c) => {
  const sid = c.req.param("sid");
  const existing = getSuggestion(sid);
  if (!existing || existing.task_id !== c.var.task.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ error: "bad_request", details: parsed.error.format() }, 400);
  const updated = setSuggestionStatus(sid, parsed.data.status);
  return c.json({ suggestion: updated });
});

/** Manual refresh — re-run the GitHub-issue source for this task and
 *  return the up-to-date list. The user clicks this from the
 *  suggestions panel when they've just closed an issue on GitHub and
 *  want the panel to reflect it without waiting for the next task
 *  completion. */
suggestionsForTasks.post("/:taskId/suggestions/refresh", async (c) => {
  const task = c.var.task;
  try {
    await generateGithubIssueSuggestions(task);
  } catch (err) {
    log.warn("api.suggestions.refresh_failed", { taskId: task.id, error: String(err) });
  }
  return c.json({ suggestions: listSuggestionsForTask(task.id) });
});

/** Mount at /api/suggestions for the dashboard feed. */
export const suggestionsRoot = new Hono();

suggestionsRoot.get("/pinned", (c) => {
  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") ?? 20)));
  return c.json({ suggestions: listPinnedSuggestions(limit) });
});
