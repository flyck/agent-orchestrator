import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";
import { appendSpecRevision } from "./specRevisions";
import { ActivityActor, ActivityKind, recordActivity } from "./activities";

export const TaskWorkspace = {
  Review: "review",
  Feature: "feature",
  Bugfix: "bugfix",
  ArchCompare: "arch_compare",
  Background: "background",
  Internal: "internal",
} as const;
export type TaskWorkspace = (typeof TaskWorkspace)[keyof typeof TaskWorkspace];

export const TaskQueue = {
  Foreground: "foreground",
  Background: "background",
} as const;
export type TaskQueue = (typeof TaskQueue)[keyof typeof TaskQueue];

/**
 * High-level task category. Drives pipeline selection.
 *
 *   - Coding: the user wants code written / changed (feature, bugfix,
 *     arch_compare, background, internal). Walks the legacy
 *     plan→code→review lifecycle.
 *   - Review: the user wants someone *else's* code reviewed (currently
 *     just GitHub PRs). Walks the gated PR-review pipeline (Phase 16).
 *
 * Kept as a const-asserted object for ergonomic enum-ish usage from
 * callers without importing TS `enum` (which has its own quirks
 * around tree-shaking and runtime emit).
 */
export const TaskType = {
  Coding: "coding",
  Review: "review",
} as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/** Derive the type from the workspace. Single source of truth so we
 *  don't sprinkle `workspace === "review"` literals across the codebase. */
export function taskTypeFor(workspace: TaskWorkspace): TaskType {
  return workspace === TaskWorkspace.Review ? TaskType.Review : TaskType.Coding;
}

/** What the user provided as task input. */
export const TaskInputKind = {
  Diff: "diff",
  Path: "path",
  Prompt: "prompt",
  Spec: "spec",
} as const;
export type TaskInputKind = (typeof TaskInputKind)[keyof typeof TaskInputKind];

/** Post-hoc rating the user can stamp on a Ready task. Currently
 *  binary; structure is here for future Good/Bad/Mixed. */
export const TaskRating = {
  Bad: "bad",
} as const;
export type TaskRating = (typeof TaskRating)[keyof typeof TaskRating];
export const TaskStatus = {
  Queued: "queued",
  Running: "running",
  Synthesizing: "synthesizing",
  Done: "done",
  Failed: "failed",
  Canceled: "canceled",
  FindingsPending: "findings_pending",
} as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

/** Terminal statuses — task has stopped, won't run again. */
export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.Done,
  TaskStatus.Failed,
  TaskStatus.Canceled,
]);
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
  | "finalize"
  // PR-review pipeline phases (Phase 16, Design A). Stored verbatim
  // in tasks.current_state so pipeline cards can be filtered exactly
  // like local-task ones.
  | "intake"
  | "explore"
  | "direction-gate"
  | "deep-review"
  | "synthesis";

export interface TaskRow {
  id: string;
  workspace: TaskWorkspace;
  queue: TaskQueue;
  title: string;
  input_kind: TaskInputKind;
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
  /** How many times the reviewer agent sent the task back to the coder
   *  during this task. 0 = first-pass accepted (or reviewer not run yet). */
  review_cycles: number;
  /** How many times the user clicked Send back with feedback. */
  user_sendbacks: number;
  /** Optional post-hoc tag set in the Ready state. Currently only 'bad' is
   *  meaningful; null when unset. Free-form comment paired with it. */
  user_rating: TaskRating | null;
  user_rating_comment: string | null;
  /** Latest input-token count from an assistant message — i.e. the current
   *  conversation length fed to the model. Drives the on-card "ctx" chip. */
  latest_input_tokens: number | null;
  latest_tokens_ts: number | null;
  /** JSON map of pipeline stage → number of times this task has entered
   *  it. Bumped on each state transition. Powers the on-card re-entry
   *  bubble. Stored as TEXT in SQLite — callers should JSON.parse. */
  stage_entries_json: string;
  /** Timestamp the user clicked "Abandon" on this task. null = active
   *  or completed normally. Distinct from delete — the row stays so
   *  rating + activity entries keep their context. */
  abandoned_at: number | null;
  /** Multi-phase pipeline this task walks. null = legacy hard-coded
   *  lifecycle (the existing runLifecycle handles code-task workspaces). */
  pipeline_id: string | null;
  /** When non-null, the pipeline runner has paused at this gate phase
   *  awaiting user approval. The home detail surfaces an
   *  "approve direction / send back" banner driven by this field. */
  awaiting_gate_id: string | null;
  /** Task-type-specific metadata as a JSON blob. PR-review tasks stash
   *  GitHub coordinates here ({repo, number, base_ref, head_ref,
   *  html_url}); other task types may use it later. Parse with
   *  `parseTaskMetadata`. */
  metadata_json: string | null;
  /** Agent-compiled Conventional Commits message, generated when the
   *  task transitions to Ready. The user can edit before finalize.
   *  null until generation succeeds; finalize falls back to the title. */
  proposed_commit_message: string | null;
  created_at: number;
  updated_at: number;
}

