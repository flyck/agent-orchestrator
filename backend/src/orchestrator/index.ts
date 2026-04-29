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
import { getEngine } from "../engine/singleton";
import {
  clearNeedsFeedback,
  getTask,
  incrementReviewCycles,
  setAwaitingGate,
  setLastSessionId,
  setLatestInputTokens,
  setTaskBaseRef,
  setTaskPipeline,
  setTaskProgress,
  setWorktree,
  taskTypeFor,
  TaskStatus,
  TaskType,
  updateTaskStatus,
  type TaskRow,
} from "../db/tasks";
import { incrementCompletedSinceNudge, readAllSettings } from "../db/settings";
import { generateGithubIssueSuggestions, generateHistorySuggestions } from "./suggestions";
import { composeCommitMessage } from "./commitMessage";
import {
  buildPlannerMessage,
  buildPlannerSystemPrompt,
  openPlannerSession,
} from "./planner";
import {
  getPipeline,
  PhaseKind,
  PipelineId,
  type PhaseDef,
  type PipelineDef,
} from "./pipelines";
import { getPhaseOutput, recordPhaseOutput } from "../db/phaseOutputs";
import {
  buildReviewerMessage,
  buildReviewerSystemPrompt,
  MAX_REVIEW_CYCLES,
  openReviewerSession,
  parseReviewerDecision,
  ReviewDecisionAction,
} from "./reviewer";
import { createWorktree, findRepoRoot as findRoot } from "./worktree";
import * as queue from "../queue";
import {
  ambientContext,
  buildInitialMessage,
  buildSystemPrompt,
  renderSharedPrompt,
} from "./prompts";
import { recordUsageEvent } from "../db/usageEvents";
import { ActivityActor, ActivityKind, recordActivity } from "../db/activities";
import { appendReview } from "../db/reviews";
import { log } from "../log";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Which agent owns the current session. For the legacy code-task
   *  lifecycle this is one of "plan" / "code" / "review". For the
   *  pipeline runner it's a free-form phase id from the PipelineDef
   *  (e.g. "intake", "explore", "deep-review"). */
  phase: string;
  /** True when the watchdog detected the engine session finished but
   *  the SSE bus missed the events. Lifecycle treats this as "phase
   *  finished cleanly" and proceeds to the next phase, instead of
   *  bailing to ready (which is what user-triggered force-complete
   *  does). */
  watchdogRecovered?: boolean;
  /** How many times the reviewer has sent the task back to the coder
   *  in *this run*. Capped by MAX_REVIEW_CYCLES. */
  cycleCount: number;
  /** True for GitHub PR-review tasks. Lifecycle short-circuits on
   *  review-phase termination — no send-back loop, the reviewer's
   *  output is the deliverable. Set in startRunInternal for tasks
   *  with workspace='review' + input_kind='diff'. */
  isPrReview?: boolean;
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

/** Non-throwing variant. Returns null when the task isn't currently in
 *  the active map (queued / paused / closed). The SSE handler uses this
 *  to attach without crashing the stream during the queued→running race
 *  or when subscribing to a task that's awaiting user input. */
