-- agent-orchestrator schema
--
-- One file, applied idempotently on startup. All tables created with
-- IF NOT EXISTS so re-running on an existing database is a no-op.
-- For real migrations later we'll add a schema_migrations table.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Key-value settings, single row per key. Values are stored as text;
-- the repo layer parses to typed values.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Agent definitions — hybrid file + DB. The system prompt lives on disk
-- (file_path); this table is the index. prompt_hash detects out-of-band
-- file edits.
CREATE TABLE IF NOT EXISTS agents (
  id                 TEXT PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  icon               TEXT NOT NULL,
  role               TEXT NOT NULL,                       -- planner | reviewer | implementer | synthesizer | background | scoring | custom
  concurrency_class  TEXT NOT NULL DEFAULT 'foreground',  -- foreground | background
  file_path          TEXT NOT NULL,
  prompt_hash        TEXT NOT NULL,
  model_provider_id  TEXT,
  model_id           TEXT,
  cadence_json       TEXT,
  limits_json        TEXT,
  enabled            INTEGER NOT NULL DEFAULT 0,
  is_builtin         INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);

-- Top-level user-initiated and background units of work.
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,    -- review | feature | bugfix | arch_compare | background
  queue             TEXT NOT NULL,    -- foreground | background
  title             TEXT NOT NULL,
  input_kind        TEXT NOT NULL,    -- diff | path | prompt | spec
  input_payload     TEXT NOT NULL,
  repo_path         TEXT,
  worktree_path     TEXT,
  worktree_branch   TEXT,
  worktree_base_ref TEXT,
  status            TEXT NOT NULL,    -- queued | running | synthesizing | done | failed | canceled | findings_pending
  current_state     TEXT,             -- spec | plan | implement | review | accept (feature/bugfix)
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_status     ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_workspace  ON tasks(workspace);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at DESC);

-- Spec revisions for Feature/Bugfix tasks.
CREATE TABLE IF NOT EXISTS spec_revisions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  spec_md     TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (task_id, version)
);

-- One row per agent invocation within a task.
CREATE TABLE IF NOT EXISTS agent_runs (
  id                      TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id                TEXT NOT NULL REFERENCES agents(id),
  agent_prompt_snapshot   TEXT NOT NULL,
  status                  TEXT NOT NULL,
  started_at              INTEGER,
  finished_at             INTEGER,
  input_tokens            INTEGER NOT NULL DEFAULT 0,
  output_tokens           INTEGER NOT NULL DEFAULT 0,
  cost_usd_micros         INTEGER NOT NULL DEFAULT 0,
  output_md               TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id);

-- One row per OpenCode session opened for an agent run.
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  agent_run_id        TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  engine              TEXT NOT NULL DEFAULT 'opencode',
  external_session_id TEXT,
  status              TEXT NOT NULL,
  opened_at           INTEGER NOT NULL,
  closed_at           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_sessions_agent_run ON sessions(agent_run_id);

-- High-level message history per session — user comments, agent replies,
-- orchestrator system messages.
CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  direction   TEXT NOT NULL,    -- inbound (to agent) | outbound (from agent)
  sender      TEXT NOT NULL,    -- user | agent | system | orchestrator
  content_md  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, ts);

-- Raw engine events (stream-json from OpenCode) for replay/debug.
CREATE TABLE IF NOT EXISTS engine_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  ts            INTEGER NOT NULL,
  type          TEXT NOT NULL,
  payload_json  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_engine_events_session ON engine_events(session_id, ts);

-- Findings — produced by review reviewers (per-task) or background agents
-- (task_id null). Background findings are independent observations the user
-- triages.
CREATE TABLE IF NOT EXISTS findings (
  id              TEXT PRIMARY KEY,
  task_id         TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  severity        TEXT NOT NULL,    -- info | low | medium | high
  location        TEXT,
  title           TEXT NOT NULL,
  detail_md       TEXT NOT NULL,
  evidence_md     TEXT,
  status          TEXT NOT NULL,    -- open | dismissed | snoozed | accepted | converted_to_task
  snoozed_until   INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_task   ON findings(task_id);

-- Task-level rollup written when a task reaches a terminal state.
-- Joined to tasks for the v2 model performance metrics view.
CREATE TABLE IF NOT EXISTS task_metrics (
  task_id                       TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  difficulty                    INTEGER NOT NULL,
  difficulty_justification      TEXT,
  difficulty_overridden_by_user INTEGER NOT NULL DEFAULT 0,
  input_tokens                  INTEGER NOT NULL,
  output_tokens                 INTEGER NOT NULL,
  cost_usd_micros               INTEGER NOT NULL,
  wall_clock_ms                 INTEGER NOT NULL,
  models_used_json              TEXT NOT NULL,
  primary_model                 TEXT,
  outcome                       TEXT NOT NULL,
  recorded_at                   INTEGER NOT NULL
);

-- External integrations (v1: github).
CREATE TABLE IF NOT EXISTS integrations (
  id              TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL DEFAULT 0,
  config_json     TEXT NOT NULL,
  last_synced_at  INTEGER,
  last_error      TEXT,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS integration_cache (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id  TEXT NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_json      TEXT NOT NULL,
  fetched_at      INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_integration_cache_key ON integration_cache(integration_id, key);

-- Suggested next-step items computed when a task completes.
CREATE TABLE IF NOT EXISTS suggestions (
  id          TEXT PRIMARY KEY,
  task_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,    -- integration | history | backlog
  source_ref  TEXT NOT NULL,
  title       TEXT NOT NULL,
  body_md     TEXT,
  status      TEXT NOT NULL,    -- shown | pinned | dismissed
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_suggestions_status ON suggestions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_suggestions_task   ON suggestions(task_id);

-- User-submitted bug reports about the orchestrator itself. The "Bug" button
-- in the frontend posts an HTML snapshot + optional comment. The
-- orchestrator-debugger background agent picks these up alongside the daily
-- log scan and produces findings.
CREATE TABLE IF NOT EXISTS bug_reports (
  id              TEXT PRIMARY KEY,
  page_url        TEXT NOT NULL,
  user_agent      TEXT,
  comment         TEXT,
  html_snapshot   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',  -- open | investigating | resolved | dismissed
  task_id         TEXT REFERENCES tasks(id),     -- set when the debugger spawns a task for it
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_status ON bug_reports(status, created_at DESC);
