import { Hono } from "hono";
import { stream } from "hono/streaming";
import { z } from "zod";
import {
  createTask,
  clearNeedsFeedback,
  deleteTask,
  getTask,
  incrementUserSendbacks,
  listTasks,
  markAbandoned,
  setNeedsFeedback,
  setTaskDifficulty,
  setTaskProgress,
  setUserRating,
  TaskStatus,
  updateTaskSpec,
  updateTaskStatus,
  type TaskWorkspace,
} from "../db/tasks";
import { ActivityActor, ActivityKind, recordActivity } from "../db/activities";
import { listSpecRevisions } from "../db/specRevisions";
import { listScoring, upsertScoring } from "../db/scorings";
import { listReviewsForTask } from "../db/reviews";
import { listForTask as listAlternativesForTask, replaceForTask as replaceAlternatives } from "../db/alternatives";
import { listPhaseOutputs } from "../db/phaseOutputs";
import { getEngine } from "../engine/singleton";
import { spawnSync } from "node:child_process";
import { addListener, forceComplete, sendUserMessage, startRun, cancelRun } from "../orchestrator";
import { snapshot as queueSnapshot, purge as queuePurge } from "../queue";
import { finalizeTask } from "../orchestrator/finalize";
import { scoreTask } from "../orchestrator/scoring";
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

const difficultySchema = z.object({
  difficulty: z.number().int().min(1).max(10),
  justification: z.string().max(280).optional(),
});

const needsFeedbackSchema = z.object({
  question: z.string().min(1).max(1000),
});

const specSchema = z.object({
  spec: z.string().min(1).max(50_000),
});

const ratingSchema = z.object({
  /** null clears the rating; 'bad' marks a bad experience. */
  rating: z.enum(["bad"]).nullable(),
  comment: z.string().max(2000).nullable().optional(),
});

const scoringSchema = z.object({
  /** Map of dimension slug → integer 1–10. Partial updates allowed —
   *  any dimensions omitted keep their previous values. */
  scores: z.record(z.string().min(1).max(60), z.number().int().min(1).max(10)),
  /** Optional per-dimension prose, same keys as scores. */
  rationale: z.record(z.string().min(1).max(60), z.string().max(2000).nullable()).optional(),
  /** Producer slug (agent slug or 'user'). */
  set_by: z.string().min(1).max(80),
});

const alternativeItemSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().min(1).max(4000),
  scores: z.record(z.string().min(1).max(60), z.number().int().min(1).max(10)),
  rationales: z.record(z.string().min(1).max(60), z.string().max(2000).nullable()).optional(),
  verdict: z.enum(["better", "equal", "worse"]),
  rationale: z.string().max(2000).nullable().optional(),
  /** Optional Mermaid flowchart source describing the alternative
   *  shape. Null / absent when the alternative is too small to
   *  warrant a diagram. */
  diagram_mermaid: z.string().max(8000).nullable().optional(),
});

const alternativesSchema = z.object({
  /** Empty array is allowed and means "I considered, none worth listing".
   *  This still wipes prior alternatives for the task. */
  alternatives: z.array(alternativeItemSchema).max(8),
  set_by: z.string().min(1).max(80),
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
  // Fire-and-forget difficulty score. The user shouldn't wait on the LLM
  // for a snappy "task created" — score arrives a few seconds later and
  // the UI picks it up on the next 5s task-list poll.
  scoreTask(t.id).catch((err) =>
    log.warn("api.tasks.score_failed", { id: t.id, error: String(err) }),
  );
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
  // Purge from the in-memory queue (slot or pending) before cleanup.
  queuePurge(id);
  // Clean up the per-task worktree + branch if any. Best-effort; failures
  // are logged but don't block the row deletion. --force is used so any
  // uncommitted edits are discarded — the user chose to delete the task,
  // if they wanted the work they would have run Finalize first.
  let worktreeCleaned = false;
  if (t.worktree_path) {
    try {
      const { findRepoRoot, removeWorktree } = await import("../orchestrator/worktree");
      const { spawnSync } = await import("node:child_process");
      const parentRoot = findRepoRoot(import.meta.dir);
      if (parentRoot) {
        removeWorktree({ parentRoot, worktreePath: t.worktree_path, force: true });
        if (t.worktree_branch) {
          spawnSync("git", ["branch", "-D", t.worktree_branch], {
            cwd: parentRoot,
            encoding: "utf8",
          });
        }
        worktreeCleaned = true;
      }
    } catch (e) {
      log.warn("api.tasks.deleted.worktree_cleanup_failed", { id, error: String(e) });
    }
  }
  const ok = deleteTask(id);
  log.info("api.tasks.deleted", { id, ok, worktreeCleaned });
  return c.json({ ok, worktreeCleaned });
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
  // User-initiated send-back — count it. Distinct from review_cycles
  // (which the reviewer agent bumps when it sends back automatically).
  incrementUserSendbacks(id);
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

/**
 * Manual difficulty override. Marks the task as user-overridden so the
 * scoring agent can't clobber it on a re-run.
 */
tasks.post("/:id/difficulty", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = difficultySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_difficulty", issues: parsed.error.issues }, 400);
  }
  const t = setTaskDifficulty(
    id,
    parsed.data.difficulty,
    parsed.data.justification ?? "Set manually by user.",
    true,
  );
  log.info("api.tasks.difficulty_overridden", { id, difficulty: parsed.data.difficulty });
  return c.json(t);
});

