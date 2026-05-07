import { describe, expect, test } from "bun:test";
import { resumeFrom } from "./resume";
import type { TaskRow } from "../db/tasks";
import type { PipelineDef } from "./pipelines";

const PIPELINE: PipelineDef = {
  id: "pr-review-gated",
  label: "test",
  phases: [
    { id: "intake", label: "Intake", kind: "agent", agents: ["pr-spec-intake"] },
    { id: "explore", label: "Explore", kind: "agent", agents: ["solution-explorer"] },
    { id: "direction-gate", label: "Direction", kind: "gate" },
    { id: "deep-review", label: "Deep Review", kind: "parallel", agents: ["reviewer-coder"] },
    { id: "synthesis", label: "Synthesis", kind: "agent", agents: ["synthesizer"] },
    { id: "ready", label: "Ready", kind: "gate" },
  ],
};

function makeTask(over: Partial<TaskRow> = {}): TaskRow {
  return {
    awaiting_gate_id: null,
    current_state: null,
    pipeline_id: "pr-review-gated",
    ...over,
  } as TaskRow;
}

describe("resumeFrom", () => {
  test("fresh start: no gate, no current_state → idx 0", () => {
    const r = resumeFrom(makeTask(), PIPELINE);
    expect(r).toEqual({ phaseIdx: 0, reason: "fresh", followUp: null });
  });

  test("approve resume: awaiting_gate_id → idx after the gate", () => {
    const r = resumeFrom(
      makeTask({ awaiting_gate_id: "direction-gate" }),
      PIPELINE,
    );
    // direction-gate is index 2; advance to 3.
    expect(r).toEqual({ phaseIdx: 3, reason: "approve", followUp: null });
  });

  test("approve resume: unknown gate id → fall back to fresh start", () => {
    const r = resumeFrom(makeTask({ awaiting_gate_id: "bogus" }), PIPELINE);
    expect(r.phaseIdx).toBe(0);
    expect(r.reason).toBe("approve");
  });

  test("sendback: no gate, current_state matches an agent phase, followUp set → resume there", () => {
    const r = resumeFrom(
      makeTask({ awaiting_gate_id: null, current_state: "explore" }),
      PIPELINE,
      { followUp: "please reconsider X" },
    );
    expect(r).toEqual({
      phaseIdx: 1,
      reason: "sendback",
      followUp: "please reconsider X",
    });
  });

  test("sendback without followUp falls back to fresh", () => {
    const r = resumeFrom(
      makeTask({ awaiting_gate_id: null, current_state: "explore" }),
      PIPELINE,
    );
    expect(r.phaseIdx).toBe(0);
    expect(r.reason).toBe("fresh");
  });

  test("sendback to a gate phase isn't allowed (only agent kind matches)", () => {
    const r = resumeFrom(
      makeTask({ awaiting_gate_id: null, current_state: "ready" }),
      PIPELINE,
      { followUp: "x" },
    );
    expect(r.reason).toBe("fresh");
  });

  test("approve takes priority over sendback signal — gate set + followUp → approve", () => {
    const r = resumeFrom(
      makeTask({
        awaiting_gate_id: "direction-gate",
        current_state: "explore",
      }),
      PIPELINE,
      { followUp: "ignored" },
    );
    expect(r.reason).toBe("approve");
    expect(r.followUp).toBe(null);
  });
});
