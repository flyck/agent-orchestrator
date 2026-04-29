/**
 * Task radar-chart scoring. One row per (task_id, dimension).
 *
 * The reviewer agent (and any other producer instructed in its system
 * prompt) UPSERTs scores via the API. Latest writer wins. Free-form
 * dimensions are stored; the frontend pins display order via a known
 * list. Unknown dimensions are persisted but won't render until the
 * frontend learns about them.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface TaskScoringRow {
  task_id: string;
  dimension: string;
  score: number;
  rationale: string | null;
  set_by: string;
  updated_at: number;
}

export interface ScoringInput {
  /** Map of dimension → integer 1–10. Partial allowed. */
  scores: Record<string, number>;
  /** Optional per-dimension prose. */
  rationale?: Record<string, string | null>;
  /** Agent slug (or 'user') that produced the scoring. */
  set_by: string;
}

export function upsertScoring(
  taskId: string,
  input: ScoringInput,
  handle: Database = db(),
): TaskScoringRow[] {
  const now = Date.now();
  const stmt = handle.prepare(
    `INSERT INTO task_scorings (task_id, dimension, score, rationale, set_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (task_id, dimension) DO UPDATE SET
       score = excluded.score,
       rationale = excluded.rationale,
       set_by = excluded.set_by,
       updated_at = excluded.updated_at`,
  );
  const tx = handle.transaction(() => {
    for (const [dim, raw] of Object.entries(input.scores)) {
      const score = Math.max(1, Math.min(10, Math.round(raw)));
      const rationale = input.rationale?.[dim] ?? null;
      stmt.run(taskId, dim, score, rationale, input.set_by, now);
    }
  });
  tx();
  return listScoring(taskId, handle);
}

export function listScoring(taskId: string, handle: Database = db()): TaskScoringRow[] {
  return handle
    .query<TaskScoringRow, [string]>(
      "SELECT * FROM task_scorings WHERE task_id = ? ORDER BY dimension ASC",
    )
    .all(taskId);
}

/** Latest score per (task, dimension) for a list of tasks. Powers the
 *  per-card complexity chip on the home pipeline — cheap one-shot vs.
 *  fanning out N getScoring calls from the frontend. */
export function listScoringSummary(
  taskIds: string[],
  handle: Database = db(),
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => "?").join(",");
  const rows = handle
    .query<{ task_id: string; dimension: string; score: number }, never[]>(
      `SELECT task_id, dimension, score FROM task_scorings WHERE task_id IN (${placeholders})`,
    )
    .all(...(taskIds as never[]));
  for (const r of rows) {
    if (!out[r.task_id]) out[r.task_id] = {};
    out[r.task_id]![r.dimension] = r.score;
  }
  return out;
}
