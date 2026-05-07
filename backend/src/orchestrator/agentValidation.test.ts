import { describe, expect, test } from "bun:test";
import {
  buildReprompt,
  validateAgentOutput,
  validateOutputSpec,
  type AgentOutputSpec,
} from "./agentValidation";

describe("validateOutputSpec", () => {
  test("absent → spec null, no errors", () => {
    expect(validateOutputSpec(undefined)).toEqual({ spec: null, errors: [] });
    expect(validateOutputSpec(null)).toEqual({ spec: null, errors: [] });
  });

  test("non-object → 1 error", () => {
    const r = validateOutputSpec("nope");
    expect(r.spec).toBeNull();
    expect(r.errors[0]).toMatch(/output_not_object/);
  });

  test("array (not mapping) → output_not_object", () => {
    const r = validateOutputSpec([{ format: "yaml" }]);
    expect(r.errors[0]).toMatch(/output_not_object/);
  });

  test("missing format → format_invalid", () => {
    const r = validateOutputSpec({ required_keys: ["x"] });
    expect(r.spec).toBeNull();
    expect(r.errors.some((e) => e.startsWith("format_invalid"))).toBe(true);
  });

  test("format text + no other fields → spec set", () => {
    const r = validateOutputSpec({ format: "text" });
    expect(r.errors).toEqual([]);
    expect(r.spec).toEqual({ format: "text", required_keys: undefined, mermaid_keys: undefined, reprompt_hint: undefined });
  });

  test("required_keys not array → required_keys_not_array", () => {
    const r = validateOutputSpec({ format: "yaml", required_keys: "x" });
    expect(r.errors[0]).toMatch(/required_keys_not_array/);
  });

  test("mermaid_keys with bad path syntax → mermaid_keys_bad_path", () => {
    const r = validateOutputSpec({
      format: "yaml",
      mermaid_keys: ["fine", "alts[].diagram_mermaid", "no spaces allowed"],
    });
    expect(r.errors.some((e) => e.includes("no spaces allowed"))).toBe(true);
  });

  test("happy path with all fields", () => {
    const r = validateOutputSpec({
      format: "yaml",
      required_keys: ["scoring", "alternatives"],
      mermaid_keys: ["diagram_mermaid", "alternatives[].diagram_mermaid"],
      reprompt_hint: "fix it",
    });
    expect(r.errors).toEqual([]);
    expect(r.spec).toEqual({
      format: "yaml",
      required_keys: ["scoring", "alternatives"],
      mermaid_keys: ["diagram_mermaid", "alternatives[].diagram_mermaid"],
      reprompt_hint: "fix it",
    });
  });
});

describe("validateAgentOutput — structural", () => {
  const spec: AgentOutputSpec = {
    format: "yaml",
    required_keys: ["verdict", "scoring"],
  };

  test("no spec → ok", () => {
    expect(validateAgentOutput("anything", null).ok).toBe(true);
  });

  test("format text → ok regardless", () => {
    expect(validateAgentOutput("free prose", { format: "text" }).ok).toBe(true);
  });

  test("empty body → empty_reply", () => {
    const r = validateAgentOutput("", spec);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("empty_reply");
  });

  test("missing yaml fence → yaml_fence_missing", () => {
    const r = validateAgentOutput("just prose, no fence", spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/yaml_fence_missing/);
  });

  test("malformed yaml → yaml_unparseable", () => {
    // Unmatched bracket — yaml.parse rejects.
    const r = validateAgentOutput("```yaml\nverdict: [ok\nscoring: x\n```", spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/yaml_unparseable/);
  });

  test("yaml that's a list, not a mapping → yaml_not_object", () => {
    const r = validateAgentOutput("```yaml\n- a\n- b\n```", spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/yaml_not_object/);
  });

  test("missing required key → required_key_missing", () => {
    const r = validateAgentOutput("```yaml\nverdict: ok\n```", spec);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain("required_key_missing: scoring");
  });

  test("all required keys present → ok", () => {
    const r = validateAgentOutput(
      "```yaml\nverdict: ok\nscoring: { complexity: 1 }\n```",
      spec,
    );
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.parsed).toEqual({ verdict: "ok", scoring: { complexity: 1 } });
  });
});

describe("validateAgentOutput — mermaid heuristic", () => {
  const spec: AgentOutputSpec = {
    format: "yaml",
    required_keys: [],
    mermaid_keys: ["diagram_mermaid", "alternatives[].diagram_mermaid"],
  };

  test("clean diagram passes", () => {
    const body = `\`\`\`yaml
diagram_mermaid: |
  flowchart LR
  A --> B
\`\`\``;
    expect(validateAgentOutput(body, spec).ok).toBe(true);
  });

  test("missing header is flagged", () => {
    const body = `\`\`\`yaml
diagram_mermaid: |
  A --> B
\`\`\``;
    const r = validateAgentOutput(body, spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/missing_header/);
  });

  test("unquoted node label with risky chars is flagged", () => {
    const body = `\`\`\`yaml
diagram_mermaid: |
  flowchart LR
  A[bad: label] --> B
\`\`\``;
    const r = validateAgentOutput(body, spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/unquoted_label_chars/);
  });

  test("array path: per-alternative diagrams are walked", () => {
    const body = `\`\`\`yaml
alternatives:
  - title: x
    description: y
    verdict: better
    diagram_mermaid: |
      flowchart LR
      Bad[label(with parens)] --> Y
\`\`\``;
    const r = validateAgentOutput(body, spec);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain("alternatives[0].diagram_mermaid");
  });

  test("missing optional mermaid path is silent", () => {
    // No diagram_mermaid, no alternatives — the spec's mermaid_keys
    // refer to absent paths, which should be skipped not errored.
    const body = `\`\`\`yaml
something: else
\`\`\``;
    expect(validateAgentOutput(body, spec).ok).toBe(true);
  });

  test("quoted node label with risky chars passes", () => {
    const body = `\`\`\`yaml
diagram_mermaid: |
  flowchart LR
  A["bad: label"] --> B
\`\`\``;
    expect(validateAgentOutput(body, spec).ok).toBe(true);
  });
});

describe("buildReprompt", () => {
  test("includes errors, hint, and templated curl URL", () => {
    const out = buildReprompt(
      { format: "yaml", reprompt_hint: "use scoring + alternatives" },
      ["required_key_missing: scoring"],
    );
    expect(out).toContain("required_key_missing: scoring");
    expect(out).toContain("use scoring + alternatives");
    expect(out).toContain("{{TASK_ID}}");
    expect(out).toContain("{{AGENT_SLUG}}");
  });

  test("works without a hint", () => {
    const out = buildReprompt({ format: "yaml" }, ["yaml_fence_missing"]);
    expect(out).toContain("yaml_fence_missing");
  });
});
