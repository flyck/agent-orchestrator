/**
 * Prompt builders. Pure functions extracted from `orchestrator/index.ts`
 * during the refactor pass — they have no orchestrator state, no shared
 * mutable globals beyond the read-once template, and reviewer.ts already
 * receives `buildSystemPrompt` via dep-injection. Keeping them here
 * isolates the agent-prompt surface from the lifecycle logic.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { log } from "../log";
import { readAllSettings } from "../db/settings";
import { listSkills, renderSkillsSection } from "./skills";
import { renderRepoContext } from "./repoContext";
import type { TaskRow } from "../db/tasks";

/** The local backend URL agents curl into for /scoring, /alternatives,
 *  /progress, etc. Exported so non-shared prompts (e.g. reviewer body)
 *  can substitute {{BASE_URL}} the same way the shared template does. */
export function backendUrl(): string {
  const port = Number(process.env.PORT ?? 3000);
  return `http://localhost:${port}`;
}

const SHARED_PROMPT_PATH = fileURLToPath(
  new URL("../../agents/builtin/_shared/systemprompt.md", import.meta.url),
);

/** Read once at startup; cheap, ~3KB, no file watching needed. */
const SHARED_PROMPT_TEMPLATE = (() => {
  try {
    return readFileSync(SHARED_PROMPT_PATH, "utf8");
  } catch (e) {
    log.error("orchestrator.shared_prompt.read_failed", {
      error: String(e),
      path: SHARED_PROMPT_PATH,
    });
    return "";
  }
})();

export function renderSharedPrompt(taskId: string, cwd: string): string {
  return SHARED_PROMPT_TEMPLATE.replaceAll("{{TASK_ID}}", taskId)
    .replaceAll("{{BASE_URL}}", backendUrl())
    .replaceAll("{{REPO_ROOT}}", cwd);
}

/**
 * Skills + repo-context blocks concatenated. Used by every agent's
 * system prompt — coder, reviewer, planner — so they all see the same
 * ambient project background. Cheap to compute (one stat + a few file
 * reads) so we recompute per-run rather than caching.
 */
export function ambientContext(cwd: string): string {
  const settings = readAllSettings();
  const skillsSection = renderSkillsSection(listSkills(settings.skills_directory));
  const repoContextSection = settings.repo_context_enabled
    ? renderRepoContext({
        cwd,
        readmeTokenBudget: settings.readme_token_budget,
        backlogTokenBudget: settings.backlog_token_budget,
      })
    : "";
  return `${skillsSection}${repoContextSection}`;
}

export function buildSystemPrompt(taskId: string, cwd: string): string {
  return `${renderSharedPrompt(taskId, cwd)}

---

# Role

You are an autonomous coding agent. Your working directory is \`${cwd}\`. Treat that path as the root of the project — read the files there to understand what kind of codebase it is (language, framework, conventions), then make the change the user is asking for.

Use the file-editing tools available to you. Keep the change scoped — touch only what the task asks for. Prefer surgical edits over rewrites.

# Discovery: read the planner's notes first

Before scanning the repo yourself, open \`${cwd}/.agent-notes/${taskId}.md\` and look for a section headed \`# Planner agent notes\`. The planner ran before you and already mapped:

- Which files to read first (and why)
- Which files are likely to change
- The approach to take, broken into coarse steps
- Open questions / decisions you should be aware of

**Treat that block as your discovery.** Don't re-walk the repo from scratch — open the files the planner pointed at and start work. Only fall back to your own discovery if the \`# Planner agent notes\` section is missing or visibly stale (e.g., it cites files that no longer exist).

After you finish, append your own \`# Coder notes\` section to the same file with what you actually changed and any decisions you made — this is what the reviewer reads next.

# Do NOT run git

Do not run \`git add\`, \`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`, or any other git command. Even if your bash tool would let you. The orchestrator owns this worktree's branch and will commit your edits when the user clicks Finalize. If you commit yourself you'll create messages the user didn't write and confuse the finalize step. Just edit the files; leave them uncommitted.

When you are done, summarize what you changed in 2-3 sentences. The user reviews via Finalize → Commit to current branch / new branch.${ambientContext(cwd)}`;
}

export function buildInitialMessage(task: TaskRow, followUp?: string): string {
  const head = `# Task: ${task.title}

${task.input_payload}`;
  if (!followUp) return `${head}

Begin.`;
  return `${head}

---

# Follow-up from the user

You finished a previous round and the user reviewed the result. They have new feedback, listed below. Read it carefully and revise the change. Discovery (re-reading any files you may have changed) is step 0; pick a fresh step plan and report progress as before.

${followUp}

Begin the revision.`;
}
