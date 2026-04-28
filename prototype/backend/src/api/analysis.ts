/**
 * Analysis tab. Aggregations over completed tasks:
 *   - tokens (input + output) per task
 *   - send-back count per task (user_sendbacks)
 *   - daily total send-backs (timeseries)
 *   - tasks-completed counter
 *
 * The aggregation kind (avg / p90 / p95 / min / max) is chosen by the
 * caller; default avg.
 */

import { Hono } from "hono";
import { db } from "../db";

export const analysis = new Hono();

interface TokenRow {
  task_id: string;
  total: number;
}
interface SendbackRow {
  user_sendbacks: number;
}
interface DailyRow {
  bucket_ts: number;
  total: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

function aggregate(values: number[], kind: string): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  switch (kind) {
    case "min": return sorted[0]!;
    case "max": return sorted[sorted.length - 1]!;
    case "p90": return percentile(sorted, 90);
    case "p95": return percentile(sorted, 95);
    case "avg":
    default: {
      const sum = sorted.reduce((a, b) => a + b, 0);
      return sum / sorted.length;
    }
  }
}

const ALL_AGGS = ["avg", "p90", "p95", "min", "max"] as const;

function aggregateAll(values: number[]) {
  const out: Record<string, number> = {};
  for (const k of ALL_AGGS) out[k] = aggregate(values, k);
  return out;
}

analysis.get("/", (c) => {
  const handle = db();

  // Tokens per task — only tasks that finished (done) and have at least
  // one usage_event row attached. Sum input+output for the per-task total.
  const tokenRows = handle
    .query<TokenRow, []>(
      `SELECT u.task_id AS task_id,
              SUM(u.input_tokens + u.output_tokens) AS total
         FROM usage_events u
         JOIN tasks t ON t.id = u.task_id
        WHERE u.task_id IS NOT NULL
          AND t.status = 'done'
        GROUP BY u.task_id`,
    )
    .all();
  const tokensPerTask = tokenRows.map((r) => Number(r.total) || 0);

  // Send-backs per completed task. Includes zero-sendback tasks so the
  // distribution reflects "how often does this task type need a redo".
  const sendbackRows = handle
    .query<SendbackRow, []>(
      `SELECT user_sendbacks FROM tasks WHERE status = 'done'`,
    )
    .all();
  const sendbacksPerTask = sendbackRows.map((r) => Number(r.user_sendbacks) || 0);

  // Daily total send-backs (last 30 days) — derive from the activity log.
  const day = 24 * 60 * 60 * 1000;
  const todayStart = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const from = todayStart - 29 * day;
  const dailyRows = handle
    .query<DailyRow, [number]>(
      `SELECT (ts / 86400000) * 86400000 AS bucket_ts,
              COUNT(*) AS total
         FROM activity_events
        WHERE kind = 'review_sendback' AND ts >= ?
        GROUP BY bucket_ts
        ORDER BY bucket_ts ASC`,
    )
    .all(from);
  // Pad with 0 for empty days so the chart renders a continuous line.
  const dailySendbacks: Array<[number, number]> = [];
  for (let i = 0; i < 30; i++) {
    const bucket = from + i * day;
    const found = dailyRows.find((r) => r.bucket_ts === bucket);
    dailySendbacks.push([bucket, Number(found?.total ?? 0)]);
  }

  // Tasks completed counter — total count of done tasks.
  const completedRow = handle
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'")
    .get();
  const tasksCompleted = Number(completedRow?.n ?? 0);

  return c.json({
    tokens_per_task: {
      sample_size: tokensPerTask.length,
      aggregations: aggregateAll(tokensPerTask),
    },
    sendbacks_per_task: {
      sample_size: sendbacksPerTask.length,
      aggregations: aggregateAll(sendbacksPerTask),
    },
    daily_sendbacks: {
      range: { from, to: Date.now() },
      data: dailySendbacks,
    },
    tasks_completed: tasksCompleted,
  });
});
