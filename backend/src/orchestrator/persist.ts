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
} from "./reviewer";
import { log } from "../log";

const REVIEWER_SLUGS = new Set([
  "reviewer-coder",
  "review-security",
  "reviewer-performance",
  "reviewer-architecture",
]);

/** Side-effect for the reviewer YAML in the deep-review phase: write a
 *  task_reviews row + per-alt scoring/alternatives via persistReviewSideEffects. */
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
    if (decision.scoring) {
      upsertScoring(taskId, {
        scores: decision.scoring.scores,
        rationale: decision.scoring.rationale,
        set_by: agentSlug,
      });
    }
    if (decision.alternatives !== undefined) {
      replaceAlternatives(taskId, {
        alternatives: decision.alternatives.map((a) => ({
          label: a.label,
          description: a.description,
          scores: a.scores,
          rationales: a.rationales,
          verdict: a.verdict,
          rationale: a.rationale ?? null,
        })),
        set_by: agentSlug,
      });
    }
  } catch (err) {
    log.warn("orchestrator.persist.reviewer_failed", {
      taskId,
      agentSlug,
      error: String(err),
    });
  }
}

/** Side-effect for the explorer YAML in the explore phase: write
 *  scoring + alternatives + the explorer-summary fields on the task row. */
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
    if (out.scoring) {
      upsertScoring(taskId, {
        scores: out.scoring.scores,
        rationale: out.scoring.rationale,
        set_by: "solution-explorer",
      });
    }
    if (out.alternatives !== undefined) {
      replaceAlternatives(taskId, {
        alternatives: out.alternatives.map((a) => ({
          label: a.label,
          description: a.description,
          scores: a.scores,
          rationales: a.rationales,
          verdict: a.verdict,
          rationale: a.rationale ?? null,
          diagram_mermaid:
            (a as { diagram_mermaid?: string }).diagram_mermaid ?? null,
        })),
        set_by: "solution-explorer",
      });
    }
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
