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
  incrementReviewCycles,
  setLastSessionId,
  setLatestInputTokens,
  setTaskBaseRef,
  setTaskProgress,
  setWorktree,
  updateTaskStatus,
  type TaskRow,
} from "../db/tasks";
import { incrementCompletedSinceNudge, readAllSettings } from "../db/settings";
import { listSkills, renderSkillsSection } from "./skills";
import {
  buildPlannerMessage,
  buildPlannerSystemPrompt,
  openPlannerSession,
} from "./planner";
import {
  buildReviewerMessage,
  buildReviewerSystemPrompt,
  MAX_REVIEW_CYCLES,
  openReviewerSession,
  parseReviewerDecision,
} from "./reviewer";
import { createWorktree, findRepoRoot as findRoot } from "./worktree";
import * as queue from "../queue";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { recordUsageEvent } from "../db/usageEvents";
import { recordActivity } from "../db/activities";
import { appendReview } from "../db/reviews";
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
  /** The currently-open session — this swaps when the lifecycle
   *  controller transitions phases (coder → reviewer → coder). The
   *  watchdog and forceComplete both read this slot, so it must always
   *  reflect the in-flight session. */
  session: EngineSession;
  listeners: Set<(e: EngineEvent) => void>;
  /** The lifecycle controller's promise. Resolves when the task ends
   *  (done / failed / canceled). Stored so callers can await it in
   *  tests; nothing else touches it. */
  pump: Promise<void>;
  /** Wall-clock of the last engine event we saw for this run. Drives
   *  the watchdog's "no events in N seconds" check. */
  lastEventTs: number;
  /** Set when forceComplete is called. The lifecycle reads this between
   *  phases (and at the end of the active phase) and bails to done/ready
   *  instead of continuing. */
  forceCompleted?: boolean;
  /** Which agent owns the current session. Drives the lifecycle
   *  controller's branch on terminal. Plan runs first on initial runs;
   *  send-backs skip Plan and start at Code (the planner's notes file
   *  in .agent-notes/<id>.md is the cache). */
  phase: "plan" | "code" | "review";
  /** True when the watchdog detected the engine session finished but
   *  the SSE bus missed the events. Lifecycle treats this as "phase
   *  finished cleanly" and proceeds to the next phase, instead of
   *  bailing to ready (which is what user-triggered force-complete
   *  does). */
  watchdogRecovered?: boolean;
  /** How many times the reviewer has sent the task back to the coder
   *  in *this run*. Capped by MAX_REVIEW_CYCLES. */
  cycleCount: number;
  /** The reviewer's last `feedback:` text — passed back to the coder
   *  on send-back, and surfaced to the next reviewer pass so it can
   *  judge whether the issue was addressed. */
  lastReviewerFeedback?: string;
}

/** What the pump returned when its session reached a terminal state. */
interface PumpResult {
  /** `idle` = clean finish, `error` = session.error event, `null` =
   *  iterator closed externally (cancel / queue tear-down). */
  terminal: "idle" | "error" | null;
  eventCount: number;
  lastError: unknown;
  /** Concatenated assistant text, in arrival order. Only the latest
   *  text per part id is kept (opencode emits cumulative replacements
   *  per part-update). The reviewer phase parses this. */
  assistantText: string;
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
  // Per-run skills lookup — cheap (one stat + a few reads), and lets the
  // user drop a new skill into the directory without restarting backend.
  const settings = readAllSettings();
  const skillsSection = renderSkillsSection(listSkills(settings.skills_directory));

  return `${renderSharedPrompt(taskId, cwd)}

---

# Role

You are an autonomous coding agent. Your working directory is \`${cwd}\`. Treat that path as the root of the project — read the files there to understand what kind of codebase it is (language, framework, conventions), then make the change the user is asking for.

Use the file-editing tools available to you. Keep the change scoped — touch only what the task asks for. Prefer surgical edits over rewrites.

# Do NOT run git

Do not run \`git add\`, \`git commit\`, \`git push\`, \`git checkout\`, \`git branch\`, or any other git command. Even if your bash tool would let you. The orchestrator owns this worktree's branch and will commit your edits when the user clicks Finalize. If you commit yourself you'll create messages the user didn't write and confuse the finalize step. Just edit the files; leave them uncommitted.

When you are done, summarize what you changed in 2-3 sentences. The user reviews via Finalize → Commit to current branch / new branch.${skillsSection}`;
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
  recordActivity("task_run", "agent", taskId, opts.followUp ? "follow-up" : "initial");

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

