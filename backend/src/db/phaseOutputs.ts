/**
 * Per-phase outputs from the pipeline runner. Multi-phase pipelines
 * accumulate text artifacts — the intake's spec, the explorer's
 * verdict, the reviewers' findings — that downstream phases consume
 * as inputs. Keeping them in a dedicated table (rather than stitched
 * onto messages) lets the runner resume cleanly across user gates.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export type PhaseOutputValidationStatus = "ok" | "failed" | null;

export interface TaskPhaseOutputRow {
  id: number;
  task_id: string;
  phase_id: string;
  agent_slug: string;
  output_md: string;
  /** null = no schema declared for the agent (validation skipped),
   *  'ok' = passed validation, 'failed' = malformed after the reprompt
   *  cap exhausted. */
  validation_status: PhaseOutputValidationStatus;
  /** JSON-encoded string[] of validator error codes when status='failed'. */
  validation_errors_json: string | null;
  created_at: number;
}

export interface RecordPhaseOutputInput {
  outputMd: string;
  validationStatus?: PhaseOutputValidationStatus;
  validationErrors?: string[];
}

export function recordPhaseOutput(
  taskId: string,
  phaseId: string,
  agentSlug: string,
  input: string | RecordPhaseOutputInput,
  handle: Database = db(),
): TaskPhaseOutputRow {
  const args: RecordPhaseOutputInput =
    typeof input === "string" ? { outputMd: input } : input;
  const ts = Date.now();
  const errorsJson =
    args.validationErrors && args.validationErrors.length > 0
      ? JSON.stringify(args.validationErrors)
      : null;
  return handle
    .query<
      TaskPhaseOutputRow,
      [string, string, string, string, string | null, string | null, number]
    >(
      `INSERT INTO task_phase_outputs (
         task_id, phase_id, agent_slug, output_md,
         validation_status, validation_errors_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       RETURNING *`,
    )
    .get(
      taskId,
      phaseId,
      agentSlug,
      args.outputMd,
      args.validationStatus ?? null,
      errorsJson,
      ts,
    )!;
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
