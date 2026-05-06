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
const MANUAL_LABEL_KEY = "context_manual_label";
const MANUAL_AT_KEY = "context_manual_at";

function readSettingNumber(key: string): number {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
    .get(key);
  const v = row?.value ? Number(row.value) : 0;
  return Number.isFinite(v) ? v : 0;
}

function readSettingText(key: string): string | null {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM settings WHERE key = ?`)
    .get(key);
  return row?.value ? row.value : null;
}

function writeSetting(key: string, value: string): void {
  db()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

function readClearedAt(): number {
  return readSettingNumber(CLEARED_AT_KEY);
}

/** Latest context since the user last cleared. May come from either:
 *   - a context_switches row (the user clicked ↻ on a task), or
 *   - a manual label set from the navbar input (no task association).
 * The newer of the two wins. The label may be null while the LLM is still
 * labelling a task-driven switch — the caller surfaces "pending"/"…" in
 * that case. Returns null when nothing is set since the last clear. */
export function getCurrentContext(): ContextSwitchRow | null {
  const since = readClearedAt();

  const manualLabel = readSettingText(MANUAL_LABEL_KEY);
  const manualAt = readSettingNumber(MANUAL_AT_KEY);
  const manualValid = manualLabel && manualAt > since;

  const taskSwitch =
    db()
      .query<ContextSwitchRow, [number]>(
        `SELECT * FROM context_switches WHERE created_at > ? ORDER BY created_at DESC LIMIT 1`,
      )
      .get(since) ?? null;

  if (manualValid && (!taskSwitch || manualAt >= taskSwitch.created_at)) {
    return {
      // Sentinel id + task_id so callers can tell this is a manual entry.
      id: "manual",
      task_id: "",
      label: manualLabel,
      created_at: manualAt,
    };
  }
  return taskSwitch;
}

/** Mark the "current context" as cleared. We don't delete rows — just stamp
 *  a watermark so subsequent context-switch listings continue to include
 *  the historical events but the current-context indicator goes blank.
 *  Also drops any manual label since the user explicitly asked for "none". */
export function clearCurrentContext(): { cleared_at: number } {
  const now = Date.now();
  writeSetting(CLEARED_AT_KEY, String(now));
  // The manual label is deleted (rather than just shadowed by the watermark)
  // so the navbar text input shows up empty next time it switches into
  // edit mode.
  db().prepare(`DELETE FROM settings WHERE key = ?`).run(MANUAL_LABEL_KEY);
  db().prepare(`DELETE FROM settings WHERE key = ?`).run(MANUAL_AT_KEY);
  return { cleared_at: now };
}

/** Set a free-form manual context label from the navbar. Bypasses the
 *  context_switches table (which FK-constrains task_id) since there's no
 *  task for an ad-hoc context. */
export function setManualContext(label: string): { label: string; created_at: number } {
  const trimmed = label.trim().slice(0, 80);
  if (!trimmed) {
    throw new Error("manual_label_empty");
  }
  const now = Date.now();
  writeSetting(MANUAL_LABEL_KEY, trimmed);
  writeSetting(MANUAL_AT_KEY, String(now));
  return { label: trimmed, created_at: now };
}
