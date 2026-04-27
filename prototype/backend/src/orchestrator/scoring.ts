/**
 * Difficulty scoring. Spec: docs/16-model-performance-metrics.md.
 *
 * Runs once at task creation as a one-shot LLM call: open a session, send
 * the calibration anchors + the task's spec, parse "<int>\n<justification>"
 * from the reply, persist into tasks.difficulty / difficulty_justification.
 *
 * Best-effort. Fire-and-forget at the create endpoint so failures don't
 * block task creation; difficulty stays NULL and the UI shows "—".
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getEngine } from "../engine/singleton";
import { getTask, setTaskDifficulty, type TaskRow } from "../db/tasks";
import { log } from "../log";

const CALIBRATION_PATH = fileURLToPath(
  new URL("../../agents/builtin/_scoring/calibration.md", import.meta.url),
);

/** Read once at module load; cheap, ~1KB. The user can hot-edit by
 *  restarting the backend — we deliberately don't poll. */
const CALIBRATION = (() => {
  try {
    return readFileSync(CALIBRATION_PATH, "utf8");
  } catch (e) {
    log.error("scoring.calibration.read_failed", { error: String(e), path: CALIBRATION_PATH });
    return "";
  }
})();

/** Hard cap so a slow / wedged scoring call can't pile up forever. */
const SCORE_TIMEOUT_MS = 60_000;

/**
 * Build the prompt sent to the scoring agent. Output protocol is rigid
 * so parsing stays deterministic: line 1 = integer, line 2 = justification.
 */
function buildPrompt(task: TaskRow): string {
  const spec = task.input_payload.slice(0, 6000); // cap pathological inputs
  return `You are a difficulty scorer. Your only job is to read a task and pick an integer 1–10 for how hard it will be to implement.

Use these calibration anchors. Map the task onto the closest anchor and pick its number.

${CALIBRATION || "(calibration anchors missing — use your best judgement)"}

# The task

Workspace: ${task.workspace}
Title: ${task.title}

Spec:
\`\`\`
${spec}
\`\`\`

# Output format — strict

Reply with EXACTLY two lines and nothing else:

1. line 1: the integer 1–10
2. line 2: one short sentence (under 100 characters) saying why

Example:
\`\`\`
4
Adds a small handler to an existing endpoint, no schema change.
\`\`\`

Do not include any other text, headings, or markdown.`;
}

/** Parse the rigid two-line reply. Returns null on anything we don't
 *  recognise — caller treats that as "score unavailable". */
function parseScore(reply: string): { difficulty: number; justification: string } | null {
  // Strip leading code-fence noise ("```") sometimes emitted despite the prompt.
  const cleaned = reply
    .replace(/```[a-z]*\n?/gi, "")
    .replace(/```/g, "")
    .trim();
  const lines = cleaned.split("\n").map((s) => s.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  const n = Number(lines[0]);
  if (!Number.isInteger(n) || n < 1 || n > 10) return null;
  const justification = (lines[1] ?? "").slice(0, 280);
  return { difficulty: n, justification };
}

/**
 * Score a single task. Best-effort: logs and returns on any failure.
 * Skips if the task already has a user override.
 */
export async function scoreTask(taskId: string): Promise<void> {
  const task = getTask(taskId);
  if (!task) {
    log.warn("scoring.task_not_found", { taskId });
    return;
  }
  if (task.difficulty_overridden_by_user === 1) {
    log.info("scoring.skipped_user_override", { taskId });
    return;
  }

  // Background workspace gets a flat 2 per the spec — most background work
  // is small and the LLM hop isn't worth the latency.
  if (task.workspace === "background") {
    setTaskDifficulty(taskId, 2, "Background work — auto-scored.");
    log.info("scoring.background_default", { taskId });
    return;
  }

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    log.warn("scoring.engine_unavailable", { taskId, error: String(err) });
    return;
  }

  let session;
  try {
    session = await engine.openSession({ title: `score:${taskId}` });
  } catch (err) {
    log.warn("scoring.open_session_failed", { taskId, error: String(err) });
    return;
  }

  // Collect the assistant text by tracking each text part's latest content.
  // opencode emits cumulative text per part-update; we keep the latest per
  // part id and concatenate at the end in arrival order.
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

  // Race the pump against a hard timeout.
  const timeoutMs = SCORE_TIMEOUT_MS;
  const timeout = new Promise<void>((resolve) =>
    setTimeout(() => {
      if (!done) log.warn("scoring.timed_out", { taskId, timeoutMs });
      resolve();
    }, timeoutMs),
  );

  try {
    await session.send(buildPrompt(task));
    await Promise.race([pump, timeout]);
  } catch (err) {
    log.warn("scoring.send_failed", { taskId, error: String(err) });
  } finally {
    try {
      await session.close();
    } catch {
      /* fine */
    }
  }

  const reply = partOrder.map((id) => partText.get(id) ?? "").join("");
  const parsed = parseScore(reply);
  if (!parsed) {
    log.warn("scoring.parse_failed", { taskId, replyHead: reply.slice(0, 200) });
    return;
  }
  setTaskDifficulty(taskId, parsed.difficulty, parsed.justification);
  log.info("scoring.done", {
    taskId,
    difficulty: parsed.difficulty,
    justification: parsed.justification,
  });
}