  // Initial vs. send-back: initial runs go through Plan first so the
  // planner agent populates .agent-notes/<id>.md. Send-backs skip Plan
  // — the cache from the prior pass is the planner's residue, and the
  // user wants the coder to address feedback, not to re-explore.
  const startInPlan = !opts.followUp;
  const initialPhase: ActiveTask["phase"] = startInPlan ? "plan" : "code";

  let session: EngineSession;
  try {
    session = startInPlan
      ? await openPlannerSession(task, taskId)
      : await engine.openSession({
          title: task.title,
          cwd: task.worktree_path ?? undefined,
        });
    setLastSessionId(taskId, session.id);
    log.info("orchestrator.run.session_opened", {
      taskId,
      sessionId: session.id,
      cwd: task.worktree_path,
      phase: initialPhase,
    });
  } catch (err) {
    log.error("orchestrator.run.open_session_failed", {
      taskId,
      error: err instanceof Error ? err.message : String(err),
    });
    updateTaskStatus(taskId, "failed", task.current_state);
    throw err;
  }

  updateTaskStatus(taskId, "running", initialPhase);

  const a: ActiveTask = {
    taskId,
    session,
    listeners: new Set(),
    pump: undefined as unknown as Promise<void>,
    lastEventTs: Date.now(),
    phase: initialPhase,
    cycleCount: 0,
  };
  active.set(taskId, a);

  // Lifecycle controller: pumps the current session, then decides
  // whether to switch to the reviewer, send back to the coder, or
  // finalize. Replaces the old single-session pump.
  a.pump = runLifecycle(a, task);

