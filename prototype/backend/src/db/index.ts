import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadUserSettingsOverlay } from "./userSettings";

const DEFAULT_DB_PATH = join(process.cwd(), "data", "orchestrator.sqlite");
const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

export function openDatabase(path: string = process.env.DB_PATH ?? DEFAULT_DB_PATH): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  applySchema(db);
  seedDefaultSettings(db);
  // Apply data/user-settings.yaml on top of the defaults so machine-specific
  // open-in-IDE / emacs / magit commands etc. live in a portable text file
  // rather than being burned into the local SQLite DB. No-op when missing.
  loadUserSettingsOverlay(db);
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
  ensureColumn("tasks", "needs_feedback", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("tasks", "feedback_question", "TEXT");
  ensureColumn("tasks", "last_session_id", "TEXT");
  // Stamped whenever current_state changes — drives the "Xs in this stage"
  // counter on cards. Distinct from updated_at, which churns on every
  // progress tick / SSE event / etc.
  ensureColumn("tasks", "state_entered_at", "INTEGER");
  // Difficulty score (1–10) assigned by the scoring agent at task creation.
  // NULL while pending; the scoring run is fire-and-forget so the create
  // endpoint can return immediately. The user can override post-hoc.
  ensureColumn("tasks", "difficulty", "INTEGER");
  ensureColumn("tasks", "difficulty_justification", "TEXT");
  ensureColumn("tasks", "difficulty_overridden_by_user", "INTEGER NOT NULL DEFAULT 0");
  // Task metadata for reflection / metrics:
  // - review_cycles: bumped by the orchestrator each time the reviewer
  //   sends the task back to the coder. 0 means "reviewer accepted on
  //   first pass" (or hasn't run yet).
  // - user_sendbacks: bumped when the user clicks Send back with feedback
  //   (the existing /continue endpoint).
  // - user_rating + user_rating_comment: optional post-hoc tag the user
  //   sets in the Ready state to flag a bad experience. Free-form comment.
  ensureColumn("tasks", "review_cycles", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("tasks", "user_sendbacks", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn("tasks", "user_rating", "TEXT");
  ensureColumn("tasks", "user_rating_comment", "TEXT");
  // Live context-window usage. Captured from each assistant message's
  // tokens.input field — that is the size of the conversation fed in for
  // that turn, i.e. the current context size. Surfaced on home pipeline
  // cards so the user sees the agent approaching its window.
  ensureColumn("tasks", "latest_input_tokens", "INTEGER");
  ensureColumn("tasks", "latest_tokens_ts", "INTEGER");
  // JSON map of pipeline stage → entry count. Bumped in updateTaskStatus
  // each time the task transitions into a stage. Drives the on-card
  // re-entry bubble (e.g. code column shows "3" when reviewer has sent
  // it back twice). Default '{}' so existing rows stay safely empty.
  ensureColumn("tasks", "stage_entries_json", "TEXT NOT NULL DEFAULT '{}'");
  // User-flagged abandonment. Distinct from delete: the row stays so the
  // user remembers it existed (and any rating / activity log entries
  // remain readable). null = active; a timestamp = abandoned at that ms.
  ensureColumn("tasks", "abandoned_at", "INTEGER");
  // Reviewer-supplied confidence + structured findings (added with the
  // Claude code-review skill adaptation). Default-null so older review
  // rows from before this column existed stay readable.
  ensureColumn("task_reviews", "confidence", "TEXT");
  ensureColumn("task_reviews", "findings_json", "TEXT");
  // Multi-phase pipeline runner (Phase 16). pipeline_id selects which
  // PipelineDef the task walks through; awaiting_gate_id is the phase
  // id the runner paused on, surfaced in the UI as the approval/
  // send-back banner. null in both = legacy hard-coded lifecycle (the
  // existing runLifecycle continues to handle code-task workspaces).
  ensureColumn("tasks", "pipeline_id", "TEXT");
  ensureColumn("tasks", "awaiting_gate_id", "TEXT");
  // Task-type-specific metadata as a JSON blob. PR-review tasks stash
  // the GitHub coordinates (repo full name, number, base_ref, head_ref,
  // html_url) here so the comment-proxy endpoint can post back to the
  // right PR without re-parsing the task title.
  ensureColumn("tasks", "metadata_json", "TEXT");
  // Per-alternative concept diagram (Mermaid source). null when the
  // explorer didn't or couldn't draw one.
  ensureColumn("task_alternatives", "diagram_mermaid", "TEXT");
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
  // Open-target commands. Each supports a {path} placeholder; if absent,
  // the path is appended as the last argument. The buttons in the Files
  // tab + the per-file links in the diff list use these.
  // Examples:
  //   ide_open_command:    "code" or "cursor --reuse-window"
  //   emacs_open_command:  "emacsclient --no-wait"
  //   magit_open_command:  'emacsclient --no-wait --eval (magit-status-setup-buffer "{path}")'
  ide_open_command: "",
  emacs_open_command: "",
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