export interface TaskGithubMetadata {
  repo: string;
  number: number;
  base_ref?: string;
  head_ref?: string;
  html_url?: string;
}

export interface TaskMetadata {
  github?: TaskGithubMetadata;
}

export function parseTaskMetadata(raw: string | null): TaskMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function setTaskMetadata(
  id: string,
  meta: TaskMetadata,
  handle: Database = db(),
): void {
  handle
    .prepare("UPDATE tasks SET metadata_json = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(meta), Date.now(), id);
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
    const initialState = input.initial_state ?? "spec";
    handle
      .prepare(
        `INSERT INTO tasks (id, workspace, queue, title, input_kind, input_payload,
                            repo_path, worktree_path, worktree_branch, worktree_base_ref,
                            status, current_state, state_entered_at, stage_entries_json,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
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
        initialState,
        now,
        JSON.stringify({ [initialState]: 1 }),
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
  // Record activity outside the tx so a failure doesn't roll back the
  // task creation. spec-kind tasks count as a spec creation; non-spec
  // tasks (review pasted-diff, etc.) don't get a spec_create event.
  if (input.input_kind === "spec") {
    recordActivity(ActivityKind.SpecCreate, ActivityActor.User, id, input.title, handle);
  }
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
  const t = getTask(id, handle);
  recordActivity(ActivityKind.SpecEdit, ActivityActor.User, id, t?.title ?? null, handle);
  return t;
}

export function getTask(id: string, handle: Database = db()): TaskRow | null {
  return handle.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
}

function startOfDayTs(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function startOfWeekTs(now: number): number {
  const d = new Date(now);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function listTasks(
  opts: { workspace?: TaskWorkspace; status?: TaskStatus; limit?: number; range?: "today" | "yesterday" | "week" } = {},
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
  if (opts.range) {
    const now = Date.now();
    const todayStart = startOfDayTs(now);
    if (opts.range === "today") {
      where.push("created_at >= ?");
      params.push(todayStart);
    } else if (opts.range === "yesterday") {
      where.push("created_at >= ?");
      params.push(todayStart - 86_400_000);
      where.push("created_at < ?");
      params.push(todayStart);
    } else if (opts.range === "week") {
      where.push("created_at >= ?");
      params.push(startOfWeekTs(now));
    }
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

/** Stamp the latest input-token count for a task. Cheap UPDATE — called
 *  from the orchestrator's message.updated handler. Avoids touching
 *  updated_at so the home-page card timers don't flicker on every turn. */
export function setLatestInputTokens(
  id: string,
  inputTokens: number,
  ts: number,
  handle: Database = db(),
): void {
  handle
    .prepare("UPDATE tasks SET latest_input_tokens = ?, latest_tokens_ts = ? WHERE id = ?")
    .run(inputTokens, ts, id);
}

/** Bump review_cycles by 1. Called by the orchestrator each time the
 *  reviewer sends the task back to the coder. Returns the new value. */
export function incrementReviewCycles(
  id: string,
  handle: Database = db(),
): number {
  const row = handle
    .query<{ v: number | null }, [string]>(
      "SELECT review_cycles AS v FROM tasks WHERE id = ?",
    )
    .get(id);
  const next = (row?.v ?? 0) + 1;
  handle
    .prepare("UPDATE tasks SET review_cycles = ?, updated_at = ? WHERE id = ?")
    .run(next, Date.now(), id);
  return next;
}

/** Bump user_sendbacks by 1. Called from the /continue endpoint when the
 *  user sends a task back with feedback. Returns the new value. */
export function incrementUserSendbacks(
  id: string,
  handle: Database = db(),
): number {
  const row = handle
    .query<{ v: number | null }, [string]>(
      "SELECT user_sendbacks AS v FROM tasks WHERE id = ?",
    )
    .get(id);
  const next = (row?.v ?? 0) + 1;
  handle
    .prepare("UPDATE tasks SET user_sendbacks = ?, updated_at = ? WHERE id = ?")
    .run(next, Date.now(), id);
  const t = getTask(id, handle);
  recordActivity(ActivityKind.ReviewSendback, ActivityActor.User, id, t?.title ?? null, handle);
  return next;
}

/** Set or clear the pipeline id for a task. */
export function setTaskPipeline(
  id: string,
  pipelineId: string | null,
  handle: Database = db(),
): void {
  handle
    .prepare("UPDATE tasks SET pipeline_id = ?, updated_at = ? WHERE id = ?")
    .run(pipelineId, Date.now(), id);
}

/** Pause the runner at a gate. The runner returns; the user resumes
 *  via the gate API which clears this field and continues. */
export function setAwaitingGate(
  id: string,
  gateId: string | null,
  handle: Database = db(),
): TaskRow | null {
  handle
    .prepare("UPDATE tasks SET awaiting_gate_id = ?, updated_at = ? WHERE id = ?")
    .run(gateId, Date.now(), id);
  return getTask(id, handle);
}

/**
 * Mark a task as abandoned by the user. Cancellation of any active run
 * is the caller's job — this is just the persistence side.
 */
export function markAbandoned(id: string, handle: Database = db()): TaskRow | null {
  const now = Date.now();
  handle
    .prepare("UPDATE tasks SET abandoned_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, id);
  return getTask(id, handle);
}

/** Persist (or clear) the agent-compiled commit message. The user may
 *  later edit this through the finalize UI; that path uses the same setter. */
export function setProposedCommitMessage(
  id: string,
  message: string | null,
  handle: Database = db(),
): TaskRow | null {
  handle
    .prepare("UPDATE tasks SET proposed_commit_message = ?, updated_at = ? WHERE id = ?")
    .run(message, Date.now(), id);
  return getTask(id, handle);
}

/** Set or clear the user's rating + comment. `rating=null` removes the tag. */
export function setUserRating(
  id: string,
  rating: TaskRating | null,
  comment: string | null,
  handle: Database = db(),
): TaskRow | null {
  handle
    .prepare(
      "UPDATE tasks SET user_rating = ?, user_rating_comment = ?, updated_at = ? WHERE id = ?",
    )
    .run(rating, comment, Date.now(), id);
  const t = getTask(id, handle);
  // A rating change is a human review action — log it. Clearing also counts
  // as a review action (the user looked again).
  if (t) recordActivity(ActivityKind.ReviewRate, ActivityActor.User, id, rating ?? "cleared", handle);
  return t;
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
      // Increment the entry count for the new stage. Parse-fail / missing
      // → start fresh at 0. `build` is normalized to `code` so legacy rows
      // share the same bucket as new ones.
      const normalized = current_state === "build" ? "code" : current_state;
      let entries: Record<string, number> = {};
      try {
        entries = JSON.parse(prev?.stage_entries_json ?? "{}");
        if (!entries || typeof entries !== "object") entries = {};
      } catch {
        entries = {};
      }
      entries[normalized] = (entries[normalized] ?? 0) + 1;
      handle
        .prepare(
          "UPDATE tasks SET status = ?, current_state = ?, state_entered_at = ?, stage_entries_json = ?, updated_at = ? WHERE id = ?",
        )
        .run(status, current_state, now, JSON.stringify(entries), now, id);
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
