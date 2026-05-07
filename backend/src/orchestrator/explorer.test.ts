import { describe, expect, test } from "bun:test";
import { parseExplorerOutput } from "./explorer";

describe("parseExplorerOutput", () => {
  test("empty → null", () => {
    expect(parseExplorerOutput("")).toBeNull();
    expect(parseExplorerOutput("   ")).toBeNull();
  });

  test("non-yaml prose → null", () => {
    expect(parseExplorerOutput("This is just a code review.")).toBeNull();
  });

  test("happy path with all fields", () => {
    const body = `\`\`\`yaml
verdict: ship
confidence: high
summary: |
  The implementation looks fine.
scoring:
  complexity: { value: 4, rationale: "small lambda" }
  involved_parts: { value: 5, rationale: "five files" }
  lines_of_code: { value: 3, rationale: "modest" }
  user_benefit: { value: 8, rationale: "compliance" }
  maintainability: { value: 6, rationale: "ok" }
diagram_mermaid: |
  flowchart LR
  A --> B
alternatives:
  - title: Use a Map
    description: Replace the array scan with a Map keyed by id.
    verdict: better
    rationale: O(1) vs O(n).
    scoring:
      complexity: { value: 3, rationale: "simpler" }
\`\`\``;
    const out = parseExplorerOutput(body);
    expect(out).not.toBeNull();
    expect(out!.verdict).toBe("ship");
    expect(out!.summary).toContain("looks fine");
    expect(out!.diagramMermaid).toContain("flowchart LR");
    expect(out!.scoring?.scores).toEqual({
      complexity: 4,
      involved_parts: 5,
      lines_of_code: 3,
      user_benefit: 8,
      maintainability: 6,
    });
    expect(out!.alternatives).toHaveLength(1);
    expect(out!.alternatives![0]!.label).toBe("Use a Map");
    expect(out!.alternatives![0]!.verdict).toBe("better");
  });

  test("non-enum verdict passes through verbatim", () => {
    const body = `\`\`\`yaml
verdict: needs_changes
scoring: { complexity: { value: 1, rationale: "x" } }
alternatives: []
\`\`\``;
    const out = parseExplorerOutput(body);
    expect(out!.verdict).toBe("needs_changes");
  });

  test("empty alternatives list is preserved as []", () => {
    const body = `\`\`\`yaml
scoring: { complexity: { value: 1, rationale: "x" } }
alternatives: []
\`\`\``;
    const out = parseExplorerOutput(body);
    expect(out!.alternatives).toEqual([]);
  });

  test("alternative diagram_mermaid is threaded through", () => {
    const body = `\`\`\`yaml
scoring: { complexity: { value: 1, rationale: "x" } }
alternatives:
  - title: T
    description: D
    verdict: better
    diagram_mermaid: |
      flowchart LR
      X --> Y
\`\`\``;
    const out = parseExplorerOutput(body);
    const alt = out!.alternatives![0] as { diagram_mermaid?: string };
    expect(alt.diagram_mermaid).toContain("flowchart LR");
  });

  test("yaml without fence is still attempted (whole body)", () => {
    const body = `verdict: ship
scoring: { complexity: { value: 1, rationale: "x" } }
alternatives: []`;
    const out = parseExplorerOutput(body);
    expect(out!.verdict).toBe("ship");
  });

  test("malformed yaml → null", () => {
    const out = parseExplorerOutput("```yaml\nverdict: [bad\n```");
    expect(out).toBeNull();
  });
});
