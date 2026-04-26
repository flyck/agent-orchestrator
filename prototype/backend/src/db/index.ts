import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_DB_PATH = join(process.cwd(), "data", "orchestrator.sqlite");
const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

export function openDatabase(path: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  applySchema(db);
  seedDefaultSettings(db);
  return db;
}

function applySchema(db: Database) {
  const sql = readFileSync(SCHEMA_PATH, "utf8");
  db.exec(sql);
}

const DEFAULT_SETTINGS: Record<string, string> = {
  // Foreground queue
  max_parallel_tasks: "2",
  max_agents_per_task: "3",
  daily_token_budget_usd: "",
  // Background queue
  max_parallel_background_agents: "1",
  max_background_runs_per_day: "",
  background_token_budget_usd_per_day: "",
  // Manual coding nudge
  manual_coding_nudge_after_n_tasks: "5",
  completed_since_last_nudge: "0",
  // Engine
  engine: "opencode",
  // Worktrees
  worktree_root: "",
  worktree_max_age_days: "14",
  // Skills + repo context
  skills_directory: "",
  repo_context_enabled: "true",
  readme_token_budget: "2000",
  backlog_token_budget: "1000",
  // IDE integration
  ide_open_command: "",
};

function seedDefaultSettings(db: Database) {
  const insert = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  const tx = db.transaction((rows: [string, string][]) => {
    for (const [k, v] of rows) insert.run(k, v);
  });
  tx(Object.entries(DEFAULT_SETTINGS));
}

let _db: Database | null = null;
export function db(): Database {
  if (!_db) _db = openDatabase();
  return _db;
}
