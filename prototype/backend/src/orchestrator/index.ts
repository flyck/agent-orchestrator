/**
 * The minimum-viable orchestrator. Right now it just runs ONE engine
 * session per task, sending the task's input_payload as the initial prompt.
 * No planner / parallel reviewers / synthesizer pipeline yet — that's
 * Phase 6 proper. This is enough to prove the wire end-to-end and let the
 * frontend exercise live streaming.
 *
 * Per task it:
 *   1. opens an OpenCode session with cwd at the repo root
 *   2. sends input_payload as the user message + a system prompt that
 *      tells the agent it's working on the agent-orchestrator codebase
 *   3. forwards every engine event to local listeners (SSE clients)
 *   4. transitions task status: queued → running → done | failed
 *      and current_state: spec → build → ready  (we skip plan for v1)
 *   5. logs verbosely so the user can tail the log to debug
 */

import type { EngineEvent, EngineSession } from "../engine/types";
import { OpenCodeSession } from "../engine/opencode";
import { getEngine } from "../engine/singleton";
import { getTask, updateTaskStatus, type TaskRow } from "../db/tasks";
import { recordUsageEvent } from "../db/usageEvents";
import { log } from "../log";
import { resolve } from "node:path";

interface ActiveTask {
  taskId: string;
  session: EngineSession;
  listeners: Set<(e: EngineEvent) => void>;
  pump: Promise<void>;
}

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SYSTEM_PROMPT = `You are an autonomous coding agent working on the \`agent-orchestrator\` repo at \`${REPO_ROOT}\`.

Read the user's task carefully. Use the file-editing tools available to you to make the change. Keep the change scoped — touch only what the task asks for. Prefer surgical edits over rewrites.

When you are done, summarize what you changed in 2-3 sentences. Do not commit; the user will review with \`git diff\` before deciding what to keep.`;

const active = new Map<string, ActiveTask>();

export function getActive(taskId: string): ActiveTask | undefined {
  return active.get(taskId);
}

export function addListener(taskId: string, fn: (e: EngineEvent) => void): () => void {
  const a = active.get(taskId);
  if (!a) throw new Error(`task not running: ${taskId}`);
  a.listeners.add(fn);
  return () => a.listeners.delete(fn);
}

