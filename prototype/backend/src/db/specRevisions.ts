/**
 * Spec revisions — a per-task append-only history of the spec markdown.
 *
 * Why: docs/05 Phase 12 + docs/10 say the user owns the spec and can edit
 * it after the task has moved on. Each edit gets its own row; we never
 * overwrite a previous revision. The latest revision's spec_md mirrors
 * `tasks.input_payload`, but the history lives here so the user can see
 * how their thinking evolved (and we can show diffs in v2).
 *
 * Shape comes from schema.sql:
 *   id PK · task_id FK · version (per-task monotonic) · spec_md · created_at
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface SpecRevisionRow {
  id: number;
  task_id: string;
  version: number;
  spec_md: string;
  created_at: number;
}

/** Latest version number for this task (0 if none — caller starts at 1). */
function latestVersion(taskId: string, handle: Database): number {
  const row = handle
    .query<{ v: number | null }, [string]>(
      "SELECT MAX(version) AS v FROM spec_revisions WHERE task_id = ?",
    )
    .get(taskId);
  return row?.v ?? 0;
}

/**
 * Append a new revision. Version is auto-assigned as latest + 1. Safe to
 * call from a transaction. Returns the new row.
 */
export function appendSpecRevision(
  taskId: string,
  specMd: string,
  handle: Database = db(),
): SpecRevisionRow {
  const next = latestVersion(taskId, handle) + 1;
  const now = Date.now();
  const r = handle
    .prepare(
      `INSERT INTO spec_revisions (task_id, version, spec_md, created_at)
       VALUES (?, ?, ?, ?) RETURNING *`,
    )
    .get(taskId, next, specMd, now) as SpecRevisionRow;
  return r;
}

/** Newest first — ordered by version descending. */
export function listSpecRevisions(
  taskId: string,
  handle: Database = db(),
): SpecRevisionRow[] {
  return handle
    .query<SpecRevisionRow, [string]>(
      "SELECT * FROM spec_revisions WHERE task_id = ? ORDER BY version DESC",
    )
    .all(taskId);
}
