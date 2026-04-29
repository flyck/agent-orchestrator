/**
 * task_phase_sessions: one row per engine session the orchestrator opens
 * for a task. Captures (task → phase → agent → session) so the frontend
 * can build per-agent detail tabs and join usage_events.session_id back
 * to a human-readable agent label without spelunking the orchestrator
 * logs.
 *
 * Written at session_open; updated at safeClose. The transcript itself
 * stays on the engine side (Claude JSONL / OpenCode db) and is fetched
 * on demand via /api/tasks/:id/transcript?session_id=…
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface TaskPhaseSessionRow {
  session_id: string;
  task_id: string;
  phase_id: string;
  agent_slug: string;
  started_at: number;
  ended_at: number | null;
  ended_reason: string | null;
}

export function recordPhaseSessionOpen(
  taskId: string,
  phaseId: string,
  agentSlug: string,
  sessionId: string,
  handle: Database = db(),
): void {
  // INSERT OR REPLACE so reopens on the same session id (rare but
  // possible after watchdog recovery) don't blow up the unique key.
  handle
    .query(
      `INSERT OR REPLACE INTO task_phase_sessions
        (session_id, task_id, phase_id, agent_slug, started_at, ended_at, ended_reason)
       VALUES (?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(sessionId, taskId, phaseId, agentSlug, Date.now());
}

export function recordPhaseSessionClose(
  sessionId: string,
  reason: string,
  handle: Database = db(),
): void {
  handle
    .query(
      `UPDATE task_phase_sessions
          SET ended_at = ?, ended_reason = ?
        WHERE session_id = ? AND ended_at IS NULL`,
    )
    .run(Date.now(), reason, sessionId);
}

export function listPhaseSessions(
  taskId: string,
  handle: Database = db(),
): TaskPhaseSessionRow[] {
  return handle
    .query<TaskPhaseSessionRow, [string]>(
      `SELECT * FROM task_phase_sessions
        WHERE task_id = ?
        ORDER BY started_at ASC`,
    )
    .all(taskId);
}

export function getPhaseSession(
  sessionId: string,
  handle: Database = db(),
): TaskPhaseSessionRow | null {
  return handle
    .query<TaskPhaseSessionRow, [string]>(
      `SELECT * FROM task_phase_sessions WHERE session_id = ?`,
    )
    .get(sessionId);
}
