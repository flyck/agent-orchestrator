/**
 * Persisted reviewer-agent verdicts. Append-only — one row per review
 * pass within a task. The detail-panel "Reviewer" tab reads these to
 * show the user what the bot actually said, including history if the
 * reviewer sent back before accepting.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface TaskReviewRow {
  id: number;
  task_id: string;
  cycle: number;
  decision: "accept" | "send_back";
  notes: string | null;
  raw_text: string | null;
  created_at: number;
}

export interface AppendReviewInput {
  task_id: string;
  cycle: number;
  decision: "accept" | "send_back";
  notes: string | null;
  raw_text: string | null;
}

export function appendReview(
  input: AppendReviewInput,
  handle: Database = db(),
): TaskReviewRow {
  const ts = Date.now();
  const row = handle
    .query<TaskReviewRow, [string, number, string, string | null, string | null, number]>(
      `INSERT INTO task_reviews (task_id, cycle, decision, notes, raw_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(input.task_id, input.cycle, input.decision, input.notes, input.raw_text, ts);
  return row!;
}

/** Newest-first by default (most recent verdict first). */
export function listReviewsForTask(
  taskId: string,
  handle: Database = db(),
): TaskReviewRow[] {
  return handle
    .query<TaskReviewRow, [string]>(
      "SELECT * FROM task_reviews WHERE task_id = ? ORDER BY cycle DESC, created_at DESC",
    )
    .all(taskId);
}
