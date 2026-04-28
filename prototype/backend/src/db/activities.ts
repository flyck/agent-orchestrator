/**
 * Activity timeline. Append-only — every row is a discrete event keyed
 * by ts. Powers the home page's activity-squares panel and the
 * agent/manual ratio pie.
 *
 * Recording is best-effort: callers should not block on a failed insert.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export type ActivityKind =
  | "spec_create"
  | "spec_edit"
  | "review_sendback"
  | "review_rate"
  | "finalize"
  | "task_run";

export type ActivityActor = "user" | "agent";

export interface ActivityRow {
  id: number;
  ts: number;
  kind: ActivityKind;
  actor: ActivityActor;
  task_id: string | null;
  detail: string | null;
}

export interface ActivityWithTask extends ActivityRow {
  task_title: string | null;
  task_workspace: string | null;
}

export function recordActivity(
  kind: ActivityKind,
  actor: ActivityActor,
  taskId: string | null,
  detail: string | null = null,
  handle: Database = db(),
): void {
  try {
    handle
      .prepare(
        "INSERT INTO activity_events (ts, kind, actor, task_id, detail) VALUES (?, ?, ?, ?, ?)",
      )
      .run(Date.now(), kind, actor, taskId, detail);
  } catch {
    // best-effort
  }
}

export function listActivities(
  limit: number = 100,
  handle: Database = db(),
): ActivityWithTask[] {
  return handle
    .query<ActivityWithTask, [number]>(
      `SELECT a.id, a.ts, a.kind, a.actor, a.task_id, a.detail,
              t.title     AS task_title,
              t.workspace AS task_workspace
         FROM activity_events a
         LEFT JOIN tasks t ON t.id = a.task_id
         ORDER BY a.ts DESC
         LIMIT ?`,
    )
    .all(limit);
}
