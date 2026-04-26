import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import {
  createTask,
  clearNeedsFeedback,
  deleteTask,
  getTask,
  listTasks,
  setNeedsFeedback,
  setTaskProgress,
  type TaskWorkspace,
  type TaskStatus,
} from "../db/tasks";
import { getEngine } from "../engine/singleton";
import { spawnSync } from "node:child_process";
import { addListener, forceComplete, sendUserMessage, startRun, cancelRun } from "../orchestrator";
import { snapshot as queueSnapshot, purge as queuePurge } from "../queue";
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

const progressSchema = z.object({
  step: z.number().int().min(0).max(1000).optional(),
  total: z.number().int().min(0).max(1000).optional(),
  label: z.string().max(500).nullable().optional(),
});

const continueSchema = z.object({
  message: z.string().min(1).max(20_000),
});

const needsFeedbackSchema = z.object({
  question: z.string().min(1).max(1000),
});

export const tasks = new Hono();

tasks.get("/", (c) => {
  const workspace = c.req.query("workspace") as TaskWorkspace | undefined;
  const status = c.req.query("status") as TaskStatus | undefined;
  return c.json({ tasks: listTasks({ workspace, status }) });
});

/** Live queue snapshot — drives a "running 2/3 · 1 queued" pipeline meter. */
tasks.get("/queue/snapshot", (c) => c.json(queueSnapshot()));

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
    if (!r) {
      // Queued — capacity full. Status is now "queued" in the DB; the
      // dispatcher will run it as soon as a slot frees.
      return c.json({ task_id: id, queued: true, events_url: `/api/tasks/${id}/events` });
    }
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
  // Always purge from the in-memory queue — even if the task wasn't
  // active in the orchestrator's pump, it may still be holding a queue
  // slot or a pending entry. Without this the slot leaks.
  queuePurge(id);
  const ok = deleteTask(id);
  log.info("api.tasks.deleted", { id, ok });
  return c.json({ ok });
});

/**
 * Agent self-reports progress here. Three optional fields — only what's
 * provided is updated. The agent is taught to call this in its system
 * prompt (see orchestrator.SYSTEM_PROMPT).
 */
tasks.post("/:id/progress", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = progressSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_progress", issues: parsed.error.issues }, 400);
  }
  const t = setTaskProgress(id, parsed.data);
  log.info("api.tasks.progress", {
    id,
    step: t?.current_step,
    total: t?.total_steps,
    label: t?.step_label,
  });
  return c.json(t);
});

/**
 * Bump a Ready task back to Build with new user feedback. Opens a fresh
 * orchestrator run that prepends the previous spec + the user's message.
 */
tasks.post("/:id/continue", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = continueSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_message", issues: parsed.error.issues }, 400);
  }
  log.info("api.tasks.continue", { id, len: parsed.data.message.length });
  try {
    const r = await startRun(id, { followUp: parsed.data.message });
    if (!r) {
      return c.json({ task_id: id, queued: true, events_url: `/api/tasks/${id}/events` });
    }
    return c.json({ task_id: id, session_id: r.sessionId, events_url: `/api/tasks/${id}/events` });
  } catch (err) {
    log.error("api.tasks.continue.failed", { id, error: String(err) });
    return c.json({ error: "continue_failed", message: String(err) }, 500);
  }
});

/** Agent signals it cannot proceed without user input. */
tasks.post("/:id/needs-feedback", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = needsFeedbackSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_question", issues: parsed.error.issues }, 400);
  }
  const t = setNeedsFeedback(id, parsed.data.question);
  log.info("api.tasks.needs_feedback", { id, question: parsed.data.question });
  return c.json(t);
});

/** User dismissed the feedback request without giving feedback. */
tasks.post("/:id/clear-feedback", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json(clearNeedsFeedback(id));
});

/**
 * Task-scoped diff. Runs git in the task's worktree if it has one; falls
 * back to the parent repo otherwise (for tasks created before worktrees
 * were wired). Diff is base-scoped: working tree vs the captured base SHA.
 */
tasks.get("/:id/diff", (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found" }, 404);

  const cwd = task.worktree_path;
  if (!cwd) {
    return c.json(
      {
        error: "no_worktree",
        message:
          "This task predates per-task worktrees. Send Back will create one on the next run.",
      },
      400,
    );
  }

  const base = task.worktree_base_ref ?? "HEAD";
  const run = (args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8" });

  // File list: status (uncommitted in worktree) ∪ what's been committed
  // since the base on the worktree branch.
  const statusRes = run(["status", "--porcelain"]);
  const map = new Map<string, { path: string; status: string; added: number; deleted: number }>();
  for (const line of statusRes.stdout.split("\n")) {
    if (!line) continue;
    const path = line.slice(3);
    map.set(path, { path, status: line.slice(0, 2), added: 0, deleted: 0 });
  }
  if (base !== "HEAD") {
    const since = run(["diff", `${base}..HEAD`, "--name-status"]);
    for (const line of since.stdout.split("\n")) {
      const m = line.match(/^([A-Z])\s+(.+)$/);
      if (!m) continue;
      const [, code, p] = m;
      if (!map.has(p!)) map.set(p!, { path: p!, status: `${code} `, added: 0, deleted: 0 });
    }
  }
  const numstat = run(["diff", base, "--numstat"]);
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    const [, addStr, delStr, p] = m;
    const e = map.get(p!) ?? { path: p!, status: "  ", added: 0, deleted: 0 };
    e.added = addStr === "-" ? 0 : Number(addStr);
    e.deleted = delStr === "-" ? 0 : Number(delStr);
    map.set(p!, e);
  }
  const files = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));

  const patchRes = run(["diff", base, "--no-color"]);
  const MAX = 400_000;
  let patch = patchRes.stdout;
  let truncated = false;
  if (patch.length > MAX) {
    patch = patch.slice(0, MAX) + "\n\n…[truncated — diff too large]";
    truncated = true;
  }

  return c.json({
    repo_root: cwd,
    base,
    base_resolved: true,
    branch: task.worktree_branch,
    files,
    patch,
    truncated,
    fetched_at: Date.now(),
  });
});

/**
 * Backfill: when the live SSE stream is dead but the user wants to see
 * what the agent said last, fetch the persisted transcript from opencode
 * for the last session attached to this task.
 */
tasks.get("/:id/transcript", async (c) => {
  const id = c.req.param("id");
  const task = getTask(id);
  if (!task) return c.json({ error: "not_found" }, 404);
  if (!task.last_session_id) {
    return c.json({ session_id: null, messages: [] });
  }
  try {
    const engine = await getEngine();
    const messages = await engine.getSessionMessages(task.last_session_id, 50);
    return c.json({ session_id: task.last_session_id, messages });
  } catch (err) {
    log.warn("api.tasks.transcript.failed", { id, error: String(err) });
    return c.json({ session_id: task.last_session_id, messages: [], error: String(err) }, 200);
  }
});

tasks.post("/:id/force-complete", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  log.info("api.tasks.force_complete", { id });
  await forceComplete(id);
  return c.json({ ok: true });
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
