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
  /** Paths into the parsed YAML object whose string values should be
   *  validated as Mermaid. Two path forms supported:
   *    - `key`             — top-level scalar string at obj.key
   *    - `key[].subkey`    — list at obj.key, validate subkey on each
   *  Failures append `mermaid_invalid: <path>: <reason>` to errors.
   *  Keys that are missing from the parsed object are skipped (use
   *  `required_keys` to make them required). */
  mermaid_keys?: string[];
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
  const obj = parsed as Record<string, unknown>;
  for (const key of spec.required_keys ?? []) {
    if (!(key in obj)) {
      errors.push(`required_key_missing: ${key}`);
    }
  }
  for (const path of spec.mermaid_keys ?? []) {
    for (const { fullPath, source } of resolveMermaidPaths(obj, path)) {
      const issue = checkMermaid(source);
      if (issue) {
        errors.push(`mermaid_invalid: ${fullPath}: ${issue}`);
      }
    }
  }
  return { ok: errors.length === 0, errors, parsed };
}

/** Walk a `key` or `key[].subkey` path, returning every string value
 *  found. Missing keys + non-string values are silently skipped — the
 *  intent is "validate every mermaid string we find," not "require
 *  these paths to exist" (use required_keys for required-ness). */
function resolveMermaidPaths(
  obj: Record<string, unknown>,
  path: string,
): Array<{ fullPath: string; source: string }> {
  const out: Array<{ fullPath: string; source: string }> = [];
  const m = path.match(/^([^\[\]]+)(\[\])?(?:\.(.+))?$/);
  if (!m) return out;
  const [, head, isArray, tail] = m;
  const node = obj[head!];
  if (node === undefined || node === null) return out;
  if (isArray) {
    if (!Array.isArray(node)) return out;
    node.forEach((item, i) => {
      if (!item || typeof item !== "object") return;
      const sub = (item as Record<string, unknown>)[tail!];
      if (typeof sub === "string") {
        out.push({ fullPath: `${head}[${i}].${tail}`, source: sub });
      }
    });
    return out;
  }
  if (typeof node === "string") out.push({ fullPath: head!, source: node });
  return out;
}

/** Heuristic Mermaid syntax check. The full mermaid parser is
 *  browser-coupled; the standalone @mermaid-js/parser doesn't ship
 *  flowchart yet. So we look for the most common mistakes the explorer
 *  agent actually makes:
 *    - missing diagram-type header
 *    - node labels containing `:`, `(`, `)`, `{`, or `}` without
 *      double-quote wrapping (these break the lexer when bare)
 *    - obviously truncated input (unbalanced quotes / brackets)
 *  Returns null when nothing obvious is wrong, or a short error reason
 *  when one trip-wire fires. */
const MERMAID_HEADERS = [
  "flowchart", "graph", "sequenceDiagram", "classDiagram",
  "stateDiagram", "erDiagram", "journey", "gantt", "pie",
  "mindmap", "timeline", "quadrantChart", "C4Context",
  "C4Container", "C4Component",
];
function checkMermaid(src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed) return "empty";
  const firstLine = trimmed.split(/\r?\n/, 1)[0]!.trim();
  if (!MERMAID_HEADERS.some((h) => firstLine.startsWith(h))) {
    return `missing_header: first line "${firstLine.slice(0, 40)}" doesn't start with a known diagram type (e.g. flowchart, sequenceDiagram)`;
  }
  // Unquoted node labels with risky chars. Match patterns like:
  //   NodeId[label with : or ( or )]
  //   NodeId(label …)
  // Skip when the label is wrapped in double quotes.
  const labelPattern = /\b([A-Za-z_][\w-]*)\s*[\[\(\{]([^\]\)\}\n"]*[:()\{\},][^\]\)\}\n"]*)[\]\)\}]/g;
  const offending: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = labelPattern.exec(trimmed)) !== null) {
    const inner = m[2]!.trim();
    if (inner.startsWith('"') && inner.endsWith('"')) continue;
    offending.push(`${m[1]}[${inner.slice(0, 40)}]`);
    if (offending.length >= 3) break;
  }
  if (offending.length > 0) {
    return `unquoted_label_chars: ${offending.join(", ")} — wrap node labels containing : ( ) { } , in double quotes`;
  }
  // Balanced quotes/brackets — counts only, doesn't track nesting.
  const dq = (trimmed.match(/"/g) ?? []).length;
  if (dq % 2 !== 0) return "unbalanced_quotes: odd number of double-quote characters";
  const open = (trimmed.match(/[\[\(\{]/g) ?? []).length;
  const close = (trimmed.match(/[\]\)\}]/g) ?? []).length;
  if (open !== close) return `unbalanced_brackets: ${open} opening vs ${close} closing`;
  return null;
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
