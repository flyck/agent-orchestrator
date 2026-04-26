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
  applyMigrations(db);
}

/**
 * Idempotent migrations for columns we add after the original schema. Each
 * step probes table_info and ALTERs only if the column is missing.
 */
function applyMigrations(db: Database) {
  const ensureColumn = (table: string, column: string, decl: string) => {
    const cols = db
      .query<{ name: string }, never[]>(`PRAGMA table_info(${table})`)
      .all() as { name: string }[];
    if (!cols.some((c) => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
    }
  };
  ensureColumn("tasks", "current_step", "INTEGER");
  ensureColumn("tasks", "total_steps", "INTEGER");
  ensureColumn("tasks", "step_label", "TEXT");
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
  // IDE integration. Both support a {path} placeholder; if absent, the
  // path is appended as the last argument. Examples:
  //   ide_open_command:   "code" or "cursor --reuse-window"
  //   magit_open_command: 'emacsclient --no-wait --eval (magit-status-setup-buffer "{path}")'
  ide_open_command: "",
  magit_open_command: "",
  // GitHub: polling for PRs where the user is a requested reviewer.
  // Wired in Phase 13 when the GitHub provider lands; setting is here so
  // the UI can show it from day one.
  pr_review_poll_interval_minutes: "5",
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
