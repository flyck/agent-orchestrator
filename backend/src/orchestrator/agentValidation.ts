/**
 * Per-agent output validation — generalises the explorer-specific
 * YAML re-prompt loop into something every agent can opt into through
 * frontmatter on its prompt .md.
 *
 * Frontmatter shape (additive, optional):
 *
 *     output:
 *       format: yaml | text
 *       required_keys: [verdict, scoring, alternatives]
 *       reprompt_hint: |
 *         Free-form one-paragraph nudge appended to the generic
 *         reprompt template — typically a one-line schema reminder.
 *
 * `format: text` (or absent `output:` block) → no validation, no
 * retry. Backwards-compatible with prose-only agents.
 *
 * `format: yaml` → reply must contain a fenced ```yaml block, parse
 * via `yaml.parse`, and (when set) carry every `required_keys` entry
 * at the top level. Validation is structural only — semantic
 * extraction stays in the per-agent parser modules
 * (`orchestrator/explorer.ts`, `orchestrator/reviewer.ts`).
 */

import { parse as parseYaml } from "yaml";

export interface AgentOutputSpec {
  format: "yaml" | "text";
  required_keys?: string[];
  reprompt_hint?: string;
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  /** When format is yaml and the body parses, the parsed object — so
   *  callers can avoid a second yaml.parse pass. Null otherwise. */
  parsed: unknown | null;
}

/**
 * Validate an agent's reply against its declared output spec.
 *
 * Returns ok=true when the spec is missing or `format: text`. The
 * runner uses the same function for both the reply-time check and the
 * generic verify endpoint, so behaviour stays identical between
 * "agent self-checks before sending" and "runner checks after
 * receiving".
 */
export function validateAgentOutput(
  rawText: string,
  spec: AgentOutputSpec | null,
): ValidationResult {
  if (!spec || spec.format === "text") {
    return { ok: true, errors: [], parsed: null };
  }

  const text = rawText.trim();
  if (!text) {
    return { ok: false, errors: ["empty_reply"], parsed: null };
  }

  const fenceMatch = text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i);
  const yamlBody = (fenceMatch?.[1] ?? text).trim();
  if (!fenceMatch) {
    return {
      ok: false,
      errors: [
        "yaml_fence_missing: reply must start with ```yaml and end with ```. The orchestrator extracts the first fenced block; without it, the body is treated as prose.",
      ],
      parsed: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch (err) {
    return {
      ok: false,
      errors: [`yaml_unparseable: ${err instanceof Error ? err.message : String(err)}`],
      parsed: null,
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: ["yaml_not_object: top level must be a YAML mapping (key: value pairs), not a list or scalar."],
      parsed: parsed ?? null,
    };
  }

  const errors: string[] = [];
  for (const key of spec.required_keys ?? []) {
    if (!(key in (parsed as Record<string, unknown>))) {
      errors.push(`required_key_missing: ${key}`);
    }
  }
  return { ok: errors.length === 0, errors, parsed };
}

/**
 * Build the generic reprompt body. Composed of:
 *   - a fixed "your last reply didn't validate" header,
 *   - the structured error list (so the agent sees exactly what failed),
 *   - the agent's own reprompt_hint (schema reminder),
 *   - a pointer at the verify endpoint with TASK_ID + AGENT_SLUG
 *     placeholders the runner substitutes at send-time.
 */
export function buildReprompt(
  spec: AgentOutputSpec,
  errors: string[],
): string {
  const lines = [
    "Your last reply did not validate against the role's required output schema.",
    "",
    "Validator errors:",
    ...errors.map((e) => `  - ${e}`),
    "",
    "Re-emit your reply now as a single ```yaml ... ``` block following the schema in your role prompt. Nothing before the fence, nothing after.",
  ];
  if (spec.reprompt_hint) {
    lines.push("", spec.reprompt_hint.trim());
  }
  lines.push(
    "",
    "Tip: before sending, you can verify with:",
    "  curl -sS -X POST http://localhost:3000/api/tasks/{{TASK_ID}}/agents/{{AGENT_SLUG}}/verify \\",
    "       -H 'content-type: application/json' \\",
    "       -d '{\"yaml\": \"<your yaml body here, escaped>\"}'",
    "It returns { ok, errors, parsed } so you can fix mistakes before finalizing.",
  );
  return lines.join("\n");
}
