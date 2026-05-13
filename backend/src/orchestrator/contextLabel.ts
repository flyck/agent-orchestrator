import { getEngine } from "../engine/singleton";
import { getTask, listTasks } from "../db/tasks";
import { setContextSwitchLabel, type ContextSwitchRow } from "../db/contextSwitches";
import { log } from "../log";

const LABEL_TIMEOUT_MS = 30_000;

function buildPrompt(taskTitle: string, otherTitles: string[]): string {
  const others =
    otherTitles.length > 0
      ? otherTitles.map((t) => `- ${t}`).join("\n")
      : "(no other open tasks)";

  return `The user marked a task as a "context switch". Give it a short label (2–4 words) describing the context / domain.

The task: "${taskTitle}"

Other open tasks at the time:
${others}

Reply with ONLY the label, nothing else. Examples:
- "auth refactor"
- "payment bug"
- "onboarding flow"
- "infra migration"

Label:`;
}

function parseLabel(reply: string): string | null {
  const cleaned = reply.trim().replace(/^["']|["']$/g, "").slice(0, 80);
  if (!cleaned) return null;
  return cleaned;
}

export async function generateContextLabel(record: ContextSwitchRow): Promise<void> {
  // Manual navbar entries land in context_switches with task_id=NULL and
  // already carry the user's literal label — nothing to label here.
  if (!record.task_id) return;
  const taskId = record.task_id;
  const task = getTask(taskId);
  if (!task) {
    log.warn("context_label.task_not_found", { taskId });
    return;
  }

  const allTasks = listTasks({});
  const otherTitles = allTasks
    .filter((t) => t.id !== taskId && t.status !== "done" && t.status !== "failed" && t.status !== "canceled")
    .map((t) => t.title);

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    log.warn("context_label.engine_unavailable", { error: String(err) });
    return;
  }

  let session;
  try {
    session = await engine.openSession({ title: `ctx-label:${record.id}` });
  } catch (err) {
    log.warn("context_label.open_failed", { error: String(err) });
    return;
  }

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
      if (!done) log.warn("context_label.timed_out", { ctxId: record.id });
      resolve();
    }, LABEL_TIMEOUT_MS),
  );

  try {
    await session.send(buildPrompt(task.title, otherTitles));
    await Promise.race([pump, timeout]);
  } catch (err) {
    log.warn("context_label.send_failed", { error: String(err) });
  } finally {
    try {
      await session.close();
    } catch {
      /* fine */
    }
  }

  const reply = partOrder.map((id) => partText.get(id) ?? "").join("");
  const label = parseLabel(reply);
  if (label) {
    setContextSwitchLabel(record.id, label);
    log.info("context_label.done", { ctxId: record.id, label });
  } else {
    log.warn("context_label.parse_failed", { ctxId: record.id, reply: reply.slice(0, 120) });
  }
}