export async function startRun(taskId: string): Promise<{ sessionId: string }> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (active.has(taskId)) {
    log.warn("orchestrator.run.already_active", { taskId });
    return { sessionId: active.get(taskId)!.session.id };
  }

  log.info("orchestrator.run.start", {
    taskId,
    workspace: task.workspace,
    title: task.title,
  });

  let engine;
  try {
    engine = await getEngine();
  } catch (err) {
    log.error("orchestrator.run.engine_start_failed", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    updateTaskStatus(taskId, "failed", task.current_state);
    throw err;
  }

  let session: EngineSession;
  try {
    session = await engine.openSession({ title: task.title });
    log.info("orchestrator.run.session_opened", { taskId, sessionId: session.id });
  } catch (err) {
    log.error("orchestrator.run.open_session_failed", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    updateTaskStatus(taskId, "failed", task.current_state);
    throw err;
  }

  updateTaskStatus(taskId, "running", "build");

  const a: ActiveTask = {
    taskId,
    session,
    listeners: new Set(),
    pump: undefined as unknown as Promise<void>,
  };
  active.set(taskId, a);

  // Pump events from the session into all listeners. Track terminal events
  // so we transition the task accordingly.
  a.pump = (async () => {
    let lastError: unknown = null;
    let eventCount = 0;
    let terminal: "idle" | "error" | null = null;
    try {
      for await (const ev of session.events) {
        eventCount++;
        // Per-event progress log — keep cheap (type + count only).
        log.info("orchestrator.run.event", { taskId, n: eventCount, type: ev.type });

        // Safety net: if opencode still asks for permission despite the
        // session-create ruleset, auto-grant. The user authored the task;
        // we treat that as authorization for any tool call the agent needs.
        if (ev.type === "permission.asked" && session instanceof OpenCodeSession) {
          const reqId = (ev.raw as { properties?: { id?: string } }).properties?.id;
          if (reqId) {
            log.info("orchestrator.run.permission_auto_grant", { taskId, reqId });
            session
              .respondToPermission(reqId, "always")
              .catch((err) =>
                log.error("orchestrator.run.permission_grant_failed", {
                  taskId,
                  reqId,
                  error: String(err),
                }),
              );
          }
        }

        if (ev.type === "session.error") {
          terminal = "error";
          lastError = ev.raw;
          log.error("orchestrator.run.session_error_payload", {
            taskId,
            payload: JSON.stringify(ev.raw).slice(0, 1500),
          });
        }
        if (ev.type === "session.idle") terminal = "idle";
        // Surface any assistant-message error info AND capture usage data
        // when the assistant message finishes (cost + tokens are reported on
        // message.updated for the assistant role once finish is set).
        if (ev.type === "message.updated") {
          const info = (
            ev.raw as {
              properties?: {
                info?: {
                  role?: string;
                  error?: unknown;
                  finish?: string;
                  cost?: number;
                  tokens?: { input?: number; output?: number };
                  modelID?: string;
                  providerID?: string;
                  time?: { completed?: number };
                };
              };
            }
          ).properties?.info;
          if (info?.role === "assistant") {
            if (info.error) {
              log.error("orchestrator.run.assistant_error", {
                taskId,
                error: JSON.stringify(info.error).slice(0, 1500),
              });
            }
            // Persist usage when the message completes with cost/tokens.
            if (
              info.finish &&
              typeof info.cost === "number" &&
              info.providerID &&
              info.modelID
            ) {
              try {
                recordUsageEvent({
                  ts: info.time?.completed ?? ev.ts,
                  task_id: taskId,
                  session_id: ev.sessionId,
                  provider_id: info.providerID,
                  model_id: info.modelID,
                  input_tokens: info.tokens?.input ?? 0,
                  output_tokens: info.tokens?.output ?? 0,
                  cost_usd: info.cost,
                });
                log.info("orchestrator.run.usage_recorded", {
                  taskId,
                  provider: info.providerID,
                  model: info.modelID,
                  cost_usd: info.cost,
                });
              } catch (err) {
                log.warn("orchestrator.run.usage_record_failed", {
                  taskId,
                  error: String(err),
                });
              }
            }
          }
        }
        for (const fn of a.listeners) {
          try {
            fn(ev);
          } catch (e) {
            log.warn("orchestrator.listener_error", { taskId, error: String(e) });
          }
        }
        if (terminal) break;
      }
    } catch (err) {
      log.error("orchestrator.run.pump_failed", {
        taskId,
        error: err instanceof Error ? err.message : String(err),
      });
      lastError = err;
      terminal = "error";
    } finally {
      log.info("orchestrator.run.terminal", { taskId, terminal, eventCount });
      try {
        await session.close();
      } catch (e) {
        log.warn("orchestrator.run.close_failed", { taskId, error: String(e) });
      }
      active.delete(taskId);
      const finalStatus = terminal === "error" ? "failed" : "done";
      const finalState = terminal === "error" ? task.current_state : "ready";
      updateTaskStatus(taskId, finalStatus, finalState);
      const lastErrorStr = lastError
        ? typeof lastError === "string"
          ? lastError.slice(0, 800)
          : JSON.stringify(lastError).slice(0, 800)
        : null;
      log.info("orchestrator.run.done", { taskId, finalStatus, lastError: lastErrorStr });
    }
  })();

  // Send the initial message AFTER setting up the active record + pump so we
  // don't lose early events.
  try {
    await session.send(buildInitialMessage(task), { system: SYSTEM_PROMPT });
    log.info("orchestrator.run.initial_message_sent", { taskId, sessionId: session.id });
  } catch (err) {
    log.error("orchestrator.run.send_failed", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    // The pump will eventually see no events; we trigger fallback failure.
    try {
      await session.close();
    } catch {}
    active.delete(taskId);
    updateTaskStatus(taskId, "failed", task.current_state);
    throw err;
  }

  return { sessionId: session.id };
}

function buildInitialMessage(task: TaskRow): string {
  return `# Task: ${task.title}

${task.input_payload}

Begin.`;
}

export async function cancelRun(taskId: string): Promise<void> {
  const a = active.get(taskId);
  if (!a) {
    log.warn("orchestrator.cancel.not_active", { taskId });
    return;
  }
  log.info("orchestrator.cancel.requested", { taskId });
  try {
    await a.session.cancel();
  } catch (err) {
    log.warn("orchestrator.cancel.failed", { taskId, error: String(err) });
  }
}

export async function sendUserMessage(taskId: string, text: string): Promise<void> {
  const a = active.get(taskId);
  if (!a) throw new Error(`task not running: ${taskId}`);
  log.info("orchestrator.user_message", { taskId, len: text.length });
  await a.session.send(text);
}
