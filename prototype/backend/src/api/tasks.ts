import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import {
  createTask,
  deleteTask,
  getTask,
  listTasks,
  type TaskWorkspace,
  type TaskStatus,
} from "../db/tasks";
import { addListener, sendUserMessage, startRun, cancelRun } from "../orchestrator";
import { finalizeTask } from "../orchestrator/finalize";
import { log } from "../log";

const createSchema = z.object({
  workspace: z.enum(["review", "feature", "bugfix", "arch_compare", "background", "internal"]),
  queue: z.enum(["foreground", "background"]).optional(),
  title: z.string().min(1).max(500),
  input_kind: z.enum(["diff", "path", "prompt", "spec"]),
  input_payload: z.string().min(1).max(50_000),
  repo_path: z.string().nullable().optional(),
});

const messageSchema = z.object({
  text: z.string().min(1).max(20_000),
});

const finalizeSchema = z.object({
  strategy: z.enum(["current", "new"]),
  branch: z.string().min(1).max(80).optional(),
  message: z.string().min(1).max(2000).optional(),
});

export const tasks = new Hono();

tasks.get("/", (c) => {
  const workspace = c.req.query("workspace") as TaskWorkspace | undefined;
  const status = c.req.query("status") as TaskStatus | undefined;
  return c.json({ tasks: listTasks({ workspace, status }) });
});

tasks.get("/:id", (c) => {
  const t = getTask(c.req.param("id"));
  if (!t) return c.json({ error: "not_found" }, 404);
  return c.json(t);
});

tasks.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_task", issues: parsed.error.issues }, 400);
  }
  const t = createTask(parsed.data);
  log.info("api.tasks.created", { id: t.id, workspace: t.workspace, title: t.title });
  return c.json(t, 201);
});

tasks.post("/:id/run", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  log.info("api.tasks.run", { id });
  try {
    const r = await startRun(id);
    return c.json({ task_id: id, session_id: r.sessionId, events_url: `/api/tasks/${id}/events` });
  } catch (err) {
    log.error("api.tasks.run.failed", {
      id,
      error: err instanceof Error ? err.message : String(err),
    });
    return c.json({ error: "run_failed", message: String(err) }, 500);
  }
});

tasks.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  // If active, abort first so the engine session releases cleanly.
  try {
    await cancelRun(id);
  } catch {
    /* not active is fine */
  }
  const ok = deleteTask(id);
  log.info("api.tasks.deleted", { id, ok });
  return c.json({ ok });
});

tasks.post("/:id/cancel", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  await cancelRun(id);
  return c.json({ ok: true });
});

tasks.post("/:id/finalize", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = finalizeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_finalize", issues: parsed.error.issues }, 400);
  }
  if (parsed.data.strategy === "new" && !parsed.data.branch) {
    return c.json({ error: "missing_branch", message: "strategy='new' requires `branch`" }, 400);
  }
  try {
    const result = await finalizeTask(id, parsed.data);
    return c.json(result);
  } catch (err) {
    log.error("api.tasks.finalize.failed", { id, error: String(err) });
    return c.json({ error: "finalize_failed", message: String(err) }, 500);
  }
});

tasks.post("/:id/messages", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = messageSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_message", issues: parsed.error.issues }, 400);
  }
  try {
    await sendUserMessage(id, parsed.data.text);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: "send_failed", message: String(err) }, 400);
  }
});

/**
 * SSE event stream for an active task. Subscribes to the orchestrator's
 * per-task listener bus. Closes when the task terminates (the bus stops
 * pushing).
 */
tasks.get("/:id/events", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);

  return stream(c, async (s) => {
    s.onAbort(() => {
      log.info("api.tasks.events.client_aborted", { id });
    });

    let unsub: (() => void) | null = null;
    try {
      unsub = addListener(id, (ev) => {
        const payload = `data: ${JSON.stringify({
          type: ev.type,
          ts: ev.ts,
          sessionId: ev.sessionId,
          raw: ev.raw,
        })}\n\n`;
        s.write(payload).catch(() => {
          /* client gone */
        });
      });
      log.info("api.tasks.events.subscribed", { id });
      // Tell the client we're up.
      await s.write(`data: ${JSON.stringify({ type: "subscribed", task_id: id })}\n\n`);
      // Keep the stream open until the run terminates.
      // Heartbeat every 15s so intermediaries don't kill the connection.
      while (!s.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 15_000));
        if (s.aborted) break;
        await s.write(`: heartbeat\n\n`).catch(() => {});
      }
    } catch (err) {
      log.error("api.tasks.events.error", { id, error: String(err) });
    } finally {
      unsub?.();
      log.info("api.tasks.events.unsubscribed", { id });
    }
  });
});
