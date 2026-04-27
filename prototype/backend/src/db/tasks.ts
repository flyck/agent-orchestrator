import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";
import { appendSpecRevision } from "./specRevisions";

export type TaskWorkspace = "review" | "feature" | "bugfix" | "arch_compare" | "background" | "internal";
export type TaskQueue = "foreground" | "background";
export type TaskStatus =
  | "queued"
  | "running"
  | "synthesizing"
  | "done"
  | "failed"
  | "canceled"
  | "findings_pending";
/** Pipeline states.
 *
 * `code` and `review` split the old monolithic `build` state — the coder
 * agent runs in `code`, then a reviewer runs in `review`, then the user
 * accepts in `ready` / `finalize`. `build` is retained as a legacy alias
 * for tasks created before the split; the frontend renders it as `code`.
 */
export type TaskState =
  | "spec"
  | "plan"
  | "code"
  | "review"
  | "build"
  | "ready"
  | "finalize";

export interface TaskRow {
  id: string;
  workspace: TaskWorkspace;
  queue: TaskQueue;
  title: string;
  input_kind: "diff" | "path" | "prompt" | "spec";
  input_payload: string;
  repo_path: string | null;
  worktree_path: string | null;
  worktree_branch: string | null;
  worktree_base_ref: string | null;
  status: TaskStatus;
  current_state: TaskState | null;
  current_step: number | null;
  total_steps: number | null;
  step_label: string | null;
  needs_feedback: number; // sqlite stores 0/1
  feedback_question: string | null;
  last_session_id: string | null;
  state_entered_at: number | null;
  difficulty: number | null;
  difficulty_justification: string | null;
  difficulty_overridden_by_user: number; // sqlite 0/1
  created_at: number;
  updated_at: number;
}

export interface CreateTaskInput {
  workspace: TaskWorkspace;
  queue?: TaskQueue;
  title: string;
  input_kind: TaskRow["input_kind"];
  input_payload: string;
  repo_path?: string | null;
  initial_state?: TaskState | null;
}

