import { describe, expect, test } from "bun:test";
import { lifecycleStep, type LifecycleInputs } from "./lifecycle-step";
import { ReviewDecisionAction } from "./reviewer";

function inputs(over: Partial<LifecycleInputs> = {}): LifecycleInputs {
  return {
    phase: "plan",
    terminal: "idle",
    forceCompleted: false,
    watchdogRecovered: false,
    cycleCount: 0,
    isPrReview: false,
    ...over,
  };
}

describe("lifecycleStep — force-completed branches", () => {
  test("watchdog-recovered plan → switch to coder", () => {
    expect(lifecycleStep(inputs({
      phase: "plan",
      forceCompleted: true,
      watchdogRecovered: true,
    }))).toEqual({ kind: "switch_to_coder" });
  });

  test("watchdog-recovered code → switch to reviewer", () => {
    expect(lifecycleStep(inputs({
      phase: "code",
      forceCompleted: true,
      watchdogRecovered: true,
    }))).toEqual({ kind: "switch_to_reviewer" });
  });

  test("watchdog-recovered review → finalize Done (no successor)", () => {
    expect(lifecycleStep(inputs({
      phase: "review",
      forceCompleted: true,
      watchdogRecovered: true,
    }))).toEqual({ kind: "finalize", status: "Done" });
  });

  test("user-triggered force-complete (no watchdog flag) → finalize Done", () => {
    expect(lifecycleStep(inputs({
      phase: "code",
      forceCompleted: true,
      watchdogRecovered: false,
    }))).toEqual({ kind: "finalize", status: "Done" });
  });
});

describe("lifecycleStep — external cancel", () => {
  test("terminal === null → finalize Canceled regardless of phase", () => {
    for (const phase of ["plan", "code", "review"] as const) {
      expect(lifecycleStep(inputs({ phase, terminal: null }))).toEqual({
        kind: "finalize",
        status: "Canceled",
      });
    }
  });
});

describe("lifecycleStep — session error per phase", () => {
  test("plan error → switch to coder (fall-through)", () => {
    expect(lifecycleStep(inputs({ phase: "plan", terminal: "error" }))).toEqual({
      kind: "switch_to_coder",
    });
  });

  test("code error → finalize Failed", () => {
    expect(lifecycleStep(inputs({ phase: "code", terminal: "error" }))).toEqual({
      kind: "finalize",
      status: "Failed",
    });
  });

  test("review error → finalize Done (fail-open accept)", () => {
    expect(lifecycleStep(inputs({ phase: "review", terminal: "error" }))).toEqual({
      kind: "finalize",
      status: "Done",
    });
  });
});

describe("lifecycleStep — clean idle progressions", () => {
  test("plan idle → switch to coder", () => {
    expect(lifecycleStep(inputs({ phase: "plan" }))).toEqual({
      kind: "switch_to_coder",
    });
  });

  test("code idle → switch to reviewer", () => {
    expect(lifecycleStep(inputs({ phase: "code" }))).toEqual({
      kind: "switch_to_reviewer",
    });
  });

  test("review idle + accept → finalize Done", () => {
    expect(lifecycleStep(inputs({
      phase: "review",
      reviewerAction: ReviewDecisionAction.Accept,
    }))).toEqual({ kind: "finalize", status: "Done" });
  });

  test("review idle + send_back + cycle 0 → switch to coder", () => {
    expect(lifecycleStep(inputs({
      phase: "review",
      reviewerAction: ReviewDecisionAction.SendBack,
      cycleCount: 0,
    }))).toEqual({ kind: "switch_to_coder" });
  });

  test("review idle + send_back + cycle cap → finalize Done (forced accept)", () => {
    expect(lifecycleStep(inputs({
      phase: "review",
      reviewerAction: ReviewDecisionAction.SendBack,
      cycleCount: 2, // == MAX_REVIEW_CYCLES
    }))).toEqual({ kind: "finalize", status: "Done" });
  });

  test("PR-review tasks finalize on any reviewer verdict", () => {
    // No coder downstream to send back to — accept or send_back both
    // end the lifecycle.
    expect(lifecycleStep(inputs({
      phase: "review",
      reviewerAction: ReviewDecisionAction.SendBack,
      isPrReview: true,
    }))).toEqual({ kind: "finalize", status: "Done" });
    expect(lifecycleStep(inputs({
      phase: "review",
      reviewerAction: ReviewDecisionAction.Accept,
      isPrReview: true,
    }))).toEqual({ kind: "finalize", status: "Done" });
  });
});
