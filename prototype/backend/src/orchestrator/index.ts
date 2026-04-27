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
import {
  clearNeedsFeedback,
  getTask,
  setLastSessionId,
  setTaskBaseRef,
  setTaskProgress,
  setWorktree,
  updateTaskStatus,
  type TaskRow,
} from "../db/tasks";
import { incrementCompletedSinceNudge } from "../db/settings";
import { createWorktree, findRepoRoot as findRoot } from "./worktree";
import * as queue from "../queue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordUsageEvent } from "../db/usageEvents";
import { log } from "../log";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  while (cur !== "/" && cur !== "") {
    if (existsSync(join(cur, ".git"))) return cur;
    cur = dirname(cur);
  }
  return null;
}

function captureHeadSha(): string | null {
  const root = findRepoRoot(import.meta.dir);
  if (!root) return null;
  const r = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) return null;
  return r.stdout.trim() || null;
}

interface ActiveTask {
  taskId: string;
  session: EngineSession;
  listeners: Set<(e: EngineEvent) => void>;
  pump: Promise<void>;
  /** Wall-clock of the last engine event we saw for this run. Drives
   *  the watchdog's "no events in N seconds" check. */
  lastEventTs: number;
  /** Set when forceComplete is called. The pump's finally reads this and
   *  uses status=done/state=ready instead of canceled — without this flag
   *  the pump's finally and forceComplete race to write the task status,
   *  and the loser's value sticks. */
  forceCompleted?: boolean;
}

const REPO_ROOT = resolve(import.meta.dir, "../../../..");

