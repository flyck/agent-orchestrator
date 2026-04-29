/**
 * Suggested-next-steps storage. Spec: docs/15-integrations-and-suggested-next.md.
 *
 * Three sources are spec'd; v1 implements only `history` (mining recent
 * completed tasks in the same repo for deferred items in their specs).
 * The schema is generic so `integration` (GitHub) and `backlog` sources
 * can land later without a migration.
 */

import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";

export const SuggestionSource = {
  Integration: "integration",
  History: "history",
  Backlog: "backlog",
} as const;
export type SuggestionSource =
  (typeof SuggestionSource)[keyof typeof SuggestionSource];

export const SuggestionStatus = {
  Shown: "shown",
  Pinned: "pinned",
  Dismissed: "dismissed",
} as const;
export type SuggestionStatus =
  (typeof SuggestionStatus)[keyof typeof SuggestionStatus];

export interface SuggestionRow {
  id: string;
  task_id: string | null;
  source: SuggestionSource;
  source_ref: string;
  title: string;
  body_md: string | null;
  status: SuggestionStatus;
  created_at: number;
  updated_at: number;
}

export interface CreateSuggestionInput {
  task_id: string;
  source: SuggestionSource;
  source_ref: string;
  title: string;
  body_md?: string | null;
}

export function createSuggestion(
  input: CreateSuggestionInput,
  handle: Database = db(),
): SuggestionRow {
  const id = nanoid(12);
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO suggestions
         (id, task_id, source, source_ref, title, body_md, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.task_id,
      input.source,
      input.source_ref,
      input.title,
      input.body_md ?? null,
      SuggestionStatus.Shown,
      now,
      now,
    );
  return {
    id,
    task_id: input.task_id,
    source: input.source,
    source_ref: input.source_ref,
    title: input.title,
    body_md: input.body_md ?? null,
    status: SuggestionStatus.Shown,
    created_at: now,
    updated_at: now,
  };
}

/** Suggestions for a task, oldest first (so the order matches insertion). */
export function listSuggestionsForTask(
  taskId: string,
  handle: Database = db(),
): SuggestionRow[] {
  return handle
    .query<SuggestionRow, [string]>(
      `SELECT * FROM suggestions
        WHERE task_id = ? AND status != 'dismissed'
        ORDER BY created_at ASC`,
    )
    .all(taskId);
}

/** All pinned suggestions across all tasks, newest first.
 *  Powers the dashboard "Up next" feed. */
export function listPinnedSuggestions(
  limit = 20,
  handle: Database = db(),
): SuggestionRow[] {
  return handle
    .query<SuggestionRow, [number]>(
      `SELECT * FROM suggestions
        WHERE status = 'pinned'
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export function getSuggestion(
  id: string,
  handle: Database = db(),
): SuggestionRow | null {
  return handle
    .query<SuggestionRow, [string]>("SELECT * FROM suggestions WHERE id = ?")
    .get(id);
}

export function setSuggestionStatus(
  id: string,
  status: SuggestionStatus,
  handle: Database = db(),
): SuggestionRow | null {
  handle
    .prepare(
      `UPDATE suggestions SET status = ?, updated_at = ? WHERE id = ?`,
    )
    .run(status, Date.now(), id);
  return getSuggestion(id, handle);
}

/** Idempotency helper: skip generating a duplicate (same task + source + ref). */
export function findExistingSuggestion(
  taskId: string,
  source: SuggestionSource,
  sourceRef: string,
  handle: Database = db(),
): SuggestionRow | null {
  return handle
    .query<SuggestionRow, [string, string, string]>(
      `SELECT * FROM suggestions
        WHERE task_id = ? AND source = ? AND source_ref = ?
        LIMIT 1`,
    )
    .get(taskId, source, sourceRef);
}
