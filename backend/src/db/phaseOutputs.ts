/**
 * Per-phase outputs from the pipeline runner. Multi-phase pipelines
 * accumulate text artifacts — the intake's spec, the explorer's
 * verdict, the reviewers' findings — that downstream phases consume
 * as inputs. Keeping them in a dedicated table (rather than stitched
 * onto messages) lets the runner resume cleanly across user gates.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface TaskPhaseOutputRow {
  id: number;
  task_id: string;
  phase_id: string;
  agent_slug: string;
  output_md: string;
  created_at: number;
}

export function recordPhaseOutput(
  taskId: string,
  phaseId: string,
  agentSlug: string,
  outputMd: string,
  handle: Database = db(),
): TaskPhaseOutputRow {
  const ts = Date.now();
  return handle
    .query<TaskPhaseOutputRow, [string, string, string, string, number]>(
      `INSERT INTO task_phase_outputs (task_id, phase_id, agent_slug, output_md, created_at)
       VALUES (?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(taskId, phaseId, agentSlug, outputMd, ts)!;
}

export function listPhaseOutputs(
  taskId: string,
  handle: Database = db(),
): TaskPhaseOutputRow[] {
  return handle
    .query<TaskPhaseOutputRow, [string]>(
      `SELECT * FROM task_phase_outputs WHERE task_id = ? ORDER BY created_at ASC`,
    )
    .all(taskId);
}

export function getPhaseOutput(
  taskId: string,
  phaseId: string,
  handle: Database = db(),
): TaskPhaseOutputRow | null {
  return handle
    .query<TaskPhaseOutputRow, [string, string]>(
      `SELECT * FROM task_phase_outputs WHERE task_id = ? AND phase_id = ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(taskId, phaseId);
}
