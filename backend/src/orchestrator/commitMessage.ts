/**
 * Compile a Conventional Commits message from a finished task. Runs as
 * a one-shot LLM call when the task transitions to Ready (reviewer
 * accepted) — by the time the user opens the finalize panel, the
 * message is sitting in tasks.proposed_commit_message and surfaces as
 * an editable textarea. The user is free to rewrite it before commit.
 *
 * Best-effort: any failure leaves the column null and the finalize UI
 * falls back to the task title (legacy behaviour).
 */

import { spawnSync } from "node:child_process";
import { getEngine } from "../engine/singleton";
import { getTask, setProposedCommitMessage, type TaskRow } from "../db/tasks";
import { log } from "../log";

const COMMIT_MSG_TIMEOUT_MS = 90_000;
const MAX_DIFF_CHARS = 18_000;

/** Read the agent's working-tree changes vs the recorded base ref.
 *  Falls back to HEAD when no base ref is set. Truncated to keep the
 *  prompt within sensible token bounds. */
function captureDiff(task: TaskRow): { numstat: string; patch: string } | null {
  const cwd = task.worktree_path;
  if (!cwd) return null;
  const base = task.worktree_base_ref || "HEAD";
  const numstatRes = spawnSync("git", ["diff", base, "--numstat"], {
    cwd,
    encoding: "utf8",
  });
  const patchRes = spawnSync(
    "git",
    ["diff", base, "--no-color", "--unified=2"],
    { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (numstatRes.status !== 0 && patchRes.status !== 0) return null;
  let patch = patchRes.stdout || "";
  if (patch.length > MAX_DIFF_CHARS) {
    patch = patch.slice(0, MAX_DIFF_CHARS) + "\n...[truncated]";
  }
  return { numstat: numstatRes.stdout || "", patch };
}

function buildPrompt(task: TaskRow, diff: { numstat: string; patch: string }): string {
  const spec = task.input_payload.slice(0, 4_000);
  return `You are writing a single git commit message for an already-finished change. Output one Conventional Commits message and nothing else.

# Spec the user authored
\`\`\`
${spec}
\`\`\`

# What changed (numstat)
\`\`\`
${diff.numstat || "(numstat unavailable)"}
\`\`\`

# Diff
\`\`\`diff
${diff.patch || "(no diff captured)"}
\`\`\`

# Output format — strict

A single Conventional Commits message:

\`\`\`
<type>(<optional scope>): <subject ≤ 72 chars, imperative, no trailing period>

<optional body — wrapped at ~72 chars, explains the why; omit when the subject is enough>
\`\`\`

Rules:
- type ∈ {feat, fix, refactor, docs, test, chore, perf, build, ci, style}.
- Pick scope from the most-touched path segment when one dominates; otherwise omit it.
- Imperative mood ("add", not "added"/"adds"). Lowercase subject.
- Body is optional. Use it only when the *why* isn't obvious from the subject and the diff.
- No trailers, no "Co-Authored-By", no markdown fences in the output.

Reply with only the commit message — no preface, no quoting, no explanation.`;
}

/** Strip surrounding code fences / inline noise. The prompt asks for
 *  "no fences" but models still emit them sometimes; tolerate. */
function cleanMessage(reply: string): string {
  let text = reply.trim();
  // Strip a leading fence ``` or ```anything
  text = text.replace(/^```[a-z-]*\n?/i, "").replace(/```$/m, "").trim();
  // Drop a leading "commit message:" preface if the model added one.
  text = text.replace(/^(commit message:|message:)\s*/i, "").trim();
  return text;
}

/** Validate that the message looks like Conventional Commits. Returns
 *  the message back when ok, or null when it's clearly off-format. */
function validateConventional(msg: string): string | null {
  if (!msg) return null;
  const firstLine = msg.split("\n", 1)[0]!;
  // Subject: <type>(<scope>)?: <subject>
  if (!/^(feat|fix|refactor|docs|test|chore|perf|build|ci|style)(\([^)]+\))?: .+/i.test(firstLine)) {
    return null;
  }
  if (firstLine.length > 100) return null; // sanity cap; spec says ≤72 but allow some slack
  return msg;
}

/** Run the LLM to compose a commit message and persist it on the task.
 *  Idempotent: skips if proposed_commit_message is already set unless
 *  `force=true`. Best-effort — never throws. */
export async function composeCommitMessage(
  taskId: string,
  opts: { force?: boolean } = {},
): Promise<string | null> {
  const task = getTask(taskId);
  if (!task) {
    log.warn("commitMessage.task_not_found", { taskId });
    return null;
  }
  if (!opts.force && task.proposed_commit_message) {
    return task.proposed_commit_message;
  }
  if (!task.worktree_path) {
    log.info("commitMessage.no_worktree", { taskId });
    return null;
  }

  const diff = captureDiff(task);
  if (!diff || (!diff.patch.trim() && !diff.numstat.trim())) {
    log.info("commitMessage.empty_diff", { taskId });
    return null;
  }

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    log.warn("commitMessage.engine_unavailable", { taskId, error: String(err) });
    return null;
  }

  let session;
  try {
    session = await engine.openSession({ title: `commit-msg:${taskId}` });
  } catch (err) {
    log.warn("commitMessage.open_session_failed", { taskId, error: String(err) });
    return null;
  }

  // Same text-collection pattern as scoring.ts: opencode emits cumulative
  // text per part, so we keep the latest per id and concatenate in
  // arrival order.
  const partOrder: string[] = [];
  const partText = new Map<string, string>();
  let done = false;

  const pump = (async () => {
    for await (const ev of session!.events) {
      if (ev.type === "message.part.updated") {
        const part = (ev.raw as {
          properties?: { part?: { id?: string; type?: string; text?: string } };
        }).properties?.part;
        if (part?.type === "text" && typeof part.text === "string" && part.id) {
          if (!partText.has(part.id)) partOrder.push(part.id);
          partText.set(part.id, part.text);
        }
      }
      if (ev.type === "session.idle" || ev.type === "session.error") {
        done = true;
        return;
      }
    }
  })();

  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      if (!done) {
        log.warn("commitMessage.timed_out", { taskId, timeoutMs: COMMIT_MSG_TIMEOUT_MS });
      }
      resolve();
    }, COMMIT_MSG_TIMEOUT_MS),
  );

  try {
    await session.send(buildPrompt(task, diff));
    await Promise.race([pump, timeout]);
  } catch (err) {
    log.warn("commitMessage.send_failed", { taskId, error: String(err) });
  } finally {
    try {
      await session.close();
    } catch {
      /* fine */
    }
  }

  const reply = partOrder.map((id) => partText.get(id) ?? "").join("");
  const cleaned = cleanMessage(reply);
  const valid = validateConventional(cleaned);
  if (!valid) {
    log.warn("commitMessage.invalid", { taskId, replyHead: reply.slice(0, 200) });
    return null;
  }
  setProposedCommitMessage(taskId, valid);
  log.info("commitMessage.done", { taskId, subject: valid.split("\n", 1)[0] });
  return valid;
}
