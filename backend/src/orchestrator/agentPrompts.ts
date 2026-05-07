/**
 * Agent prompt bodies and per-(phase, agent) message building. Pure
 * data-and-text functions — no engine, no DB writes, no queue
 * coupling. The pipeline runner imports from here; everything in
 * this file is reasonable to test in isolation.
 *
 * Adding a new pipeline phase that needs a custom user message =
 * dropping a branch into buildPipelinePhaseMessage. Adding a new
 * agent .md = a new entry in PIPELINE_AGENTS plus its frontmatter
 * `output:` spec.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { getPhaseOutput } from "../db/phaseOutputs";
import type { TaskRow } from "../db/tasks";
import { type PhaseDef } from "./pipelines";
import { validateOutputSpec, type AgentOutputSpec } from "./agentValidation";
import { captureDiff } from "./reviewer";
import { log } from "../log";

/** Loaded role prompt + the validation spec declared in its
 *  frontmatter. `output` is null when the agent doesn't declare one
 *  (= prose-only agents, no validation, no retry). */
export interface LoadedAgentPrompt {
  body: string;
  output: AgentOutputSpec | null;
}

/** Read an agent .md, split frontmatter from body, and lift the
 *  `output:` field out of the frontmatter into a typed spec. Bad
 *  frontmatter is logged but does not throw — a malformed prompt
 *  shouldn't kill backend boot. */
export function loadAgentPrompt(relPath: string): LoadedAgentPrompt {
  const path = fileURLToPath(new URL(`../../agents/builtin/${relPath}`, import.meta.url));
  try {
    const raw = readFileSync(path, "utf8");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    if (!m) return { body: raw.trim(), output: null };
    const [, frontmatterRaw, body] = m;
    let output: AgentOutputSpec | null = null;
    try {
      const fm = parseYaml(frontmatterRaw!) as { output?: unknown };
      // Silent at load-time: a malformed spec means the agent gets
      // no validation. The agent editor uses validateOutputSpec
      // directly so the user sees structured errors before saving.
      output = validateOutputSpec(fm?.output).spec;
    } catch (err) {
      log.warn("orchestrator.pipeline.frontmatter_parse_failed", { path, error: String(err) });
    }
    return { body: (body ?? "").trim(), output };
  } catch (err) {
    log.error("orchestrator.pipeline.prompt_read_failed", { path, error: String(err) });
    return { body: "", output: null };
  }
}

/** Per-agent prompt bodies + output specs used by the pipeline runner.
 *  Loaded once at module init; restart the backend to pick up edits. */
export const PIPELINE_AGENTS: Record<string, LoadedAgentPrompt> = {
  // Code-task pipeline agents (gated behind the pipeline_runner_v2
  // setting until the v2 runner is the default for code tasks).
  "plan-coder":             loadAgentPrompt("plan/planner.md"),
  "coder":                  loadAgentPrompt("code/coder.md"),
  // PR-review pipeline agents.
  "pr-spec-intake":         loadAgentPrompt("review/pr-spec-intake.md"),
  "solution-explorer":      loadAgentPrompt("review/solution-explorer.md"),
  "reviewer-coder":         loadAgentPrompt("review/reviewer-coder.md"),
  "review-security":        loadAgentPrompt("review/reviewer-security.md"),
  "reviewer-performance":   loadAgentPrompt("review/reviewer-performance.md"),
  "reviewer-architecture":  loadAgentPrompt("review/reviewer-architecture.md"),
  "synthesizer":            loadAgentPrompt("review/synthesizer.md"),
};

/** Back-compat alias — string-only view of the loaded agents. The
 *  runner reads bodies through this map, output specs through
 *  PIPELINE_AGENTS directly. */
export const PIPELINE_AGENT_PROMPTS: Record<string, string> = Object.fromEntries(
  Object.entries(PIPELINE_AGENTS).map(([slug, loaded]) => [slug, loaded.body]),
);

/** Lookup the output spec for an agent slug. Used by the generic
 *  verify endpoint to validate against the same schema the runner
 *  uses post-reply. Returns null when the agent has no spec. */
export function getAgentOutputSpec(slug: string): AgentOutputSpec | null {
  return PIPELINE_AGENTS[slug]?.output ?? null;
}

