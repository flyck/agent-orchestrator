import { describe, expect, test } from "bun:test";
import { decisionFromReply } from "./persist";

describe("decisionFromReply", () => {
  test("non-reviewer slug → null", () => {
    const reply = `\`\`\`yaml
decision: send_back
feedback: x
\`\`\``;
    expect(decisionFromReply("solution-explorer", reply)).toBeNull();
    expect(decisionFromReply("synthesizer", reply)).toBeNull();
  });

  test("reviewer accept → action: accept", () => {
    const reply = `\`\`\`yaml
decision: accept
notes: looks fine
\`\`\``;
    expect(decisionFromReply("reviewer-coder", reply)).toEqual({ action: "accept" });
  });

  test("reviewer send_back → action + feedback", () => {
    const reply = `\`\`\`yaml
decision: send_back
feedback: please fix the off-by-one
\`\`\``;
    expect(decisionFromReply("reviewer-coder", reply)).toEqual({
      action: "send_back",
      feedback: "please fix the off-by-one",
    });
  });

  test("reviewer send_back without feedback → fail-open accept (parser side)", () => {
    // parseReviewerDecision sends-back-without-feedback degrades to
    // accept; decisionFromReply just reflects that.
    const reply = `\`\`\`yaml
decision: send_back
\`\`\``;
    const out = decisionFromReply("reviewer-coder", reply);
    expect(out?.action).toBe("accept");
  });

  test("malformed reply → fail-open accept (no cycle-back trigger)", () => {
    // parseReviewerDecision returns Accept on parse failure /
    // empty input, so decisionFromReply mirrors that. The runner's
    // cycle-back path only fires on explicit send_back, so accept
    // here means "advance" — exactly the safe direction when the
    // agent's reply is unreadable.
    expect(decisionFromReply("reviewer-coder", "not yaml")).toEqual({ action: "accept" });
    expect(decisionFromReply("reviewer-coder", "")).toEqual({ action: "accept" });
  });
});
