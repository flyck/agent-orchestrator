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

/** Range in days (today=1, week=7, etc). Buckets per UTC day. */
export function readCostSummary(
  rangeDays: number,
  handle: Database = db(),
): CostSummary {
  const to = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const todayStart = (() => {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const from = todayStart - (rangeDays - 1) * day;

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
