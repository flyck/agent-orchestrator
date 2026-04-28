/**
 * Reviewer-suggested alternative solutions. The reviewer agent looks at
 * the diff and considers other ways the spec could have been satisfied.
 * Each alternative carries its own complexity-radar scores so the user
 * can compare side-by-side.
 *
 * Storage is "latest pass wins" — replaceForTask() wipes prior rows for
 * the task before inserting a new batch. Per-cycle history isn't
 * surfaced anywhere yet, and keeping it would complicate the Review-tab
 * UI without a clear use case.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export type AlternativeVerdict = "better" | "equal" | "worse";

export interface TaskAlternativeRow {
  id: number;
  task_id: string;
  label: string;
  description: string;
  scores_json: string;       // {dimension: 1..10}
  rationales_json: string | null;
  verdict: AlternativeVerdict;
  rationale: string | null;
  set_by: string;
  created_at: number;
}

export interface AlternativeInput {
  label: string;
  description: string;
  scores: Record<string, number>;
  rationales?: Record<string, string | null>;
  verdict: AlternativeVerdict;
  rationale?: string | null;
}

export interface ReplaceAlternativesInput {
  alternatives: AlternativeInput[];
  set_by: string;
}

export function replaceForTask(
  taskId: string,
  input: ReplaceAlternativesInput,
  handle: Database = db(),
): TaskAlternativeRow[] {
  const ts = Date.now();
  const tx = handle.transaction(() => {
    handle.prepare("DELETE FROM task_alternatives WHERE task_id = ?").run(taskId);
    const insert = handle.prepare(
      `INSERT INTO task_alternatives
         (task_id, label, description, scores_json, rationales_json,
          verdict, rationale, set_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const alt of input.alternatives) {
      const scores: Record<string, number> = {};
      for (const [k, v] of Object.entries(alt.scores)) {
        scores[k] = Math.max(1, Math.min(10, Math.round(v)));
      }
      insert.run(
        taskId,
        alt.label,
        alt.description,
        JSON.stringify(scores),
        alt.rationales ? JSON.stringify(alt.rationales) : null,
        alt.verdict,
        alt.rationale ?? null,
        input.set_by,
        ts,
      );
    }
  });
  tx();
  return listForTask(taskId, handle);
}

export function listForTask(taskId: string, handle: Database = db()): TaskAlternativeRow[] {
  return handle
    .query<TaskAlternativeRow, [string]>(
      `SELECT * FROM task_alternatives WHERE task_id = ? ORDER BY id ASC`,
    )
    .all(taskId);
}
