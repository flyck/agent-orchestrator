import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface Settings {
  max_parallel_tasks: number;
  max_agents_per_task: number;
  daily_token_budget_usd: number | null;
  max_parallel_background_agents: number;
  max_background_runs_per_day: number | null;
  background_token_budget_usd_per_day: number | null;
  manual_coding_nudge_after_n_tasks: number;
  completed_since_last_nudge: number;
  engine: string;
  worktree_root: string;
  worktree_max_age_days: number;
  skills_directory: string;
  repo_context_enabled: boolean;
  readme_token_budget: number;
  backlog_token_budget: number;
  ide_open_command: string;
  emacs_open_command: string;
  magit_open_command: string;
  pr_review_poll_interval_minutes: number;
}

const NUMBER_KEYS = new Set<keyof Settings>([
  "max_parallel_tasks",
  "max_agents_per_task",
  "max_parallel_background_agents",
  "manual_coding_nudge_after_n_tasks",
  "completed_since_last_nudge",
  "worktree_max_age_days",
  "readme_token_budget",
  "backlog_token_budget",
  "pr_review_poll_interval_minutes",
]);

const NULLABLE_NUMBER_KEYS = new Set<keyof Settings>([
  "daily_token_budget_usd",
  "max_background_runs_per_day",
  "background_token_budget_usd_per_day",
]);

const BOOLEAN_KEYS = new Set<keyof Settings>(["repo_context_enabled"]);

function parseValue<K extends keyof Settings>(key: K, raw: string): Settings[K] {
  if (NUMBER_KEYS.has(key)) return Number(raw) as Settings[K];
  if (NULLABLE_NUMBER_KEYS.has(key)) return (raw === "" ? null : Number(raw)) as Settings[K];
  if (BOOLEAN_KEYS.has(key)) return (raw === "true") as Settings[K];
  return raw as Settings[K];
}

function serializeValue<K extends keyof Settings>(key: K, value: Settings[K]): string {
  if (BOOLEAN_KEYS.has(key)) return value ? "true" : "false";
  if (NULLABLE_NUMBER_KEYS.has(key)) return value === null || value === undefined ? "" : String(value);
  return String(value);
}

export function readAllSettings(handle: Database = db()): Settings {
  const rows = handle
    .query<{ key: string; value: string }, []>("SELECT key, value FROM settings")
    .all();
  const out: Partial<Settings> = {};
  for (const { key, value } of rows) {
    (out as Record<string, unknown>)[key] = parseValue(key as keyof Settings, value);
  }
  return out as Settings;
}

export function updateSettings(patch: Partial<Settings>, handle: Database = db()): Settings {
  const upsert = handle.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const tx = handle.transaction((entries: [string, string][]) => {
    for (const [k, v] of entries) upsert.run(k, v);
  });
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const key = k as keyof Settings;
    entries.push([key, serializeValue(key, v as Settings[typeof key])]);
  }
  tx(entries);
  return readAllSettings(handle);
}
