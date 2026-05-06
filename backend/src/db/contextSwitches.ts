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
