import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";

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
export type TaskState = "spec" | "plan" | "build" | "ready" | "finalize";

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
  return getTask(id, handle)!;
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
  if (current_state) {
    handle
      .prepare("UPDATE tasks SET status = ?, current_state = ?, updated_at = ? WHERE id = ?")
      .run(status, current_state, Date.now(), id);
  } else {
    handle
      .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
      .run(status, Date.now(), id);
  }
  return getTask(id, handle);
}
