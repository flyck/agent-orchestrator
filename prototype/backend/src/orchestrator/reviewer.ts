/**
 * Reviewer phase. After the coder agent finishes a successful run, the
 * orchestrator opens a fresh session running the reviewer-coder prompt
 * and feeds it: spec, diff, optional history. The reviewer outputs a
 * YAML decision (accept | send_back) plus optional feedback. We parse
 * that and return a structured result for the lifecycle controller to
 * act on.
 *
 * Spec: docs/05 Phase 12 + the "split build → code/review" follow-up.
 *
 * Design notes:
 * - The reviewer runs in the SAME worktree as the coder (no new
 *   checkout). Diff is captured via `git diff <baseRef>...HEAD` and
 *   `git diff` (uncommitted) for whatever the coder didn't commit.
 * - Cap on review cycles is enforced by the caller, not here.
 * - parseDecision is fail-open: if we can't parse the YAML, treat as
 *   accept. Better to under-trigger than to lock the user in a loop.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import type { EngineSession } from "../engine/types";
import { getEngine } from "../engine/singleton";
import type { TaskRow } from "../db/tasks";
import { log } from "../log";

/** Maximum diff bytes we'll send to the reviewer. Bigger diffs almost
 *  certainly contain noise (lockfile churn, generated code) and burn
 *  reviewer tokens for negligible signal. The reviewer can still ask
 *  the user via the orchestrator's needs-feedback flow. */
const MAX_DIFF_BYTES = 60_000;

const REVIEWER_PROMPT_PATH = fileURLToPath(
  new URL("../../agents/builtin/review/reviewer-coder.md", import.meta.url),
);

/** Strip frontmatter + return the body. The shared system prompt
 *  prepended by buildSystemPrompt covers the boilerplate; we just want
 *  the role-specific body here. */
function loadReviewerPrompt(): string {
  try {
    const raw = readFileSync(REVIEWER_PROMPT_PATH, "utf8");
    // Drop the YAML frontmatter block at the top, if present.
    const m = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return (m?.[1] ?? raw).trim();
  } catch (err) {
    log.error("orchestrator.reviewer.prompt_read_failed", {
      error: String(err),
      path: REVIEWER_PROMPT_PATH,
    });
    return "You are a code reviewer. Output YAML: `decision: accept` or `decision: send_back\\nfeedback: ...`.";
  }
}

const REVIEWER_PROMPT = loadReviewerPrompt();

/**
 * Capture the coder's changes for the reviewer to read. Falls back
 * gracefully if git fails — the reviewer still gets the spec and can
 * ask for files via its bash tool.
 */
function captureDiff(worktreePath: string, baseRef: string): string {
  const sections: string[] = [];

  // 1. Committed delta against the base ref (in case the coder somehow
  //    committed despite the prompt forbidding it).
  const committed = spawnSync("git", ["diff", `${baseRef}...HEAD`], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (committed.status === 0 && committed.stdout.trim()) {
    sections.push(`### Committed since base (${baseRef})\n\n${committed.stdout}`);
  }

  // 2. Uncommitted working-tree diff — the coder is told to leave edits
  //    uncommitted, so this is where the bulk of changes live.
  const uncommitted = spawnSync("git", ["diff", "HEAD"], {
    cwd: worktreePath,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (uncommitted.status === 0 && uncommitted.stdout.trim()) {
    sections.push(`### Uncommitted (working tree)\n\n${uncommitted.stdout}`);
  }

  // 3. New (untracked) files — show their paths so the reviewer knows
  //    they exist; full contents would blow the budget for large adds.
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: worktreePath,
    encoding: "utf8",
  });
  if (untracked.status === 0 && untracked.stdout.trim()) {
    sections.push(
      `### New (untracked) files — ask via bash if you need contents\n\n${untracked.stdout}`,
    );
  }

  if (sections.length === 0) return "_(no diff — the coder made no changes)_";

  let combined = sections.join("\n\n");
  if (combined.length > MAX_DIFF_BYTES) {
    combined =
      combined.slice(0, MAX_DIFF_BYTES) +
      `\n\n_[diff truncated at ${MAX_DIFF_BYTES} bytes — use bash to read specific files for the rest]_`;
  }
  return combined;
}

export interface ReviewerInput {
  task: TaskRow;
  /** When > 0 this is a re-review after a previous send-back. Surfaces
   *  in the prompt so the reviewer can be more lenient on cycle 2/3. */
  cycleCount: number;
  /** Feedback the reviewer gave on the prior cycle, if any — included
   *  so the reviewer can verify "did the coder actually address it?". */
  priorFeedback?: string;
}

/** Compose the user message sent to the reviewer session. */
export function buildReviewerMessage(input: ReviewerInput): string {
  const { task, cycleCount, priorFeedback } = input;
  const diff = task.worktree_path
    ? captureDiff(task.worktree_path, task.worktree_base_ref ?? "HEAD")
    : "_(no worktree — diff unavailable)_";

  const historyBlock =
    cycleCount > 0
      ? `\n\n# Review history\n\nThis is review cycle **${cycleCount + 1}**. Previous feedback was:\n\n> ${
          (priorFeedback ?? "(none recorded)")
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .join("\n> ")
        }\n\nDid the coder address it? If not, send back again. If they addressed it but introduced new problems, send back with the new problems. Otherwise accept.`
      : "";

  return `# Review request

# Spec

\`\`\`markdown
${task.input_payload}
\`\`\`

# Coder's diff

${diff}${historyBlock}

# Your task

Decide: \`accept\` or \`send_back\`. Reply with the YAML block specified
in your role prompt — nothing else.`;
}

/** Open a fresh OpenCode session for the reviewer. cwd = worktree so
 *  the reviewer's bash tool can read files referenced in the diff. */
export async function openReviewerSession(
  task: TaskRow,
  taskId: string,
  buildSystemPrompt: (taskId: string, cwd: string) => string,
): Promise<EngineSession> {
  const engine = await getEngine();
  const cwd = task.worktree_path ?? undefined;
  const session = await engine.openSession({
    title: `review:${task.title}`,
    cwd,
  });
  log.info("orchestrator.reviewer.session_opened", {
    taskId,
    sessionId: session.id,
    cwd,
  });
  return session;
}

/** Build the system prompt the reviewer session uses. Combines the
 *  shared protocols (passed in as a renderer) with the reviewer body. */
export function buildReviewerSystemPrompt(
  baseSharedPrompt: string,
): string {
  return `${baseSharedPrompt}

---

${REVIEWER_PROMPT}`;
}

export type Confidence = "high" | "medium" | "low";

export interface ReviewFinding {
  severity: "info" | "low" | "medium" | "high";
  confidence: Confidence;
  location: string;
  title: string;
  detail: string;
}

export type ReviewDecision =
  | {
      action: "accept";
      notes?: string;
      confidence?: Confidence;
      findings?: ReviewFinding[];
    }
  | {
      action: "send_back";
      feedback: string;
      confidence?: Confidence;
      findings?: ReviewFinding[];
    };

const CONFIDENCE_VALUES: Confidence[] = ["high", "medium", "low"];
function parseConfidence(raw: unknown): Confidence | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase().trim() as Confidence;
  return CONFIDENCE_VALUES.includes(v) ? v : undefined;
}

