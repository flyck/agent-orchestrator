/**
 * Per-(agent, phase) post-reply persistence. The pipeline runner
 * delegates "what does this YAML mean for the DB" to this module so
 * the runner stays focused on session lifecycle. Two persist paths
 * today — one for reviewers, one for the explorer — both fail-open
 * (parse error → log warn, raw output is still preserved by the
 * caller via recordPhaseOutput).
 *
 * Adding a new agent that writes structured fields to the DB =
 * dropping a new branch into `persistAgentReply` keyed on
 * (agentSlug, phaseId).
 */

import { appendReview } from "../db/reviews";
import { upsertScoring } from "../db/scorings";
import { replaceForTask as replaceAlternatives } from "../db/alternatives";
import { setExplorerOutput } from "../db/tasks";
import { parseExplorerOutput } from "./explorer";
import {
  parseReviewerDecision,
  ReviewDecisionAction,
  type RadarAlternative,
  type RadarScoring,
} from "./reviewer";
import { log } from "../log";

const REVIEWER_SLUGS = new Set([
  "reviewer-coder",
  "review-security",
  "reviewer-performance",
  "reviewer-architecture",
]);

/** Persist a radar (scoring + alternatives) batch to the DB. Both
 *  reviewer and explorer agents emit this shape; collapsing the
 *  per-agent code keeps the two persist branches narrow. */
function persistRadar(
  taskId: string,
  setBy: string,
  scoring: RadarScoring | undefined,
  alternatives: RadarAlternative[] | undefined,
): void {
  if (scoring) {
    upsertScoring(taskId, {
      scores: scoring.scores,
      rationale: scoring.rationale,
      set_by: setBy,
    });
  }
  // alternatives === undefined → leave prior rows alone (agent didn't
  // include the field). Empty array → wipe — that's an explicit "no
  // alternatives" answer the prompt allows.
  if (alternatives !== undefined) {
    replaceAlternatives(taskId, {
      alternatives: alternatives.map((a) => ({
        label: a.label,
        description: a.description,
        scores: a.scores,
        rationales: a.rationales,
        verdict: a.verdict,
        rationale: a.rationale ?? null,
        diagram_mermaid:
          (a as { diagram_mermaid?: string }).diagram_mermaid ?? null,
      })),
      set_by: setBy,
    });
  }
}

/** Side-effect for the reviewer YAML in the deep-review phase:
 *  appends a task_reviews row and persists scoring + alternatives. */
function persistReviewer(taskId: string, agentSlug: string, reply: string): void {
  try {
    const decision = parseReviewerDecision(reply);
    if (
      decision.action !== ReviewDecisionAction.Accept &&
      decision.action !== ReviewDecisionAction.SendBack
    ) {
      return;
    }
    appendReview({
      task_id: taskId,
      cycle: 0,
      decision: decision.action,
      notes:
        decision.action === ReviewDecisionAction.Accept
          ? decision.notes ?? null
          : decision.feedback,
      raw_text: reply,
      confidence: decision.confidence ?? null,
      findings_json:
        decision.findings && decision.findings.length > 0
          ? JSON.stringify(decision.findings)
          : null,
    });
    persistRadar(taskId, agentSlug, decision.scoring, decision.alternatives);
  } catch (err) {
    log.warn("orchestrator.persist.reviewer_failed", {
      taskId,
      agentSlug,
      error: String(err),
    });
  }
}

/** Side-effect for the explorer YAML in the explore phase: writes
 *  scoring + alternatives + the explorer-summary fields on the task. */
function persistExplorer(taskId: string, reply: string): void {
  try {
    const out = parseExplorerOutput(reply);
    if (!out) {
      log.warn("orchestrator.persist.explorer_yaml_missing", {
        taskId,
        replyHead: reply.slice(0, 160),
      });
      return;
    }
    persistRadar(taskId, "solution-explorer", out.scoring, out.alternatives);
    setExplorerOutput(taskId, {
      summary: out.summary ?? null,
      verdict: out.verdict ?? null,
      architecture_mermaid: out.diagramMermaid ?? null,
    });
    log.info("orchestrator.persist.explorer_done", {
      taskId,
      hasScoring: !!out.scoring,
      altCount: out.alternatives?.length ?? 0,
      verdict: out.verdict,
    });
  } catch (err) {
    log.warn("orchestrator.persist.explorer_failed", {
      taskId,
      error: String(err),
    });
  }
}

/**
 * Dispatch on (agentSlug, phaseId). Single entry point the runner
 * calls after recording phase output. New agents add a branch here.
 */
export function persistAgentReply(
  taskId: string,
  agentSlug: string,
  phaseId: string,
  reply: string,
): void {
  if (!reply) return;
  if (REVIEWER_SLUGS.has(agentSlug) && phaseId === "deep-review") {
    persistReviewer(taskId, agentSlug, reply);
    return;
  }
  if (agentSlug === "solution-explorer" && phaseId === "explore") {
    persistExplorer(taskId, reply);
    return;
  }
  // No structured persistence for this agent — task_phase_outputs
  // already has the raw reply, that's enough.
}

/** Outcome of a phase's reply that the runner needs to act on.
 *  - "accept"     → advance to the next phase.
 *  - "send_back"  → if the phase has cycle_back set, re-enter that
 *    phase with feedback. Otherwise behave as accept.
 *  - null         → no actionable decision (most agents).
 *  The `feedback` field carries the reviewer's prose to splice into
 *  the cycled-back agent's next message. */
export interface PhaseDecision {
  action: "accept" | "send_back";
  feedback?: string;
}

/** Inspect a reviewer's YAML reply and return the action + feedback
 *  the runner should use to decide between advance and cycle-back.
 *  Non-reviewer agents return null. Parse failure returns null too —
 *  fail-open: silent send_back loops are worse than missing one. */
export function decisionFromReply(
  agentSlug: string,
  reply: string,
): PhaseDecision | null {
  if (agentSlug !== "reviewer-coder") return null;
  try {
    const decision = parseReviewerDecision(reply);
    if (decision.action === ReviewDecisionAction.Accept) {
      return { action: "accept" };
    }
    if (decision.action === ReviewDecisionAction.SendBack) {
      return { action: "send_back", feedback: decision.feedback };
    }
  } catch {
    // fail-open
  }
  return null;
}
