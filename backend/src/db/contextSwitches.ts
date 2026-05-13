import { nanoid } from "nanoid";
import { db } from "./index";

export interface ContextSwitchRow {
  id: string;
  /** Set when the user clicked ↻ on a task; null for free-form
   *  navbar entries that aren't tied to a specific task. */
  task_id: string | null;
  label: string | null;
  created_at: number;
}

export function recordContextSwitch(taskId: string): ContextSwitchRow {
  const id = `ctx_${nanoid(12)}`;
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO context_switches (id, task_id, label, created_at) VALUES (?, ?, NULL, ?)`,
    )
    .run(id, taskId, now);
  return { id, task_id: taskId, label: null, created_at: now };
}

export function setContextSwitchLabel(id: string, label: string): void {
  db().prepare(`UPDATE context_switches SET label = ? WHERE id = ?`).run(label, id);
}

export function listContextSwitchesForDate(date: string): ContextSwitchRow[] {
  const start = new Date(date + "T00:00:00Z").getTime();
  const end = new Date(date + "T23:59:59.999Z").getTime();
  return db()
    .query<ContextSwitchRow, [number, number]>(
      `SELECT * FROM context_switches WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`,
    )
    .all(start, end);
}

const CLEARED_AT_KEY = "context_cleared_at";

function readClearedAt(): number {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
    .get(CLEARED_AT_KEY);
  const v = row?.value ? Number(row.value) : 0;
  return Number.isFinite(v) ? v : 0;
}

/** Latest context since the user last cleared. Reads `context_switches`
 *  for both ↻-on-a-task entries (task_id set) and free-form navbar
 *  entries (task_id NULL). The label may be null while the LLM is still
 *  labelling a task-driven switch — the caller surfaces "pending"/"…"
 *  in that case. Returns null when nothing is set since the last clear. */
export function getCurrentContext(): ContextSwitchRow | null {
  const since = readClearedAt();
  return (
    db()
      .query<ContextSwitchRow, [number]>(
        `SELECT * FROM context_switches WHERE created_at > ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(since) ?? null
  );
}

/** Mark the "current context" as cleared. We don't delete rows — just stamp
 *  a watermark so subsequent context-switch listings continue to include
 *  the historical events but the current-context indicator goes blank. */
export function clearCurrentContext(): { cleared_at: number } {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(CLEARED_AT_KEY, String(now));
  return { cleared_at: now };
}

/** Free-form context entry typed into the navbar. Persisted as a
 *  context_switches row with task_id=NULL so it counts in the donut +
 *  total alongside task-attributed switches. The user-typed label is
 *  saved verbatim — no LLM round-trip needed. */
export function setManualContext(
  label: string,
): { id: string; label: string; created_at: number } {
  const trimmed = label.trim().slice(0, 80);
  if (!trimmed) {
    throw new Error("manual_label_empty");
  }
  const id = `ctx_${nanoid(12)}`;
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO context_switches (id, task_id, label, created_at) VALUES (?, NULL, ?, ?)`,
    )
    .run(id, trimmed, now);
  return { id, label: trimmed, created_at: now };
}
