# Integrations & Suggested Next Steps

Two related features:

1. **Integrations tab in Settings** — connect external systems (v1: GitHub) so agents can read context (issues, PRs) without the user copy-pasting.
2. **Suggested next steps** — when a task completes, surface related work the user might want to tackle next, drawn from the integrated systems and the local task history. The point is to *reduce context-switching for the user*, not to start the work automatically.

Both respect the spec-driven principle: integrations *fetch* context, suggestions *surface* possibilities. The user still authors the spec for any new task.

## Integrations tab

Settings → Integrations. A vertical list of connectable services. v1 ships GitHub; the structure accommodates future ones (GitLab, Linear, Jira, Slack).

```
┌─ Integrations ──────────────────────────────────────────────────────┐
│                                                                      │
│ ◯ GitHub        not connected                                        │
│   Read issues, PRs, and recent activity from your repos.             │
│   [ Connect ]   [ Use environment GITHUB_TOKEN ]                     │
│                                                                      │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│ ◯ GitLab        not configured  (v2)                                 │
│ ◯ Linear        not configured  (v2)                                 │
│ ◯ Jira          not configured  (v2)                                 │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

### GitHub connection

Two paths:

1. **Personal Access Token** — user pastes a fine-grained PAT with `repo:read` and `issues:read` scopes. Stored in `integrations.github.token` in SQLite (encrypted at rest with a key derived from a machine-bound secret — v1 simple symmetric key, v2 OS keychain).
2. **Use environment `GITHUB_TOKEN`** — if the env var is present, the user can opt to use that without storing anything. Useful on dev machines where it's already configured.

Per-integration scope:
- Per-repo allowlist — the user explicitly lists which repos this orchestrator may read. No silent enumeration of every repo the token can see. Default: empty list, so nothing is fetched until the user adds at least one repo.
- Per-repo cache TTL — issues/PRs cached locally with a configurable TTL (default 10 minutes) to keep API usage low.

### What the GitHub integration enables

Each enabled integration provides a small set of typed operations the orchestrator can call. For GitHub v1:

- `list_open_issues(repo, labels?, since?)` — returns title, number, body excerpt, labels, assignees, updated.
- `list_open_prs(repo, touching_paths?, since?)` — returns title, number, body excerpt, head/base branches, files changed.
- `get_issue(repo, number)` — full body + comments.
- `get_pr(repo, number)` — full body + comments + diff stats.

These are wrapped in an `IntegrationProvider` interface mirroring the `EngineAdapter` pattern — same shape across providers. Adding GitLab later is one more class.

The provider is exposed to agents via:
- **Inlined context** in system prompt (small lists, e.g. "5 open issues with label `auth`").
- **MCP tool** in v2 — the agent can call `github.get_issue(123)` directly. v1 keeps it simpler with inlining only.

### Tasks-with-repos use it automatically

For Feature/Bugfix tasks with a `repo_path` that maps to a known GitHub repo (detected by `git remote -v`), the orchestrator:

- On task creation: fetches a small slate of related context — open issues touching the same files (best-effort match on file paths in PR descriptions), recent merged PRs in the area, open PRs against the base branch.
- Adds it to the task's "Repo context" panel (alongside README/backlog from `14-skills-and-repo-context.md`).
- Includes a 2000-token-budget excerpt in the planner agent's system prompt.

The user sees what was fetched and can prune anything that's not relevant before running.

## Suggested next steps

A dedicated section in each task's UI, below the synthesis/output, that proposes follow-up work. Three sources:

1. **Integration data** — open issues / PRs that touch the same areas the task touched. ("This task changed `src/auth/`. There are 2 open issues mentioning `auth`: #142 'session timeout drift', #156 'rate limit headers missing'.")
2. **Local task history** — your previous tasks in this repo that were related. ("You've worked on `src/auth/` 3 times in the last month. Last spec mentioned a TODO for retry logic that wasn't implemented.")
3. **Backlog files** — items from `BACKLOG.md` / README that mention the same areas. ("`BACKLOG.md` lists 'Add MFA flow' near auth.")

UI:

```
┌─ Suggested next ────────────────────────────────────────────────────┐
│ Based on this task's scope (auth, session)                           │
│                                                                      │
│ ▸ Open issue #142 · session timeout drift                            │
│   Mentioned in 3 closed PRs since Feb. [ Open issue ↗ ]              │
│   [ Pin ]   [ Dismiss ]                                              │
│                                                                      │
│ ▸ TODO from your spec on 2026-03-12: retry logic for auth requests   │
│   [ Pin ]   [ Dismiss ]                                              │
│                                                                      │
│ ▸ BACKLOG.md item: "Add MFA flow"                                    │
│   [ Pin ]   [ Dismiss ]                                              │
│                                                                      │
│ Pinned items appear in your home dashboard's "Up next" panel.        │
└──────────────────────────────────────────────────────────────────────┘
```

Behavior rules:

- **Surface, don't act.** Each suggestion has a "Pin" or "Dismiss" — never an "Auto-create task." Pinned items appear in a home-page "Up next" panel as reminders. Dismissed items are remembered for that task's scope (so the same suggestion doesn't keep coming back).
- **No agent-drafted spec for the suggestion.** When the user clicks a pinned item to start work on it, they go to the Feature tab with the suggestion's title and link as a context note — the spec editor is blank. (Same rule as background-agent findings.)
- **Limit count.** At most 5 suggestions per section, ranked by recency × relevance. More are hidden behind "show all."
- **Off switch.** A single setting toggles the entire feature off if the user finds it noisy.

### Why this is structurally distinct from auto-pilot

A reasonable concern: doesn't "suggested next" recreate the auto-accept slide we explicitly designed against?

The defense:
- Suggestions are *links to information*, not drafts of work.
- Acting on a suggestion still requires authoring a fresh spec.
- The user has a single off switch.
- There's no "Accept all" or "Auto-pin" button. Each item is a deliberate click.

The point is to **show the user what they might want to look at**, not to **do work for them**. That distinction is the design.

## Storage

```sql
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,                 -- 'github'
  enabled INTEGER NOT NULL DEFAULT 0,
  config_json TEXT NOT NULL,           -- token (encrypted), repo allowlist, cache TTL
  last_synced_at INTEGER,
  last_error TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE integration_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  integration_id TEXT NOT NULL REFERENCES integrations(id),
  key TEXT NOT NULL,                   -- e.g. 'github:repo:owner/name:issues:open'
  value_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES tasks(id),   -- the task this suggestion is "next after"
  source TEXT NOT NULL,                -- integration | history | backlog
  source_ref TEXT NOT NULL,            -- '#142' for github issue, etc.
  title TEXT NOT NULL,
  body_md TEXT,
  status TEXT NOT NULL,                -- shown | pinned | dismissed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