function parseFindings(raw: unknown): ReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const title = typeof o["title"] === "string" ? o["title"] : "";
    const detail = typeof o["detail"] === "string" ? o["detail"] : "";
    if (!title && !detail) continue;
    const severity = (typeof o["severity"] === "string" ? o["severity"] : "info").toLowerCase();
    out.push({
      severity: (["info", "low", "medium", "high"].includes(severity)
        ? severity
        : "info") as ReviewFinding["severity"],
      confidence: parseConfidence(o["confidence"]) ?? "medium",
      location: typeof o["location"] === "string" ? o["location"] : "general",
      title,
      detail,
    });
  }
  return out;
}

/**
 * Parse the reviewer's YAML reply into a structured decision.
 *
 * Fail-open: any parse error → accept. Rationale: a stuck send_back
 * loop is worse than missing a finding (the user reviews the diff
 * themselves anyway). Errors are logged so the user can see when this
 * happens.
 */
export function parseReviewerDecision(rawText: string): ReviewDecision {
  const text = rawText.trim();
  if (!text) {
    log.warn("orchestrator.reviewer.empty_reply");
    return { action: "accept" };
  }

  // Pull out the first ```yaml ... ``` block; fall back to whole text.
  const fenceMatch = text.match(/```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i);
  const yamlBody = (fenceMatch?.[1] ?? text).trim();

  let parsed: unknown;
  try {
    parsed = parseYaml(yamlBody);
  } catch (err) {
    log.warn("orchestrator.reviewer.yaml_parse_failed", {
      error: String(err),
      head: yamlBody.slice(0, 200),
    });
    return { action: "accept" };
  }

  if (!parsed || typeof parsed !== "object") {
    log.warn("orchestrator.reviewer.unexpected_shape", { type: typeof parsed });
    return { action: "accept" };
  }

  const obj = parsed as Record<string, unknown>;
  const decision = String(obj["decision"] ?? "").toLowerCase().trim();
  const confidence = parseConfidence(obj["confidence"]);
  const findings = parseFindings(obj["findings"]);

  if (decision === "send_back") {
    const feedback = typeof obj["feedback"] === "string" ? obj["feedback"].trim() : "";
    if (!feedback) {
      log.warn("orchestrator.reviewer.send_back_without_feedback");
      // Send-back without feedback is useless to the coder. Accept.
      return { action: "accept", confidence, findings };
    }
    return { action: "send_back", feedback, confidence, findings };
  }

  // Anything other than send_back → accept. Includes 'accept', misspellings,
  // missing field, etc. Capture optional notes so they can be logged.
  const notes = typeof obj["notes"] === "string" ? obj["notes"].trim() : undefined;
  return { action: "accept", notes, confidence, findings };
}

/** Hard cap on how many times the reviewer can send back. After this
 *  the controller forces accept. Tunable; 2 send-backs (= 3 coder
 *  passes) is generous for a single-pass reviewer. */
export const MAX_REVIEW_CYCLES = 2;
