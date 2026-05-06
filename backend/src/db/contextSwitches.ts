import { nanoid } from "nanoid";
import { db } from "./index";

export interface ContextSwitchRow {
  id: string;
  task_id: string;
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

/** Latest context switch since the user last cleared. Null if no switch
 *  has happened since clear. The label may be null while the LLM is
 *  still labelling — the caller surfaces "pending" / "…" in that case. */
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
