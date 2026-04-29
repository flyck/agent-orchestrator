/**
 * Plan phase. Runs before the coder. The planner agent reads the spec,
 * explores the worktree, and writes `.agent-notes/<TASK_ID>.md` — the
 * execution-context file the coder picks up before editing anything.
 *
 * The planner does NOT edit production code. Its prompt forbids it.
 * Output is a structured YAML summary (files_to_change / approach /
 * notes_path) the user sees in the dashboard; the actual handoff is
 * the notes file the coder reads on its first read.
 *
 * Send-back path: skipped. The user has already added feedback; the
 * notes file from the prior plan run is reused as cache.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EngineSession } from "../engine/types";
import { getEngine } from "../engine/singleton";
import type { TaskRow } from "../db/tasks";
import { log } from "../log";

const PLANNER_PROMPT_PATH = fileURLToPath(
  new URL("../../agents/builtin/plan/planner.md", import.meta.url),
);

function loadPlannerPrompt(): string {
  try {
    const raw = readFileSync(PLANNER_PROMPT_PATH, "utf8");
    const m = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return (m?.[1] ?? raw).trim();
  } catch (err) {
    log.error("orchestrator.planner.prompt_read_failed", {
      error: String(err),
      path: PLANNER_PROMPT_PATH,
    });
    return "You are a planner. Write .agent-notes/<TASK_ID>.md with files-to-read and an approach.";
  }
}

const PLANNER_PROMPT = loadPlannerPrompt();

export function buildPlannerSystemPrompt(baseSharedPrompt: string): string {
  return `${baseSharedPrompt}

---

${PLANNER_PROMPT}`;
}

/**
 * The user message for the planner. Carries the spec verbatim plus a
 * reminder of the cwd (already in the system prompt — repeated here
 * for clarity in the conversation log).
 */
export function buildPlannerMessage(task: TaskRow): string {
  return `# Spec

\`\`\`markdown
${task.input_payload}
\`\`\`

# Your task

Explore the worktree. Map the files the coder will need to read and the
files likely to change. Write \`.agent-notes/${task.id}.md\` with the
sections from your role prompt, then reply with the YAML summary block
specified in your prompt — nothing else.`;
}

/**
 * Open a fresh planner session in the task's worktree. Mirrors the
 * reviewer's openSession shape so the lifecycle controller can treat
 * them symmetrically.
 */
export async function openPlannerSession(
  task: TaskRow,
  taskId: string,
): Promise<EngineSession> {
  const engine = await getEngine();
  const cwd = task.worktree_path ?? undefined;
  const session = await engine.openSession({
    title: `plan:${task.title}`,
    cwd,
  });
  log.info("orchestrator.planner.session_opened", {
    taskId,
    sessionId: session.id,
    cwd,
  });
  return session;
}