/** Re-run scoring. Useful when scoring failed at creation (engine down)
 *  or when the user has edited calibration and wants a fresh score. */
tasks.post("/:id/rescore", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  log.info("api.tasks.rescore_requested", { id });
  // Fire-and-forget so the request returns fast.
  scoreTask(id).catch((err) =>
    log.warn("api.tasks.rescore_failed", { id, error: String(err) }),
  );
  return c.json({ ok: true });
});

/** User dismissed the feedback request without giving feedback. */
tasks.post("/:id/clear-feedback", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json(clearNeedsFeedback(id));
});

/**
 * Replace the task's spec markdown. Writes a new spec_revisions row so
 * the history is preserved. The agent does not auto-pick up the new
 * spec — the user can rerun via Send Back if they want it applied.
 *
 * Per docs/10: hard-blocking edits in any state would conflict with
 * "no friction"; the user owns the spec and can edit any time.
 */
tasks.put("/:id/spec", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = specSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_spec", issues: parsed.error.issues }, 400);
  }
  const t = updateTaskSpec(id, parsed.data.spec);
  log.info("api.tasks.spec_updated", { id, len: parsed.data.spec.length });
  return c.json(t);
});

/** Newest-first list of past spec revisions for this task. */
tasks.get("/:id/revisions", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ revisions: listSpecRevisions(id) });
});

/**
 * Read the planner's execution-context file for this task. Lives at
 * `<worktree>/.agent-notes/<task_id>.md`. Returns 404 when the planner
 * hasn't run yet or the file isn't where we expect; the frontend
 * treats absence as "no notes".
 */
tasks.get("/:id/notes", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (!t.worktree_path) return c.json({ exists: false, content: null });
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const path = join(t.worktree_path, ".agent-notes", `${id}.md`);
  if (!existsSync(path)) return c.json({ exists: false, content: null });
  try {
    const content = readFileSync(path, "utf8");
    return c.json({ exists: true, content, path });
  } catch (err) {
    log.warn("api.tasks.notes.read_failed", { id, error: String(err) });
    return c.json({ exists: false, content: null, error: String(err) }, 200);
  }
});

/**
 * Read alternative-solution suggestions the reviewer posted for this
 * task. Empty list when the reviewer hasn't run, considered no
 * alternatives, or judged none worth listing.
 */
tasks.get("/:id/alternatives", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ alternatives: listAlternativesForTask(id) });
});

/**
 * Replace the alternative-solution list for this task. The reviewer
 * agent posts a fresh batch on every pass; this endpoint wipes prior
 * rows and inserts the new set in one tx, so the user sees only the
 * latest reviewer's view.
 *
 * Every agent sees the protocol in the shared system prompt; only the
 * reviewer's prompt instructs them to actually call it.
 */
tasks.post("/:id/alternatives", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = alternativesSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_alternatives", issues: parsed.error.issues }, 400);
  }
  const rows = replaceAlternatives(id, parsed.data);
  log.info("api.tasks.alternatives", {
    id,
    set_by: parsed.data.set_by,
    count: parsed.data.alternatives.length,
  });
  return c.json({ alternatives: rows });
});

/**
 * All per-phase outputs the pipeline runner has captured for this
 * task. Drives the intake-diagram extraction in the Review tab and
 * any future per-phase artifact viewer.
 */
tasks.get("/:id/phase-outputs", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ phase_outputs: listPhaseOutputs(id) });
});

