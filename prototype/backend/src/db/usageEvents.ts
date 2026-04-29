import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface UsageEventRow {
  id: number;
  ts: number;
  task_id: string | null;
  session_id: string | null;
  provider_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd_micros: number;
}

export interface RecordUsageInput {
  ts: number;
  task_id?: string | null;
  session_id?: string | null;
  provider_id: string;
  model_id: string;
  input_tokens?: number;
  output_tokens?: number;
  /** Cost in USD as a JS number (e.g. 0.000712); persisted as micros (μUSD). */
  cost_usd?: number;
}

/** Per-task usage timeline — every assistant-turn event for a task,
 *  oldest first. Powers the Tokens tab in the home detail card: the
 *  user reads input/output tokens and cost per "step", and the
 *  context-accumulating curve is just the input_tokens series. */
export function listEventsForTask(
  taskId: string,
  handle: Database = db(),
): UsageEventRow[] {
  return handle
    .query<UsageEventRow, [string]>(
      `SELECT * FROM usage_events WHERE task_id = ? ORDER BY ts ASC`,
    )
    .all(taskId);
}

export function recordUsageEvent(input: RecordUsageInput, handle: Database = db()): void {
  const micros = Math.round((input.cost_usd ?? 0) * 1_000_000);
  handle
    .prepare(
      `INSERT INTO usage_events (ts, task_id, session_id, provider_id, model_id,
                                 input_tokens, output_tokens, cost_usd_micros)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.ts,
      input.task_id ?? null,
      input.session_id ?? null,
      input.provider_id,
      input.model_id,
      input.input_tokens ?? 0,
      input.output_tokens ?? 0,
      micros,
    );
}

interface DailySliceRow {
  bucket_ts: number;
  provider_id: string;
  cost_usd_micros: number;
  input_tokens: number;
  output_tokens: number;
}

export interface CostSummary {
  range: { from: number; to: number };
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  /** One series per provider, with daily-bucketed (ts, cost) points. */
  series: Array<{ provider_id: string; data: Array<[number, number]> }>;
  by_provider: Array<{ provider_id: string; cost_usd: number; input_tokens: number; output_tokens: number }>;
}

/** UTC-day-aligned (from, to) window covering the last `rangeDays` days
 *  inclusive (today=1 → today only; 7 → today + previous 6 days). */
function rangeWindow(rangeDays: number): { from: number; to: number } {
  const to = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  const from = d.getTime() - (rangeDays - 1) * day;
  return { from, to };
}

/** Range in days (today=1, week=7, etc). Buckets per UTC day. */
export function readCostSummary(
  rangeDays: number,
  handle: Database = db(),
): CostSummary {
  const { from, to } = rangeWindow(rangeDays);

  const rows = handle
    .query<DailySliceRow, [number, number]>(
      `SELECT
         (ts / 86400000) * 86400000 AS bucket_ts,
         provider_id,
         SUM(cost_usd_micros)       AS cost_usd_micros,
         SUM(input_tokens)          AS input_tokens,
         SUM(output_tokens)         AS output_tokens
       FROM usage_events
       WHERE ts >= ? AND ts <= ?
       GROUP BY bucket_ts, provider_id
       ORDER BY bucket_ts, provider_id`,
    )
    .all(from, to);

  const seriesByProvider = new Map<string, Array<[number, number]>>();
  for (const r of rows) {
    const arr = seriesByProvider.get(r.provider_id) ?? [];
    arr.push([r.bucket_ts, r.cost_usd_micros / 1_000_000]);
    seriesByProvider.set(r.provider_id, arr);
  }

  const totals = handle
    .query<
      { cost_usd_micros: number; input_tokens: number; output_tokens: number; provider_id: string },
      [number, number]
    >(
      `SELECT provider_id,
              SUM(cost_usd_micros) AS cost_usd_micros,
              SUM(input_tokens)    AS input_tokens,
              SUM(output_tokens)   AS output_tokens
       FROM usage_events
       WHERE ts >= ? AND ts <= ?
       GROUP BY provider_id
       ORDER BY cost_usd_micros DESC`,
    )
    .all(from, to);

  const total_cost_usd = totals.reduce((acc, r) => acc + (r.cost_usd_micros ?? 0), 0) / 1_000_000;
  const total_input_tokens = totals.reduce((acc, r) => acc + (r.input_tokens ?? 0), 0);
  const total_output_tokens = totals.reduce((acc, r) => acc + (r.output_tokens ?? 0), 0);

  return {
    range: { from, to },
    total_cost_usd,
    total_input_tokens,
    total_output_tokens,
    series: [...seriesByProvider.entries()].map(([provider_id, data]) => ({
      provider_id,
      data,
    })),
    by_provider: totals.map((r) => ({
      provider_id: r.provider_id,
      cost_usd: (r.cost_usd_micros ?? 0) / 1_000_000,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
    })),
  };
}

export interface ModelCostRow {
  provider_id: string;
  model_id: string;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
}

/** Per-(provider, model) breakdown over a range. Drives the model-cost
 *  table on the Cost page. */
export function readByModel(rangeDays: number, handle: Database = db()): ModelCostRow[] {
  const { from, to } = rangeWindow(rangeDays);

  return handle
    .query<
      {
        provider_id: string;
        model_id: string;
        cost_usd_micros: number;
        input_tokens: number;
        output_tokens: number;
        events: number;
      },
      [number, number]
    >(
      `SELECT provider_id, model_id,
              SUM(cost_usd_micros) AS cost_usd_micros,
              SUM(input_tokens)    AS input_tokens,
              SUM(output_tokens)   AS output_tokens,
              COUNT(*)             AS events
       FROM usage_events
       WHERE ts >= ? AND ts <= ?
       GROUP BY provider_id, model_id
       ORDER BY cost_usd_micros DESC`,
    )
    .all(from, to)
    .map((r) => ({
      provider_id: r.provider_id,
      model_id: r.model_id,
      cost_usd: (r.cost_usd_micros ?? 0) / 1_000_000,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      events: r.events ?? 0,
    }));
}

export interface TaskCostRow {
  task_id: string;
  task_title: string | null;
  task_status: string | null;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  events: number;
  last_event_ts: number;
}

/** Top N tasks by total cost over a range, joined to tasks for title/status.
 *  task_id NULL rows (e.g. scoring sessions when the task ref was already
 *  cleared) are excluded — they have no card to navigate to anyway. */
export function readTopTasksByCost(
  rangeDays: number,
  limit = 10,
  handle: Database = db(),
): TaskCostRow[] {
  const { from, to } = rangeWindow(rangeDays);

  return handle
    .query<
      {
        task_id: string;
        task_title: string | null;
        task_status: string | null;
        cost_usd_micros: number;
        input_tokens: number;
        output_tokens: number;
        events: number;
        last_event_ts: number;
      },
      [number, number, number]
    >(
      `SELECT u.task_id        AS task_id,
              t.title           AS task_title,
              t.status          AS task_status,
              SUM(u.cost_usd_micros) AS cost_usd_micros,
              SUM(u.input_tokens)    AS input_tokens,
              SUM(u.output_tokens)   AS output_tokens,
              COUNT(*)               AS events,
              MAX(u.ts)              AS last_event_ts
       FROM usage_events u
       LEFT JOIN tasks t ON t.id = u.task_id
       WHERE u.ts >= ? AND u.ts <= ? AND u.task_id IS NOT NULL
       GROUP BY u.task_id
       ORDER BY cost_usd_micros DESC
       LIMIT ?`,
    )
    .all(from, to, limit)
    .map((r) => ({
      task_id: r.task_id,
      task_title: r.task_title,
      task_status: r.task_status,
      cost_usd: (r.cost_usd_micros ?? 0) / 1_000_000,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
      events: r.events ?? 0,
      last_event_ts: r.last_event_ts ?? 0,
    }));
}