## API surface (additions)

```
GET    /api/integrations
PUT    /api/integrations/:id            ← enable, set token, set repo allowlist
POST   /api/integrations/:id/test       ← probe connection
DELETE /api/integrations/:id            ← disconnect, clear stored token

GET    /api/tasks/:id/suggestions       → ranked list with status
PUT    /api/tasks/:id/suggestions/:sid  ← pin | dismiss

GET    /api/suggestions/pinned          → dashboard "Up next" feed
```

## v1 scope

In:
- Integrations tab in Settings (UI + storage).
- GitHub provider with PAT or env-var auth.
- Per-repo allowlist.
- Auto-fetch of related issues/PRs on task creation for known-GitHub repos.
- "Suggested next" section per task.
- Pinned suggestions visible on the home dashboard.
- Off switch.

Out (v2):
- GitLab/Linear/Jira providers.
- OAuth flow for GitHub (PAT only in v1).
- MCP-tool exposure of integrations to agents.
- Slack notifications.
- Writing back to GitHub (commenting on issues/PRs from the orchestrator).

## Anti-patterns

- ❌ Auto-creating tasks from suggestions.
- ❌ Pre-filled specs from suggestions.
- ❌ Background polling that creates suggestions outside an active task. (Suggestions are computed when a task completes, not continuously.)
- ❌ Surfacing suggestions across repo boundaries the user hasn't allowlisted.
- ❌ Storing tokens in plaintext.