function backendUrl(): string {
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

function renderSharedPrompt(taskId: string, cwd: string): string {
  return SHARED_PROMPT_TEMPLATE.replaceAll("{{TASK_ID}}", taskId)
    .replaceAll("{{BASE_URL}}", backendUrl())
    .replaceAll("{{REPO_ROOT}}", cwd);
}

function buildSystemPrompt(taskId: string, cwd: string): string {
  return `${renderSharedPrompt(taskId, cwd)}

---

# Role

You are an autonomous coding agent. Your working directory is \`${cwd}\`. Treat that path as the root of the project — read the files there to understand what kind of codebase it is (language, framework, conventions), then make the change the user is asking for.

Use the file-editing tools available to you. Keep the change scoped — touch only what the task asks for. Prefer surgical edits over rewrites.

# Do NOT run git

Do not run \`git add\`, \`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`, or any other git command. Even if your bash tool would let you. The orchestrator owns this worktree's branch and will commit your edits when the user clicks Finalize. If you commit yourself you'll create messages the user didn't write and confuse the finalize step. Just edit the files; leave them uncommitted.

When you are done, summarize what you changed in 2-3 sentences. The user reviews via Finalize → Commit to current branch / new branch.`;
}

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

/**
 * Public entry. Routes through the job queue: if there's free capacity
 * the run starts immediately and we return the session id; otherwise
 * the task is marked queued and the dispatcher picks it up later.
 * Returns null when queued.
 */
export async function startRun(
  taskId: string,
  opts: { followUp?: string } = {},
): Promise<{ sessionId: string } | null> {
  return queue.submit(taskId, () => startRunInternal(taskId, opts));
}

/** Actual run kickoff. Called by the queue once a slot is free. */
async function startRunInternal(
  taskId: string,
  opts: { followUp?: string } = {},
): Promise<{ sessionId: string }> {
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
    isFollowUp: !!opts.followUp,
  });

  // If we're resuming a Ready task with new feedback, reset progress so the
  // bar starts fresh and clear the terminal status.
  if (opts.followUp) {
    setTaskProgress(taskId, { step: null, total: null, label: null });
  }
  // Always clear the needs-feedback flag at run start; the agent gets a
  // fresh chance to signal it again if the situation hasn't changed.
  if (task.needs_feedback) {
    clearNeedsFeedback(taskId);
    task.needs_feedback = 0;
    task.feedback_question = null;
  }

  // ── Worktree setup ─────────────────────────────────────────────────
  // First run: create a fresh worktree branched from the parent repo's
  // current HEAD onto agent/<task>. Follow-up runs reuse the existing
  // worktree so the agent picks up where it left off. The diff for the
  // task is then naturally scoped to the worktree's branch — main can
  // move on freely without polluting the view.
  if (!task.worktree_path) {
    const parentRoot = findRoot(import.meta.dir);
    if (!parentRoot) {
      const msg = "no .git found above backend dir — cannot create worktree";
      log.error("orchestrator.run.worktree_no_repo", { taskId });
      updateTaskStatus(taskId, "failed", task.current_state);
      throw new Error(msg);
    }
    const sha = captureHeadSha();
    if (!sha) {
      log.error("orchestrator.run.worktree_no_head", { taskId });
      updateTaskStatus(taskId, "failed", task.current_state);
      throw new Error("could not resolve parent HEAD for worktree base");
    }
    try {
      const wt = createWorktree({ taskId, parentRoot, baseRef: sha });
      setWorktree(taskId, { path: wt.path, branch: wt.branch, baseRef: wt.baseRef });
      task.worktree_path = wt.path;
      task.worktree_branch = wt.branch;
      task.worktree_base_ref = wt.baseRef;
    } catch (err) {
      log.error("orchestrator.run.worktree_create_failed", {
        taskId,
        error: String(err),
      });
      updateTaskStatus(taskId, "failed", task.current_state);
      throw err;
    }
  } else {
    log.info("orchestrator.run.worktree_reused", {
      taskId,
      path: task.worktree_path,
      branch: task.worktree_branch,
    });
  }

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
    session = await engine.openSession({
      title: task.title,
      cwd: task.worktree_path ?? undefined,
    });
    setLastSessionId(taskId, session.id);
    log.info("orchestrator.run.session_opened", {
      taskId,
      sessionId: session.id,
      cwd: task.worktree_path,
    });
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
    lastEventTs: Date.now(),
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
        a.lastEventTs = ev.ts;
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
      if (terminal === null) {
        // The iterator exited without seeing session.idle/error — the queue
        // got closed externally (bus reconnect raced, manual shutdown, etc.).
        // Don't fake a "done" green-light; mark canceled so the user can
        // resend instead of trusting a misleading green state.
        log.warn("orchestrator.run.iterator_closed_unexpectedly", {
          taskId,
          eventCount,
        });
      }
      try {
        await session.close();
      } catch (e) {
        log.warn("orchestrator.run.close_failed", { taskId, error: String(e) });
      }
      active.delete(taskId);
      // If forceComplete was called, treat as a clean finish. Otherwise
      // null terminal = canceled (queue closed externally), error =
      // failed, idle = done.
      const wasForced = a.forceCompleted === true;
      const finalStatus =
        terminal === "error"
          ? "failed"
          : wasForced
            ? "done"
            : terminal === null
              ? "canceled"
              : "done";
      const finalState =
        terminal === "error" || (terminal === null && !wasForced)
          ? task.current_state
          : "ready";
      updateTaskStatus(taskId, finalStatus, finalState);
      // Bump the manual-coding nudge counter on real completions only —
      // failed/canceled runs don't count, so the user sees the nudge after
      // N actually-shipped tasks. Force-complete counts too: user decided
      // it was done.
      if (finalStatus === "done") {
        try {
          const n = incrementCompletedSinceNudge();
          log.info("orchestrator.run.nudge_counter_bumped", { taskId, completed: n });
        } catch (err) {
          log.warn("orchestrator.run.nudge_counter_failed", { taskId, error: String(err) });
        }
      }
      // Tell the queue we're done so it can promote the next pending task.
      queue.release(taskId);
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
    const cwd = task.worktree_path ?? REPO_ROOT;
    await session.send(buildInitialMessage(task, opts.followUp), {
      system: buildSystemPrompt(taskId, cwd),
    });
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

function buildInitialMessage(task: TaskRow, followUp?: string): string {
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

/**
 * Watchdog: every 15s, scan active tasks. For any whose pump hasn't
 * received an event in WATCHDOG_STALE_MS, query opencode directly to
 * see whether the agent has actually finished. If so, force-complete
 * so the user gets a real "ready" instead of a stuck "running".
 *
 * Catches the bus-drop-loses-terminal-event class of bug: opencode
 * emitted session.idle while our SSE was reconnecting; we missed it;
 * pump waits forever. The watchdog notices and recovers.
 */
const WATCHDOG_STALE_MS = 30_000;
const WATCHDOG_INTERVAL_MS = 15_000;

async function watchdogTick(): Promise<void> {
  const now = Date.now();
  for (const a of [...active.values()]) {
    if (now - a.lastEventTs < WATCHDOG_STALE_MS) continue;
    log.info("orchestrator.watchdog.checking", {
      taskId: a.taskId,
      sessionId: a.session.id,
      silentMs: now - a.lastEventTs,
    });
    try {
      const engine = await getEngine();
      const messages = (await engine.getSessionMessages(a.session.id, 5)) as Array<{
        info?: { role?: string; finish?: string; error?: unknown; cost?: number };
      }>;
      const last = messages.at(-1);
      const lastInfo = last?.info;
      if (lastInfo?.role === "assistant" && (lastInfo.finish || lastInfo.error)) {
        log.warn("orchestrator.watchdog.recovered", {
          taskId: a.taskId,
          finish: lastInfo.finish,
          hadError: !!lastInfo.error,
        });
        // Use the public force-complete path so the queue slot also
        // releases and the next pending task can promote.
        await forceComplete(a.taskId);
      } else {
        log.info("orchestrator.watchdog.still_working", { taskId: a.taskId });
      }
    } catch (err) {
      log.warn("orchestrator.watchdog.poll_failed", {
        taskId: a.taskId,
        error: String(err),
      });
    }
  }
}

let watchdogTimer: ReturnType<typeof setInterval> | null = null;
export function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    watchdogTick().catch((e) => log.error("orchestrator.watchdog.tick_failed", { error: String(e) }));
  }, WATCHDOG_INTERVAL_MS);
  log.info("orchestrator.watchdog.started", { intervalMs: WATCHDOG_INTERVAL_MS });
}

/**
 * On backend boot: any task left in `queued` status from the previous
 * run can be promoted back into the in-memory queue so the dispatcher
 * resumes them automatically. We re-submit each via startRun, which
 * re-routes through the queue.
 */
export async function resumeQueuedTasks(): Promise<void> {
  // Imported lazily to avoid a circular dep at module init.
  const { listTasks } = await import("../db/tasks");
  const queued = listTasks({ status: "queued" });
  if (queued.length === 0) return;
  log.info("orchestrator.boot.resume_queued", { count: queued.length });
  for (const t of queued) {
    try {
      await startRun(t.id);
      log.info("orchestrator.boot.resumed", { taskId: t.id });
    } catch (e) {
      log.error("orchestrator.boot.resume_failed", { taskId: t.id, error: String(e) });
    }
  }
}

export async function sendUserMessage(taskId: string, text: string): Promise<void> {
  const a = active.get(taskId);
  if (!a) throw new Error(`task not running: ${taskId}`);
  log.info("orchestrator.user_message", { taskId, len: text.length });
  await a.session.send(text);
}

/**
 * Force-terminate a stuck run. Closes the engine session (which closes
 * the EventQueue → pump exits → pump finally calls queue.release), then
 * stamps the task done. Also purges from the queue in case the task was
 * a pending entry (slot would otherwise leak).
 */
export async function forceComplete(taskId: string): Promise<void> {
  const a = active.get(taskId);
  if (!a) {
    log.info("orchestrator.force_complete.not_active", { taskId });
    queue.purge(taskId);
    updateTaskStatus(taskId, "done", "ready");
    return;
  }
  log.info("orchestrator.force_complete.requested", { taskId });
  // Mark BEFORE closing the session so the pump's finally (which races us
  // because closing the session resolves the for-await iterator) sees
  // the flag and skips writing canceled/spec.
  a.forceCompleted = true;
  try {
    await a.session.close();
  } catch (e) {
    log.warn("orchestrator.force_complete.close_failed", { taskId, error: String(e) });
  }
  // Defensive purge — the pump's finally also calls queue.release, but if
  // the pump is wedged hard enough it may not run promptly.
  queue.purge(taskId);
}