  // Send the initial message AFTER setting up the active record + pump so we
  // don't lose early events.
  try {
    const cwd = task.worktree_path ?? REPO_ROOT;
    if (startInPlan) {
      const sharedPrompt = renderSharedPrompt(taskId, cwd);
      await session.send(buildPlannerMessage(task), {
        system: buildPlannerSystemPrompt(sharedPrompt),
      });
    } else {
      await session.send(buildInitialMessage(task, opts.followUp), {
        system: buildSystemPrompt(taskId, cwd),
      });
    }
    log.info("orchestrator.run.initial_message_sent", {
      taskId,
      sessionId: session.id,
      phase: initialPhase,
    });
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

/**
 * Pump the active task's CURRENT session until it reaches a terminal
 * state. Forwards events to listeners, auto-grants permissions, persists
 * usage data, and accumulates assistant text (so the reviewer phase can
 * parse the YAML decision). Does NOT close the session or finalize the
 * task — that's the lifecycle controller's job.
 */
async function pumpUntilTerminal(a: ActiveTask): Promise<PumpResult> {
  const taskId = a.taskId;
  const session = a.session; // snapshot at start; switching mid-pump is the
                             // controller's job, not ours
  const phaseLabel = a.phase;
  let lastError: unknown = null;
  let eventCount = 0;
  let terminal: "idle" | "error" | null = null;

  // Per-part text accumulator. opencode emits cumulative text per
  // part-update — keep latest text per part id, then concat in arrival
  // order at the end. Same pattern as scoring.ts.
  const partOrder: string[] = [];
  const partText = new Map<string, string>();

  try {
    for await (const ev of session.events) {
      eventCount++;
      a.lastEventTs = ev.ts;
      log.info("orchestrator.run.event", {
        taskId,
        phase: phaseLabel,
        n: eventCount,
        type: ev.type,
      });

      // Auto-grant permissions — same as before.
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

      // Capture assistant text parts for downstream parsing.
      if (ev.type === "message.part.updated") {
        const part = (
          ev.raw as {
            properties?: { part?: { id?: string; type?: string; text?: string } };
          }
        ).properties?.part;
        if (part?.type === "text" && typeof part.text === "string" && part.id) {
          if (!partText.has(part.id)) partOrder.push(part.id);
          partText.set(part.id, part.text);
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

      // Surface assistant errors AND record usage on completion.
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
          // Surface the live context-window usage on the task card. Captured
          // even on intermediate (non-finish) updates — opencode bumps the
          // input-token count as the model accumulates context within a turn.
          if (typeof info.tokens?.input === "number" && info.tokens.input > 0) {
            try {
              setLatestInputTokens(taskId, info.tokens.input, ev.ts);
            } catch (err) {
              log.warn("orchestrator.run.ctx_update_failed", {
                taskId,
                error: String(err),
              });
            }
          }
          if (info.error) {
            log.error("orchestrator.run.assistant_error", {
              taskId,
              error: JSON.stringify(info.error).slice(0, 1500),
            });
          }
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
                phase: phaseLabel,
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
  }

  log.info("orchestrator.run.terminal", { taskId, phase: phaseLabel, terminal, eventCount });
  if (terminal === null) {
    log.warn("orchestrator.run.iterator_closed_unexpectedly", {
      taskId,
      phase: phaseLabel,
      eventCount,
    });
  }

  const assistantText = partOrder.map((id) => partText.get(id) ?? "").join("");
  return { terminal, eventCount, lastError, assistantText };
}

/** Best-effort session close. Errors are swallowed (logged) so they
 *  can't poison the lifecycle controller's branch decisions. */
async function safeClose(session: EngineSession, taskId: string, why: string): Promise<void> {
  try {
    await session.close();
  } catch (e) {
    log.warn("orchestrator.run.close_failed", { taskId, why, error: String(e) });
  }
}

/** Stamp the task's terminal status + state, bump the nudge counter on
 *  real success, and emit the run.done log. */
function finalizeTask(
  task: TaskRow,
  finalStatus: "done" | "failed" | "canceled",
  finalState: TaskRow["current_state"],
  lastError: unknown,
): void {
  const taskId = task.id;
  updateTaskStatus(taskId, finalStatus, finalState);
  if (finalStatus === "done") {
    try {
      const n = incrementCompletedSinceNudge();
      log.info("orchestrator.run.nudge_counter_bumped", { taskId, completed: n });
    } catch (err) {
      log.warn("orchestrator.run.nudge_counter_failed", { taskId, error: String(err) });
    }
  }
  const lastErrorStr = lastError
    ? typeof lastError === "string"
      ? lastError.slice(0, 800)
      : JSON.stringify(lastError).slice(0, 800)
    : null;
  log.info("orchestrator.run.done", { taskId, finalStatus, lastError: lastErrorStr });
}

/**
 * The lifecycle controller. Loops: pump current session → decide next
 * step based on phase + terminal + forceCompleted. Handles three phase
 * transitions:
 *
 *   code idle  → switch to reviewer (state=review)
 *   review idle, accept    → finalize done (state=ready)
 *   review idle, send_back → switch back to coder with feedback
 *                            (state=code, increment review_cycles)
 *
 * Errors in the reviewer phase are fail-open: if the reviewer can't
 * be opened or its output can't be parsed, we treat it as accept. The
 * user reviews the diff themselves anyway — we don't want a wedged
 * reviewer to block a working coder change.
 *
 * Cap on cycles is MAX_REVIEW_CYCLES (defined in reviewer.ts). Once
 * hit, send_back is forced to accept.
 */
async function runLifecycle(a: ActiveTask, task: TaskRow): Promise<void> {
  const taskId = task.id;
  let lastError: unknown = null;

  try {
    while (true) {
      // Pump the current session. After this returns, a.session has
      // either reached a terminal state or been closed externally
      // (forceComplete / cancelRun).
      const r = await pumpUntilTerminal(a);
      lastError = r.lastError ?? lastError;

      // forceComplete short-circuits, but with a nuance: if the watchdog
      // (not the user) triggered it AND we're in a phase that has a
      // natural successor, treat it as the phase finishing cleanly. The
      // watchdog only fires when opencode reports finish=stop, so the
      // work is already done — only the SSE bus missed events. Skipping
      // review on a code-phase recovery is what the user complained
      // about ("review step doesn't complete for self-created tasks");
      // promoting to next phase fixes that.
      if (a.forceCompleted === true) {
        if (a.watchdogRecovered && a.phase === "plan") {
          await safeClose(a.session, taskId, "plan_recovered");
          a.forceCompleted = false;
          a.watchdogRecovered = false;
          try {
            await switchToCoder(a, task);
            continue;
          } catch (err) {
            log.warn("orchestrator.coder.start_failed_after_plan", {
              taskId,
              error: String(err),
            });
            finalizeTask(task, "done", "ready", lastError);
            return;
          }
        }
        if (a.watchdogRecovered && a.phase === "code") {
          await safeClose(a.session, taskId, "code_recovered");
          a.forceCompleted = false;
          a.watchdogRecovered = false;
          try {
            await switchToReviewer(a, task);
            continue;
          } catch (err) {
            log.warn("orchestrator.reviewer.start_failed_after_recovery", {
              taskId,
              error: String(err),
            });
            finalizeTask(task, "done", "ready", lastError);
            return;
          }
        }
        // User-triggered force-complete (or watchdog at review phase) —
        // bail to ready as before.
        await safeClose(a.session, taskId, "force_completed");
        finalizeTask(task, "done", "ready", lastError);
        return;
      }

      // Iterator closed externally with no terminal event → canceled.
      if (r.terminal === null) {
        await safeClose(a.session, taskId, "canceled");
        finalizeTask(task, "canceled", task.current_state, lastError);
        return;
      }

      // Session error in any phase before review fails the whole task.
      // Reviewer errors get downgraded to accept further down — but a
      // session-level error means the engine itself failed, not just
      // bad output.
      if (r.terminal === "error" && a.phase === "plan") {
        log.warn("orchestrator.planner.session_error_falling_through_to_code", {
          taskId,
        });
        await safeClose(a.session, taskId, "plan_error");
        // Plan failure is not fatal — the coder can still attempt the
        // task without notes. Fall through to coder.
        try {
          await switchToCoder(a, task);
          continue;
        } catch (err) {
          finalizeTask(task, "failed", task.current_state, lastError);
          return;
        }
      }
      if (r.terminal === "error" && a.phase === "code") {
        await safeClose(a.session, taskId, "code_error");
        finalizeTask(task, "failed", task.current_state, lastError);
        return;
      }

      // Reviewer session error → fail-open to done. Logged so the user
      // can see this happened.
      if (r.terminal === "error" && a.phase === "review") {
        log.warn("orchestrator.reviewer.session_error_treated_as_accept", { taskId });
        await safeClose(a.session, taskId, "review_error_accept");
        finalizeTask(task, "done", "ready", lastError);
        return;
      }

      // r.terminal === "idle" — clean finish for this phase. Branch on phase.
      if (a.phase === "plan") {
        await safeClose(a.session, taskId, "plan_done");
        try {
          await switchToCoder(a, task);
          continue;
        } catch (err) {
          log.warn("orchestrator.coder.start_failed_after_plan", {
            taskId,
            error: String(err),
          });
          finalizeTask(task, "done", "ready", lastError);
          return;
        }
      }
      if (a.phase === "code") {
        await safeClose(a.session, taskId, "code_done");
        // Try to switch to reviewer. On any failure, accept the coder's
        // work and finalize done.
        try {
          await switchToReviewer(a, task);
          continue; // pump the reviewer next iteration
        } catch (err) {
          log.warn("orchestrator.reviewer.start_failed_treated_as_accept", {
            taskId,
            error: String(err),
          });
          finalizeTask(task, "done", "ready", lastError);
          return;
        }
      }

      // a.phase === "review", clean idle.
      await safeClose(a.session, taskId, "review_done");
      const decision = parseReviewerDecision(r.assistantText);

      // Persist the verdict so the "Reviewer" tab in the detail panel can
      // show history. Best-effort — a failed insert mustn't block the
      // accept/send-back transition the user is waiting on.
      try {
        appendReview({
          task_id: taskId,
          cycle: a.cycleCount,
          decision: decision.action,
          notes:
            decision.action === "accept"
              ? decision.notes ?? null
              : decision.feedback,
          raw_text: r.assistantText ?? null,
        });
      } catch (err) {
        log.warn("orchestrator.reviewer.persist_failed", {
          taskId,
          error: String(err),
        });
      }

      if (decision.action === "accept") {
        log.info("orchestrator.reviewer.accept", {
          taskId,
          cycleCount: a.cycleCount,
          notes: decision.notes ? decision.notes.slice(0, 280) : undefined,
        });
        finalizeTask(task, "done", "ready", lastError);
        return;
      }

      // send_back. If we've already burned the cycle budget, force accept.
      if (a.cycleCount >= MAX_REVIEW_CYCLES) {
        log.warn("orchestrator.reviewer.cycle_cap_hit_forcing_accept", {
          taskId,
          cycleCount: a.cycleCount,
          max: MAX_REVIEW_CYCLES,
        });
        finalizeTask(task, "done", "ready", lastError);
        return;
      }

      // Bump counter, store feedback, restart coder with feedback as the
      // follow-up message. On any failure starting the coder, finalize done.
      try {
        incrementReviewCycles(taskId);
      } catch (err) {
        log.warn("orchestrator.reviewer.increment_failed", { taskId, error: String(err) });
      }
      a.cycleCount += 1;
      a.lastReviewerFeedback = decision.feedback;

      try {
        await switchToCoder(a, task, decision.feedback);
        continue; // pump the new coder session
      } catch (err) {
        log.warn("orchestrator.coder.restart_failed_treated_as_done", {
          taskId,
          error: String(err),
        });
        finalizeTask(task, "done", "ready", lastError);
        return;
      }
    }
  } finally {
    active.delete(taskId);
    queue.release(taskId);
  }
}

/**
 * Open a reviewer session and send it the spec + diff. Updates a.session
 * + a.phase + the task's current_state in one shot. Caller wraps in a
 * try/catch (we re-throw on engine-side failures so the lifecycle can
 * fail-open to accept).
 */
async function switchToReviewer(a: ActiveTask, task: TaskRow): Promise<void> {
  const taskId = task.id;
  const session = await openReviewerSession(task, taskId, buildSystemPrompt);
  setLastSessionId(taskId, session.id);
  a.session = session;
  a.phase = "review";
  a.lastEventTs = Date.now();
  updateTaskStatus(taskId, "running", "review");

  const cwd = task.worktree_path ?? REPO_ROOT;
  const message = buildReviewerMessage({
    task,
    cycleCount: a.cycleCount,
    priorFeedback: a.lastReviewerFeedback,
  });
  const systemPrompt = buildReviewerSystemPrompt(renderSharedPrompt(taskId, cwd));
  await session.send(message, { system: systemPrompt });
  log.info("orchestrator.reviewer.message_sent", {
    taskId,
    sessionId: session.id,
    cycleCount: a.cycleCount,
  });
}

/**
 * Open a fresh coder session in the same worktree. Used in three places:
 *   1. After Plan phase ends — no feedback, the coder reads the spec
 *      and the planner's notes file.
 *   2. After a reviewer send-back — feedback is the reviewer's prose;
 *      coder should address it.
 *   3. Plan recovery / plan-error fallback — same as case 1.
 */
async function switchToCoder(a: ActiveTask, task: TaskRow, feedback?: string): Promise<void> {
  const taskId = task.id;
  const engine = await getEngine();
  const session = await engine.openSession({
    title: task.title,
    cwd: task.worktree_path ?? undefined,
  });
  setLastSessionId(taskId, session.id);
  a.session = session;
  a.phase = "code";
  a.lastEventTs = Date.now();
  // Reset progress so the bar starts fresh for this iteration.
  setTaskProgress(taskId, { step: null, total: null, label: null });
  updateTaskStatus(taskId, "running", "code");

  const cwd = task.worktree_path ?? REPO_ROOT;
  const followUp = feedback
    ? `The reviewer flagged issues with your previous pass. Address them and revise.\n\n## Reviewer feedback\n\n${feedback}`
    : undefined;
  await session.send(buildInitialMessage(task, followUp), {
    system: buildSystemPrompt(taskId, cwd),
  });
  log.info(
    feedback
      ? "orchestrator.coder.restarted_after_review"
      : "orchestrator.coder.started_after_plan",
    {
      taskId,
      sessionId: session.id,
      cycleCount: a.cycleCount,
    },
  );
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
          phase: a.phase,
          finish: lastInfo.finish,
          hadError: !!lastInfo.error,
        });
        // Mark this as a watchdog recovery so the lifecycle promotes to
        // the next phase instead of bailing to ready (which would skip
        // review on a code-phase task that opencode actually finished).
        a.watchdogRecovered = true;
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