export function createTask(input: CreateTaskInput, handle: Database = db()): TaskRow {
  const id = `tsk_${nanoid(16)}`;
  const now = Date.now();
  // Insert + initial spec revision in one transaction so the row never
  // exists without a matching revision (the spec tab assumes at least
  // version 1 is present once a task is visible).
  const tx = handle.transaction(() => {
    handle
      .prepare(
        `INSERT INTO tasks (id, workspace, queue, title, input_kind, input_payload,
                            repo_path, worktree_path, worktree_branch, worktree_base_ref,
                            status, current_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.workspace,
        input.queue ?? "foreground",
        input.title,
        input.input_kind,
        input.input_payload,
        input.repo_path ?? null,
        "queued",
        input.initial_state ?? "spec",
        now,
        now,
      );
    // Only spec-kind inputs warrant revision history. Diff/path/prompt
    // tasks (Review tab inputs etc.) don't carry user-edited prose.
    if (input.input_kind === "spec") {
      appendSpecRevision(id, input.input_payload, handle);
    }
  });
  tx();
  return getTask(id, handle)!;
}

/**
 * Replace the task's spec markdown and append a new revision row. Returns
 * the updated task. The agent does NOT auto-pick up the new spec — the
 * user can click "Send Back" to rerun with the latest spec as feedback.
 */
export function updateTaskSpec(
  id: string,
  specMd: string,
  handle: Database = db(),
): TaskRow | null {
  const tx = handle.transaction(() => {
    handle
      .prepare("UPDATE tasks SET input_payload = ?, updated_at = ? WHERE id = ?")
      .run(specMd, Date.now(), id);
    appendSpecRevision(id, specMd, handle);
  });
  tx();
  return getTask(id, handle);
}

export function getTask(id: string, handle: Database = db()): TaskRow | null {
  return handle.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
}

export function listTasks(
  opts: { workspace?: TaskWorkspace; status?: TaskStatus; limit?: number } = {},
  handle: Database = db(),
): TaskRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.workspace) {
    where.push("workspace = ?");
    params.push(opts.workspace);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = opts.limit ?? 200;
  params.push(limit);
  return handle
    .query<TaskRow, never[]>(
      `SELECT * FROM tasks ${whereSql} ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...(params as never[]));
}

export function deleteTask(id: string, handle: Database = db()): boolean {
  const r = handle.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return r.changes > 0;
}

export function setTaskBaseRef(id: string, baseRef: string, handle: Database = db()): void {
  handle
    .prepare("UPDATE tasks SET worktree_base_ref = ?, updated_at = ? WHERE id = ?")
    .run(baseRef, Date.now(), id);
}

export interface ProgressInput {
  step?: number | null;
  total?: number | null;
  label?: string | null;
}

export function setNeedsFeedback(
  id: string,
  question: string | null,
  handle: Database = db(),
): TaskRow | null {
  handle
    .prepare(
      "UPDATE tasks SET needs_feedback = 1, feedback_question = ?, updated_at = ? WHERE id = ?",
    )
    .run(question, Date.now(), id);
  return getTask(id, handle);
}

export function clearNeedsFeedback(id: string, handle: Database = db()): TaskRow | null {
  handle
    .prepare(
      "UPDATE tasks SET needs_feedback = 0, feedback_question = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), id);
  return getTask(id, handle);
}

export function setLastSessionId(id: string, sessionId: string, handle: Database = db()): void {
  handle
    .prepare("UPDATE tasks SET last_session_id = ?, updated_at = ? WHERE id = ?")
    .run(sessionId, Date.now(), id);
}

/**
 * Stamp the difficulty score on a task. `byUser=true` flags the row as a
 * manual override so the scoring agent never clobbers it on re-runs.
 */
export function setTaskDifficulty(
  id: string,
  difficulty: number,
  justification: string | null,
  byUser = false,
  handle: Database = db(),
): TaskRow | null {
  // Don't overwrite a user override with an agent score.
  if (!byUser) {
    const prev = getTask(id, handle);
    if (prev?.difficulty_overridden_by_user === 1) return prev;
  }
  handle
    .prepare(
      `UPDATE tasks SET difficulty = ?, difficulty_justification = ?,
                        difficulty_overridden_by_user = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(difficulty, justification, byUser ? 1 : 0, Date.now(), id);
  return getTask(id, handle);
}

export function setWorktree(
  id: string,
  fields: { path: string; branch: string; baseRef: string },
  handle: Database = db(),
): void {
  handle
    .prepare(
      `UPDATE tasks SET worktree_path = ?, worktree_branch = ?, worktree_base_ref = ?,
       updated_at = ? WHERE id = ?`,
    )
    .run(fields.path, fields.branch, fields.baseRef, Date.now(), id);
}

export function setTaskProgress(
  id: string,
  patch: ProgressInput,
  handle: Database = db(),
): TaskRow | null {
  const sets: string[] = [];
  const vals: unknown[] = [];
  if (patch.step !== undefined) {
    sets.push("current_step = ?");
    vals.push(patch.step);
  }
  if (patch.total !== undefined) {
    sets.push("total_steps = ?");
    vals.push(patch.total);
  }
  if (patch.label !== undefined) {
    sets.push("step_label = ?");
    vals.push(patch.label);
  }
  if (sets.length === 0) return getTask(id, handle);
  sets.push("updated_at = ?");
  vals.push(Date.now());
  vals.push(id);
  handle
    .prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
  return getTask(id, handle);
}

export function updateTaskStatus(
  id: string,
  status: TaskStatus,
  current_state: TaskState | null = null,
  handle: Database = db(),
): TaskRow | null {
  const now = Date.now();
  if (current_state) {
    // Bump state_entered_at only when the state actually changes; that way
    // restarts/retries within the same state preserve the stage timer.
    const prev = getTask(id, handle);
    const stateChanged = prev?.current_state !== current_state;
    if (stateChanged) {
      handle
        .prepare(
          "UPDATE tasks SET status = ?, current_state = ?, state_entered_at = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, current_state, now, now, id);
    } else {
      handle
        .prepare("UPDATE tasks SET status = ?, current_state = ?, updated_at = ? WHERE id = ?")
        .run(status, current_state, now, id);
    }
  } else {
    handle
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, now, id);
  }
  return getTask(id, handle);
}
