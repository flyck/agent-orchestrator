/**
 * In-process job queue for orchestrator runs.
 *
 * Behaviour:
 *   - submit(taskId) → if active count < max_parallel_tasks, runs the
 *     factory now and returns its session id; otherwise marks the task
 *     `queued` in the DB and returns null. A background dispatcher
 *     promotes queued tasks to running as slots free up.
 *   - max_parallel_tasks is read from settings on EVERY admit, so config
 *     changes apply to the next admission without restart.
 *   - Restart-safe insofar as queued rows persist in the DB; on backend
 *     boot a sweeper pulls them back into the in-memory waitlist (kept
 *     simple; no run replay / state recovery).
 */

import { log } from "../log";
import { listTasks, updateTaskStatus, type TaskRow } from "../db/tasks";
import { readAllSettings } from "../db/settings";

type RunFactory = () => Promise<{ sessionId: string }>;

interface PendingEntry {
  taskId: string;
  factory: RunFactory;
  enqueuedAt: number;
}

const active = new Set<string>();
const pending: PendingEntry[] = [];

function maxParallel(): number {
  const v = readAllSettings().max_parallel_tasks;
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 2;
}

/**
 * Try to admit `taskId` immediately. If admitted, runs the factory and
 * returns its session id. If not, marks the task queued in the DB and
 * returns null — the dispatcher will run it later.
 */
export async function submit(
  taskId: string,
  factory: RunFactory,
): Promise<{ sessionId: string } | null> {
  if (active.size < maxParallel()) {
    return await admit(taskId, factory);
  }
  // Capacity full → enqueue.
  if (pending.some((p) => p.taskId === taskId) || active.has(taskId)) {
    log.warn("queue.submit.duplicate", { taskId });
    return null;
  }
  pending.push({ taskId, factory, enqueuedAt: Date.now() });
  updateTaskStatus(taskId, "queued");
  log.info("queue.enqueued", {
    taskId,
    pending: pending.length,
    active: active.size,
    max: maxParallel(),
  });
  return null;
}

/**
 * Run the factory NOW. Caller is responsible for ensuring there is a free
 * slot. Wraps the run so we always release on settle.
 */
async function admit(
  taskId: string,
  factory: RunFactory,
): Promise<{ sessionId: string }> {
  active.add(taskId);
  log.info("queue.admit", {
    taskId,
    active: active.size,
    max: maxParallel(),
    pending: pending.length,
  });
  let result: { sessionId: string };
  try {
    result = await factory();
  } catch (err) {
    release(taskId);
    throw err;
  }
  // The factory has kicked off the run (session opened, initial message
  // sent). The pump runs in the background; release happens when it
  // terminates — see release(taskId) which is invoked by the orchestrator
  // pump's finally block via the queue's onComplete hook.
  return result;
}

/** Called by the orchestrator pump's finally when a run terminates. */
export function release(taskId: string): void {
  if (!active.delete(taskId)) return;
  log.info("queue.release", { taskId, active: active.size, pending: pending.length });
  dispatch();
}

/** Promote queued tasks until either capacity is full or queue is empty. */
function dispatch(): void {
  while (active.size < maxParallel() && pending.length > 0) {
    const entry = pending.shift()!;
    log.info("queue.dispatch", { taskId: entry.taskId });
    // Fire and forget — the run is async; failures release in admit's catch.
    admit(entry.taskId, entry.factory).catch((err) => {
      log.error("queue.dispatch.failed", {
        taskId: entry.taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

export function snapshot(): {
  active: string[];
  pending: string[];
  max: number;
} {
  return {
    active: [...active],
    pending: pending.map((p) => p.taskId),
    max: maxParallel(),
  };
}

/**
 * On backend boot: any task left in `queued` status from a previous run
 * stays queued. We do NOT auto-resume it (the in-memory factory closure
 * is gone). The user can hit Send Back / Run to re-trigger. This sweeper
 * just logs the count so it's visible.
 */
export function bootScan(): void {
  const stuck = listTasks({ status: "queued" }).map((t: TaskRow) => t.id);
  if (stuck.length > 0) {
    log.warn("queue.boot.orphaned_queued", { taskIds: stuck });
  }
}
