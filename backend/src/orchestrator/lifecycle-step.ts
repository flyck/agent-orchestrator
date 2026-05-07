/**
 * Per-step decision for the legacy runLifecycle. Pure function over
 * the inputs the lifecycle's while-loop reads at the top of each
 * iteration. Extracted so the branching is testable without an
 * engine session — and so the v2 pipeline runner can adopt the
 * watchdog-recovery semantics it doesn't currently model.
 *
 * Inputs:
 *   - phase           — what the active session was running.
 *   - terminal        — pumpUntilTerminal's outcome.
 *   - forceCompleted  — set when the watchdog or user force-completed.
 *   - watchdogRecovered — true when forceCompleted came from the
 *     watchdog (= work likely done, just SSE missed events) rather
 *     than the user. Lets us promote a recovered plan/code session
 *     to the next phase instead of bailing to ready.
 *   - reviewerAction  — Accept / SendBack from parseReviewerDecision
 *     when phase === "review" + terminal === "idle". Ignored
 *     otherwise.
 *   - cycleCount      — review cycles burned so far. ≥ MAX → force accept.
 *   - isPrReview      — PR-review tasks have no coder to send back to.
 *
 * Output: a single discriminated union the caller dispatches on.
 */

import { MAX_REVIEW_CYCLES, ReviewDecisionAction } from "./reviewer";

export type LifecyclePhase = "plan" | "code" | "review";
export type Terminal = "idle" | "error" | null;

export interface LifecycleInputs {
  phase: LifecyclePhase;
  terminal: Terminal;
  forceCompleted: boolean;
  watchdogRecovered: boolean;
  reviewerAction?: ReviewDecisionAction;
  cycleCount: number;
  isPrReview: boolean;
}

export type LifecycleAction =
  /** Open a coder session and pump it next. Optional feedback splices
   *  into the coder's initial message (review→code cycle). */
  | { kind: "switch_to_coder"; feedback?: string }
  /** Open a reviewer session and pump it next. */
  | { kind: "switch_to_reviewer" }
  /** Finalize the task and exit the loop. */
  | { kind: "finalize"; status: "Done" | "Failed" | "Canceled" };

export function lifecycleStep(input: LifecycleInputs): LifecycleAction {
  // ── Force-completed branches ───────────────────────────────────
  // Watchdog-recovered plan/code → promote to the next phase
  // (work likely done; SSE missed events). Anything else → ready.
  if (input.forceCompleted) {
    if (input.watchdogRecovered && input.phase === "plan") {
      return { kind: "switch_to_coder" };
    }
    if (input.watchdogRecovered && input.phase === "code") {
      return { kind: "switch_to_reviewer" };
    }
    return { kind: "finalize", status: "Done" };
  }

  // ── External cancel (iterator closed without a terminal event) ─
  if (input.terminal === null) {
    return { kind: "finalize", status: "Canceled" };
  }

  // ── Session error per phase ─────────────────────────────────────
  if (input.terminal === "error") {
    if (input.phase === "plan") {
      // Plan-error isn't fatal — coder can still attempt without notes.
      return { kind: "switch_to_coder" };
    }
    if (input.phase === "code") {
      return { kind: "finalize", status: "Failed" };
    }
    // Review-error fails open to accept.
    return { kind: "finalize", status: "Done" };
  }

  // ── Clean idle, branch on phase ────────────────────────────────
  if (input.phase === "plan") {
    return { kind: "switch_to_coder" };
  }
  if (input.phase === "code") {
    return { kind: "switch_to_reviewer" };
  }

  // phase === "review", clean idle. Dispatch on the reviewer's verdict.
  if (input.reviewerAction === ReviewDecisionAction.Accept) {
    return { kind: "finalize", status: "Done" };
  }

  // PR-review tasks finalize on any reviewer verdict — there's no
  // coder downstream to send back to.
  if (input.isPrReview) {
    return { kind: "finalize", status: "Done" };
  }

  // send_back. Cycle cap hit → force accept; otherwise restart coder.
  if (input.cycleCount >= MAX_REVIEW_CYCLES) {
    return { kind: "finalize", status: "Done" };
  }
  return { kind: "switch_to_coder" };
}