export function tryAddListener(
  taskId: string,
  fn: (e: EngineEvent) => void,
): (() => void) | null {
  const a = active.get(taskId);
  if (!a) return null;
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
  recordActivity(ActivityKind.TaskRun, ActivityActor.Agent, taskId, opts.followUp ? "follow-up" : "initial");

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

  // Pipeline = task type → pipeline lookup. Coding tasks (feature,
  // bugfix, arch_compare, internal) keep the legacy plan→code→review
  // lifecycle; review tasks walk the gated PR-review pipeline. The
  // mapping is owned by the backend so the same task type always
  // gets the same pipeline — callers don't pass it in.
  const taskType = taskTypeFor(task.workspace);
  const pipelineId = pipelineForType(taskType);
  const usePipeline = pipelineId !== null;
  if (usePipeline && task.pipeline_id !== pipelineId) {
    setTaskPipeline(taskId, pipelineId);
    task.pipeline_id = pipelineId;
  }
  const isPrReview = taskType === TaskType.Review && task.input_kind === "diff";

  // ── Worktree setup ─────────────────────────────────────────────────
  // First run: create a fresh worktree branched from the parent repo's
  // current HEAD onto agent/<task>. Follow-up runs reuse the existing
  // worktree so the agent picks up where it left off. The diff for the
  // task is then naturally scoped to the worktree's branch — main can
  // move on freely without polluting the view.
  // PR reviews don't need a worktree — there's no editing.
  if (!usePipeline && !task.worktree_path) {
    const parentRoot = findRoot(import.meta.dir);
    if (!parentRoot) {
      const msg = "no .git found above backend dir — cannot create worktree";
      log.error("orchestrator.run.worktree_no_repo", { taskId });
      updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
      throw new Error(msg);
    }
    const sha = captureHeadSha();
    if (!sha) {
      log.error("orchestrator.run.worktree_no_head", { taskId });
      updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
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
      updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
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
    updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
    throw err;
  }

  // Initial vs. send-back: initial runs go through Plan first so the
  // planner agent populates .agent-notes/<id>.md. Send-backs skip Plan
  // — the cache from the prior pass is the planner's residue, and the
  // user wants the coder to address feedback, not to re-explore. PR
  // reviews go through the pipeline runner; the initial phase id
  // depends on where the runner picks up.
  const startInPlan = !opts.followUp && !usePipeline;
  const initialPhase: ActiveTask["phase"] = usePipeline
    ? task.awaiting_gate_id
      ? "resuming"
      : "intake"
    : startInPlan
      ? "plan"
      : "code";

  let session: EngineSession;
  try {
    if (usePipeline) {
      // Placeholder session — the pipeline runner replaces this with a
      // fresh per-phase session as soon as it starts. Opening
      // something here keeps ActiveTask.session non-null for the
      // watchdog + listener wiring.
      session = await engine.openSession({ title: `pipeline:${task.title}` });
    } else if (startInPlan) {
      session = await openPlannerSession(task, taskId);
    } else {
      session = await engine.openSession({
        title: task.title,
        cwd: task.worktree_path ?? undefined,
      });
    }
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
    updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
    throw err;
  }

  updateTaskStatus(taskId, TaskStatus.Running, initialPhase as TaskRow["current_state"]);

  const a: ActiveTask = {
    taskId,
    session,
    listeners: new Set(),
    pump: undefined as unknown as Promise<void>,
    lastEventTs: Date.now(),
    phase: initialPhase,
    cycleCount: 0,
    isPrReview,
  };
  active.set(taskId, a);

  // Lifecycle controller: pumps the current session, then decides
  // whether to switch to the reviewer, send back to the coder, or
  // finalize. Replaces the old single-session pump. PR-review tasks
  // walk the multi-phase pipeline runner instead.
  a.pump = usePipeline ? runPipelineLifecycle(a, task) : runLifecycle(a, task);

  // Send the initial message AFTER setting up the active record + pump so we
  // don't lose early events.
  try {
    const cwd = task.worktree_path ?? REPO_ROOT;
    if (usePipeline) {
      // Pipeline runner owns its own per-phase sessions; the
      // placeholder we opened here gets immediately replaced by the
      // runner's first phase. No initial send needed.
    } else if (startInPlan) {
      // Planner gets the same skills + repo-context block as the coder
      // and reviewer — the planner is the agent that most needs it,
      // since its whole job is exploring.
      const sharedPrompt = renderSharedPrompt(taskId, cwd) + ambientContext(cwd);
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
    updateTaskStatus(taskId, TaskStatus.Failed, task.current_state);
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

      // Auto-grant permissions when the engine surfaces them. Engines
      // that don't negotiate per-tool gates (Claude — runs with
      // bypassPermissions) leave session.respondToPermission undefined,
      // and this branch is a no-op.
      if (ev.type === "permission.asked" && session.respondToPermission) {
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
  finalStatus:
    | typeof TaskStatus.Done
    | typeof TaskStatus.Failed
    | typeof TaskStatus.Canceled,
  finalState: TaskRow["current_state"],
  lastError: unknown,
): void {
  const taskId = task.id;
  updateTaskStatus(taskId, finalStatus, finalState);
  if (finalStatus === TaskStatus.Done) {
    try {
      const n = incrementCompletedSinceNudge();
      log.info("orchestrator.run.nudge_counter_bumped", { taskId, completed: n });
    } catch (err) {
      log.warn("orchestrator.run.nudge_counter_failed", { taskId, error: String(err) });
    }
    // "Suggested next" generation. Re-fetch the row so we see the
    // just-updated status — the generator filters on it. History source
    // runs synchronously; the GitHub source involves network I/O so we
    // fire-and-forget on a microtask.
    try {
      const fresh = getTask(taskId);
      if (fresh) {
        generateHistorySuggestions(fresh);
        void generateGithubIssueSuggestions(fresh).catch((err) =>
          log.warn("orchestrator.run.github_suggestions_failed", {
            taskId,
            error: String(err),
          }),
        );
      }
    } catch (err) {
      log.warn("orchestrator.run.suggestions_failed", { taskId, error: String(err) });
    }
    // Compose the Conventional Commits message in the background. The
    // user's first action in the Ready state is reading the diff and
    // clicking finalize — by then the message should be ready and
    // surface as an editable textarea. Best-effort; no error blocks the
    // ready transition.
    if (finalState === "ready") {
      void composeCommitMessage(taskId).catch((err) =>
        log.warn("orchestrator.run.commit_message_failed", {
          taskId,
          error: String(err),
        }),
      );
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
/**
 * Pick the pipeline for a task by its high-level type. Returns null
 * for tasks that should use the legacy hard-coded lifecycle. Adding
 * a new pipeline = adding a TaskType + a row here; runtime config
 * from the DB can layer on top once the runner is fully proven.
 */
function pipelineForType(type: TaskType): PipelineId | null {
  switch (type) {
    case TaskType.Review:
      return PipelineId.PrReviewGated;
    case TaskType.Coding:
      // Legacy plan→code→review→ready lifecycle for now. Will become
      // PipelineId.CodeTask once the runner replaces runLifecycle.
      return null;
  }
}

// ─── Pipeline runner (Phase 16, Design A) ──────────────────────────────
// Walks a PipelineDef phase list for tasks that have pipeline_id set
// (currently only PR-review tasks). Coexists with the legacy
// runLifecycle below; routing happens in startRunInternal.

/** Strip frontmatter and load an agent's role prompt. Same shape as
 *  loadReviewerPrompt / loadPlannerPrompt; duplicated to avoid an
 *  import cycle. */
function loadAgentPrompt(relPath: string): string {
  const path = fileURLToPath(new URL(`../../agents/builtin/${relPath}`, import.meta.url));
  try {
    const raw = readFileSync(path, "utf8");
    const m = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return (m?.[1] ?? raw).trim();
  } catch (err) {
    log.error("orchestrator.pipeline.prompt_read_failed", { path, error: String(err) });
    return "";
  }
}

/** Per-agent prompt bodies used by the pipeline runner. Loaded once at
 *  module init; restart the backend to pick up edits. */
const PIPELINE_AGENT_PROMPTS: Record<string, string> = {
  "pr-spec-intake":         loadAgentPrompt("review/pr-spec-intake.md"),
  "solution-explorer":      loadAgentPrompt("review/solution-explorer.md"),
  "reviewer-coder":         loadAgentPrompt("review/reviewer-coder.md"),
  "review-security":        loadAgentPrompt("review/reviewer-security.md"),
  "reviewer-performance":   loadAgentPrompt("review/reviewer-performance.md"),
  "reviewer-architecture":  loadAgentPrompt("review/reviewer-architecture.md"),
  "synthesizer":            loadAgentPrompt("review/synthesizer.md"),
};

/** Build the user message for one (phase, agent) pair. Earlier phases'
 *  outputs are pulled from task_phase_outputs and stitched in. */
function buildPipelinePhaseMessage(
  task: TaskRow,
  phase: PhaseDef,
  agentSlug: string,
): string {
  const taskId = task.id;
  const prInput = task.input_payload;

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

/**
 * Run one agent in one phase. Opens a fresh engine session, sends the
 * built message, pumps until terminal, persists the assistant reply
 * to task_phase_outputs. For deep-review reviewers, also writes a
 * task_reviews row so the existing Review-tab UI lights up.
 *
 * Returns false on session-level error.
 */
async function runPipelineAgent(
  a: ActiveTask,
  task: TaskRow,
  phase: PhaseDef,
  agentSlug: string,
): Promise<boolean> {
  const taskId = task.id;
  const cwd = task.worktree_path ?? REPO_ROOT;
  const promptBody = PIPELINE_AGENT_PROMPTS[agentSlug];
  if (!promptBody) {
    log.warn("orchestrator.pipeline.unknown_agent", { taskId, agentSlug });
    return false;
  }
  const system = `${renderSharedPrompt(taskId, cwd)}\n\n---\n\n${promptBody}`;
  const message = buildPipelinePhaseMessage(task, phase, agentSlug);

  const engine = await getEngine();
  const session = await engine.openSession({
    title: `${phase.id}:${task.title}`,
    cwd: task.worktree_path ?? undefined,
  });
  setLastSessionId(taskId, session.id);
  a.session = session;
  a.lastEventTs = Date.now();
  setTaskProgress(taskId, { step: null, total: null, label: null });

  try {
    await session.send(message, { system });
  } catch (err) {
    log.error("orchestrator.pipeline.send_failed", {
      taskId,
      phaseId: phase.id,
      agentSlug,
      error: String(err),
    });
    await safeClose(session, taskId, "pipeline_send_failed");
    return false;
  }

  const r = await pumpUntilTerminal(a);
  await safeClose(session, taskId, `${phase.id}_done`);

  if (r.terminal === "error") {
    log.warn("orchestrator.pipeline.phase_error", { taskId, phaseId: phase.id, agentSlug });
    return phase.kind === PhaseKind.Parallel; // soft-fail when one of N reviewers dies
  }

  const reply = (r.assistantText ?? "").trim();
  if (reply.length > 0) {
    recordPhaseOutput(taskId, phase.id, agentSlug, reply);
  }

  // If this is a reviewing agent in deep-review, also persist a
  // task_reviews row — that's what feeds the Review tab.
  const reviewerSlugs = new Set([
    "reviewer-coder",
    "review-security",
    "reviewer-performance",
    "reviewer-architecture",
  ]);
  if (reviewerSlugs.has(agentSlug) && phase.id === "deep-review") {
    try {
      const decision = parseReviewerDecision(reply);
      if (decision.action === ReviewDecisionAction.Accept || decision.action === ReviewDecisionAction.SendBack) {
        appendReview({
          task_id: taskId,
          cycle: 0,
          decision: decision.action,
          notes:
            decision.action === ReviewDecisionAction.Accept
              ? decision.notes ?? null
              : decision.feedback,
          raw_text: reply,
          confidence: decision.confidence ?? null,
          findings_json:
            decision.findings && decision.findings.length > 0
              ? JSON.stringify(decision.findings)
              : null,
        });
      }
    } catch (err) {
      log.warn("orchestrator.pipeline.review_persist_failed", {
        taskId,
        agentSlug,
        error: String(err),
      });
    }
  }

  log.info("orchestrator.pipeline.phase_done", {
    taskId,
    phaseId: phase.id,
    agentSlug,
    outputBytes: reply.length,
  });
  return true;
}

/**
 * Walk the task's pipeline from the resume index to either the next
 * gate (pause) or the end (finalize). Replaces runLifecycle for tasks
 * with pipeline_id set.
 */
async function runPipelineLifecycle(a: ActiveTask, task: TaskRow): Promise<void> {
  const taskId = task.id;
  const pipelineId = task.pipeline_id ?? "pr-review-gated";
  const pipeline = getPipeline(pipelineId);
  if (!pipeline) {
    log.error("orchestrator.pipeline.unknown", { taskId, pipelineId });
    finalizeTask(task, TaskStatus.Failed, task.current_state, new Error(`unknown pipeline ${pipelineId}`));
    return;
  }

  // Resume after a gate, or start at 0.
  const startIdx = (() => {
    if (!task.awaiting_gate_id) return 0;
    const idx = pipeline.phases.findIndex((p) => p.id === task.awaiting_gate_id);
    return idx >= 0 ? idx + 1 : 0;
  })();

  log.info("orchestrator.pipeline.start", {
    taskId,
    pipelineId,
    startIdx,
    totalPhases: pipeline.phases.length,
  });

  // Clearing here is symmetric — we're past the gate now.
  if (task.awaiting_gate_id) setAwaitingGate(taskId, null);

  try {
    for (let i = startIdx; i < pipeline.phases.length; i++) {
      const phase = pipeline.phases[i]!;
      a.phase = phase.id;
      log.info("orchestrator.pipeline.phase", {
        taskId,
        phaseId: phase.id,
        kind: phase.kind,
      });
      updateTaskStatus(taskId, TaskStatus.Running, phase.id as TaskRow["current_state"]);

      if (phase.kind === PhaseKind.Gate) {
        // Pause and return. Resume happens via the gate API which calls
        // startRun again; this function picks up at the phase after.
        // The "ready" gate at the end of the pipeline is treated as the
        // terminal: finalize done/ready instead of awaiting.
        if (phase.id === "ready") {
          finalizeTask(task, TaskStatus.Done, "ready", null);
          return;
        }
        setAwaitingGate(taskId, phase.id);
        log.info("orchestrator.pipeline.gate_pause", { taskId, phaseId: phase.id });
        return;
      }

      const agents = phase.agents ?? [];
      let allOk = true;
      for (const agentSlug of agents) {
        const ok = await runPipelineAgent(a, task, phase, agentSlug);
        if (!ok) { allOk = false; break; }
      }
      if (!allOk) {
        finalizeTask(task, TaskStatus.Failed, phase.id as TaskRow["current_state"], null);
        return;
      }
    }
    finalizeTask(task, TaskStatus.Done, "ready", null);
  } finally {
    active.delete(taskId);
    queue.release(taskId);
  }
}

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
            finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
            finalizeTask(task, TaskStatus.Done, "ready", lastError);
            return;
          }
        }
        // User-triggered force-complete (or watchdog at review phase) —
        // bail to ready as before.
        await safeClose(a.session, taskId, "force_completed");
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
        return;
      }

      // Iterator closed externally with no terminal event → canceled.
      if (r.terminal === null) {
        await safeClose(a.session, taskId, "canceled");
        finalizeTask(task, TaskStatus.Canceled, task.current_state, lastError);
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
          finalizeTask(task, TaskStatus.Failed, task.current_state, lastError);
          return;
        }
      }
      if (r.terminal === "error" && a.phase === "code") {
        await safeClose(a.session, taskId, "code_error");
        finalizeTask(task, TaskStatus.Failed, task.current_state, lastError);
        return;
      }

      // Reviewer session error → fail-open to done. Logged so the user
      // can see this happened.
      if (r.terminal === "error" && a.phase === "review") {
        log.warn("orchestrator.reviewer.session_error_treated_as_accept", { taskId });
        await safeClose(a.session, taskId, "review_error_accept");
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
          finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
          finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
            decision.action === ReviewDecisionAction.Accept
              ? decision.notes ?? null
              : decision.feedback,
          raw_text: r.assistantText ?? null,
          confidence: decision.confidence ?? null,
          findings_json: decision.findings && decision.findings.length > 0
            ? JSON.stringify(decision.findings)
            : null,
        });
      } catch (err) {
        log.warn("orchestrator.reviewer.persist_failed", {
          taskId,
          error: String(err),
        });
      }

      if (decision.action === ReviewDecisionAction.Accept) {
        log.info("orchestrator.reviewer.accept", {
          taskId,
          cycleCount: a.cycleCount,
          notes: decision.notes ? decision.notes.slice(0, 280) : undefined,
        });
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
        return;
      }

      // PR review: no coder to send back to. Whatever the reviewer
      // said is the deliverable; finalize and let the user read it.
      // The decision row + raw_text + alternatives are persisted, so
      // "send_back" findings still surface — they just don't trigger
      // another agent loop.
      if (a.isPrReview) {
        log.info("orchestrator.reviewer.pr_review_finalizing", {
          taskId,
          decision: decision.action,
        });
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
        return;
      }

      // send_back. If we've already burned the cycle budget, force accept.
      if (a.cycleCount >= MAX_REVIEW_CYCLES) {
        log.warn("orchestrator.reviewer.cycle_cap_hit_forcing_accept", {
          taskId,
          cycleCount: a.cycleCount,
          max: MAX_REVIEW_CYCLES,
        });
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
        finalizeTask(task, TaskStatus.Done, "ready", lastError);
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
  updateTaskStatus(taskId, TaskStatus.Running, "review");

  const cwd = task.worktree_path ?? REPO_ROOT;
  const message = buildReviewerMessage({
    task,
    cycleCount: a.cycleCount,
    priorFeedback: a.lastReviewerFeedback,
  });
  const systemPrompt = buildReviewerSystemPrompt(
    renderSharedPrompt(taskId, cwd) + ambientContext(cwd),
  );
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
  updateTaskStatus(taskId, TaskStatus.Running, "code");

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

/** Anthropic stop_reason values that actually mean the assistant turn
 *  ended. `tool_use` is NOT in this set — it means the LLM produced a
 *  tool_use block as its last action and is waiting for the tool result.
 *  A long-running tool call (a file scan, a multi-step edit) can easily
 *  exceed the 30s silence threshold; treating tool_use as terminal would
 *  force-complete a task that's actually mid-edit and leave the worktree
 *  empty (observed: tsk_TF5ye38m_TDRUDpa, 2026-04-29 — empty diff +
 *  empty_diff commit because watchdog killed both code-phase attempts). */
const TERMINAL_FINISH_REASONS = new Set([
  "end_turn",
  "stop",
  "stop_sequence",
  "max_tokens",
]);

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
      const messages = (await engine.getTranscript(a.session.id, 5)) as Array<{
        info?: { role?: string; finish?: string; error?: unknown; cost?: number };
      }>;
      const last = messages.at(-1);
      const lastInfo = last?.info;
      const isTerminalFinish =
        !!lastInfo?.error ||
        (typeof lastInfo?.finish === "string" &&
          TERMINAL_FINISH_REASONS.has(lastInfo.finish));
      if (lastInfo?.role === "assistant" && isTerminalFinish) {
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
        log.info("orchestrator.watchdog.still_working", {
          taskId: a.taskId,
          finish: lastInfo?.finish ?? null,
          hadError: !!lastInfo?.error,
        });
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
  const queued = listTasks({ status: TaskStatus.Queued });
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
    updateTaskStatus(taskId, TaskStatus.Done, "ready");
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