/** Optional context the runner threads in for code-task phases.
 *  cycleCount lets the review phase show "this is cycle 2 of 3"
 *  history; priorReviewerFeedback lets it remind the reviewer what
 *  they said last time so they can verify the coder addressed it. */
export interface PhaseMessageContext {
  cycleCount?: number;
  priorReviewerFeedback?: string;
}

/** Build the user message for one (phase, agent) pair. Earlier
 *  phases' outputs are pulled from task_phase_outputs and stitched
 *  in. Returns the raw input_payload for unknown phases. */
export function buildPipelinePhaseMessage(
  task: TaskRow,
  phase: PhaseDef,
  agentSlug: string,
  ctx: PhaseMessageContext = {},
): string {
  const taskId = task.id;
  const prInput = task.input_payload;

  // ─── Code-task phases ─────────────────────────────────────────────
  if (phase.id === "plan") {
    return [
      "# Spec",
      "",
      "```markdown",
      task.input_payload,
      "```",
      "",
      "# Your task",
      "",
      `Explore the worktree. Map the files the coder will need to read and the files likely to change. Write \`.agent-notes/${taskId}.md\` with the sections from your role prompt, then reply with the YAML summary block specified in your prompt — nothing else.`,
    ].join("\n");
  }

  if (phase.id === "code") {
    return [
      `# Task: ${task.title}`,
      "",
      task.input_payload,
      "",
      "Begin.",
    ].join("\n");
  }

  if (phase.id === "review") {
    const diff = task.worktree_path
      ? captureDiff(task.worktree_path, task.worktree_base_ref ?? "HEAD")
      : "_(no worktree — diff unavailable)_";
    const cycleCount = ctx.cycleCount ?? 0;
    const historyBlock =
      cycleCount > 0
        ? `\n\n# Review history\n\nThis is review cycle **${cycleCount + 1}**. Previous feedback was:\n\n> ${
            (ctx.priorReviewerFeedback ?? "(none recorded)")
              .split("\n")
              .map((l) => l.trim())
              .filter(Boolean)
              .join("\n> ")
          }\n\nDid the coder address it? If not, send back again. If they addressed it but introduced new problems, send back with the new problems. Otherwise accept.`
        : "";
    return [
      "# Review request",
      "",
      "# Spec",
      "",
      "```markdown",
      task.input_payload,
      "```",
      "",
      "# Coder's diff",
      "",
      diff + historyBlock,
      "",
      "# Your task",
      "",
      "Decide: `accept` or `send_back`. Reply with the YAML block specified in your role prompt — nothing else.",
    ].join("\n");
  }

  // ─── PR-review pipeline phases ────────────────────────────────────
  if (phase.id === "intake") return prInput;

  if (phase.id === "explore") {
    const intake = getPhaseOutput(taskId, "intake");
    return [
      "# Spec (from pr-spec-intake)",
      "",
      intake?.output_md ?? "_(intake produced no spec — fall back to the PR body below)_",
      "",
      "---",
      "",
      "# PR + diff",
      "",
      prInput,
    ].join("\n");
  }

  if (phase.id === "deep-review") {
    const intake = getPhaseOutput(taskId, "intake");
    const explore = getPhaseOutput(taskId, "explore");
    const focusByAgent: Record<string, string> = {
      "review-security": "security",
      "reviewer-performance": "performance",
      "reviewer-architecture": "architecture",
      "reviewer-coder": "bugs and correctness",
    };
    const focus = focusByAgent[agentSlug] ?? agentSlug;
    return [
      `# Your specialty: ${focus}`,
      "",
      "Read the spec, then the diff. Output findings in the YAML shape your role prompt specifies. High signal only.",
      "",
      "---",
      "",
      "# Spec (from pr-spec-intake)",
      "",
      intake?.output_md ?? "_(no spec captured)_",
      "",
      "# Solution explorer's verdict",
      "",
      explore?.output_md ?? "_(no explorer output)_",
      "",
      "---",
      "",
      "# PR + diff",
      "",
      prInput,
    ].join("\n");
  }

  if (phase.id === "synthesis") {
    const out = getPhaseOutput(taskId, "deep-review");
    return [
      "# Reviewer outputs to synthesize",
      "",
      out?.output_md ?? "_(no reviewer outputs captured)_",
    ].join("\n");
  }

  return prInput;
}