/**
 * History of reviewer-agent verdicts for this task. Newest cycle first.
 * Empty array when the reviewer hasn't run yet (or the task predates
 * the persistence wiring).
 */
tasks.get("/:id/reviews", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ reviews: listReviewsForTask(id) });
});

/**
 * Read this task's scoring map (radar-chart axes). Returns an array of
 * {dimension, score, rationale, set_by, updated_at} rows. Empty array when
 * no agent has scored yet.
 */
tasks.get("/:id/scoring", (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  return c.json({ scoring: listScoring(id) });
});

/**
 * Agent (or user) writes scoring axes for this task. Partial updates are
 * fine — only the dimensions in `scores` are touched. Each call records a
 * new updated_at; the frontend renders the latest scoring.
 *
 * Every agent's system prompt explains this endpoint. Only the reviewer
 * agent is currently instructed to actually call it.
 */
tasks.post("/:id/scoring", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = scoringSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_scoring", issues: parsed.error.issues }, 400);
  }
  const rows = upsertScoring(id, parsed.data);
  log.info("api.tasks.scoring", {
    id,
    set_by: parsed.data.set_by,
    dimensions: Object.keys(parsed.data.scores),
  });
  return c.json({ scoring: rows });
});

/**
 * Set or clear the user's post-hoc rating for this task.
 *   { rating: "bad", comment: "…" }  → flag as a bad experience
 *   { rating: null }                 → clear any previous rating
 */
tasks.post("/:id/rating", async (c) => {
  const id = c.req.param("id");
  if (!getTask(id)) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = ratingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_rating", issues: parsed.error.issues }, 400);
  }
  const t = setUserRating(id, parsed.data.rating, parsed.data.comment ?? null);
  log.info("api.tasks.rating_set", { id, rating: parsed.data.rating });
  return c.json(t);
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

/**
 * Approve a paused gate. Clears tasks.awaiting_gate_id and re-starts
 * the run, which causes the pipeline runner to resume at the phase
 * after the gate. Used by the "approve direction" button in the UI.
 */
tasks.post("/:id/gate/approve", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  if (!t.awaiting_gate_id) {
    return c.json({ error: "not_at_gate", message: "Task is not paused at a gate." }, 400);
  }
  log.info("api.tasks.gate_approved", { id, gate: t.awaiting_gate_id });
  try {
    const r = await startRun(id);
    if (!r) {
      return c.json({ task_id: id, queued: true });
    }
    return c.json({ task_id: id, session_id: r.sessionId });
  } catch (err) {
    log.error("api.tasks.gate_approve_failed", { id, error: String(err) });
    return c.json({ error: "resume_failed", message: String(err) }, 500);
  }
});

/**
 * Finish a task — manual mark-as-done. Cancels any active run, moves
 * the task to current_state='finalize' / status='done', and records a
 * `finalize` activity event. Distinct from POST /:id/finalize (which
 * runs git operations) — this is the "I dealt with it manually, just
 * move it forward" button.
 */
tasks.post("/:id/finish", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  try {
    await cancelRun(id);
  } catch {
    /* already idle */
  }
  const updated = updateTaskStatus(id, TaskStatus.Done, "finalize");
  recordActivity(ActivityKind.Finalize, ActivityActor.User, id, "manual finish");
  log.info("api.tasks.finished", { id });
  return c.json(updated);
});

/**
 * Abandon a task — user gives up but wants to keep the record.
 *   - Cancels any in-flight engine run
 *   - Stamps tasks.abandoned_at with the current ts
 *   - Records an `abandon` activity event so the home overview's
 *     squares panel shows it as a red marker
 *
 * Distinct from DELETE: the row stays. Distinct from cancel: cancel is
 * a transient state inside the orchestrator's lifecycle; abandon is a
 * user verdict that survives reboots and gets surfaced in the metrics.
 */
tasks.post("/:id/abandon", async (c) => {
  const id = c.req.param("id");
  const t = getTask(id);
  if (!t) return c.json({ error: "not_found" }, 404);
  // Cancel any active run first; ignore errors — the run may already
  // be finished or never started.
  try {
    await cancelRun(id);
  } catch {
    /* not active is fine */
  }
  const updated = markAbandoned(id);
  recordActivity(ActivityKind.Abandon, ActivityActor.User, id, t.title);
  log.info("api.tasks.abandoned", { id });
  return c.json(updated);
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
