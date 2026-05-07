/**
 * Pipeline resume decision. Pure function over (task, pipeline, opts) —
 * extracted from runPipelineLifecycle so the three-branch logic lives in
 * one named place instead of an inline IIFE buried in the runner. Lets
 * future tweaks (e.g. resume-after-failure, ad-hoc phase rewinds) edit
 * one function without touching the runner's main loop.
 */

import { PhaseKind, type PipelineDef } from "./pipelines";
import type { TaskRow } from "../db/tasks";

export type ResumeReason = "approve" | "sendback" | "fresh";

export interface ResumeDecision {
  /** Index into pipeline.phases where the runner should start. */
  phaseIdx: number;
  /** Why we picked that index — surfaces in logs and in tests. */
  reason: ResumeReason;
  /** Echoes opts.followUp through to the runner so callers can route
   *  it into the first agent of the resumed phase. */
  followUp: string | null;
}

export interface ResumeOpts {
  /** User feedback to splice into the resumed agent phase. Only used
   *  by the sendback path; ignored when approving or starting fresh. */
  followUp?: string;
}

/**
 * Three branches:
 *
 *   1. `awaiting_gate_id` set on the task → the user just approved a
 *      gate. Advance to the phase AFTER the gate.
 *   2. `awaiting_gate_id` null + `current_state` matches an agent phase
 *      + a `followUp` was supplied → the user sent the gate back to
 *      that agent phase. Resume there.
 *   3. Otherwise → fresh run from index 0.
 *
 * The function never mutates the task or the pipeline; the caller is
 * responsible for clearing `awaiting_gate_id` etc. before kicking off
 * the runner.
 */
export function resumeFrom(
  task: TaskRow,
  pipeline: PipelineDef,
  opts: ResumeOpts = {},
): ResumeDecision {
  if (task.awaiting_gate_id) {
    const idx = pipeline.phases.findIndex((p) => p.id === task.awaiting_gate_id);
    return {
      phaseIdx: idx >= 0 ? idx + 1 : 0,
      reason: "approve",
      followUp: null,
    };
  }
  if (opts.followUp && task.current_state) {
    const idx = pipeline.phases.findIndex(
      (p) => p.id === task.current_state && p.kind === PhaseKind.Agent,
    );
    if (idx >= 0) {
      return { phaseIdx: idx, reason: "sendback", followUp: opts.followUp };
    }
  }
  return { phaseIdx: 0, reason: "fresh", followUp: null };
}
