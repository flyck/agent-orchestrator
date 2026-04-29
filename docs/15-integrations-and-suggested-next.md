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

1. **Personal Access Token** — user pastes a token. Stored in `integrations.github.token` in SQLite (encrypted at rest with a key derived from a machine-bound secret — v1 simple symmetric key, v2 OS keychain).
2. **Use environment `GITHUB_TOKEN`** — if the env var is present, the user can opt to use that without storing anything. Useful on dev machines where it's already configured.

#### Required PAT scopes

The orchestrator does **read-only** ingestion plus a narrow set of explicit-write actions (commenting on a PR after the user clicks "post"). Pick the smallest scope set that covers your watched repos:

| Capability | Classic PAT scope | Fine-grained PAT permission |
|---|---|---|
| Read public issue/PR metadata + bodies | `public_repo` | Repository → "Issues: Read", "Pull requests: Read" |
| Read private issue/PR metadata + bodies | `repo` (full) | Repository → "Issues: Read", "Pull requests: Read", "Contents: Read" |
| Post a top-level comment on a PR (only when the user explicitly clicks the button — never autonomous) | `public_repo` or `repo` | Repository → "Pull requests: Write" |
| Post a formal review (`event: COMMENT`) on a PR (same explicit-click rule) | `public_repo` or `repo` | Repository → "Pull requests: Write" |

The orchestrator never:

- Pushes commits or branches.
- Creates, edits, or closes issues.
- Modifies repository settings.
- Reads secrets, workflows, or org-level data.

If you want the strictest minimum, generate a **fine-grained PAT scoped to the exact repos in your `watched_repos` allowlist** with only the four "Read" permissions (Contents, Issues, Pull requests, Metadata). The "Pull requests: Write" line is optional and only needed if you intend to use the post-comment / post-review buttons.

#### Per-integration scope (within the orchestrator)

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

1. **Integration data** — issues/PRs the user has explicitly **linked** to local tasks. When a linked task completes, the engine fetches the issue's current state from GitHub and surfaces it as a suggestion if it's still `open` ("Issue #142 still open: session timeout drift — does this task close it?"). The orchestrator never invents a link; the user authors them via the Spec tab's "Linked issues" panel. Future work: an inverse query to surface issues with no linked task ("you haven't started anything for #156 yet").
2. **Local task history** — your previous tasks in this repo that flagged deferred items in their specs ("Last spec on auth had a TODO for retry logic that wasn't implemented"). Implemented in Phase 18.
3. **Backlog files** — items from `BACKLOG.md` / README that mention the same areas. ("`BACKLOG.md` lists 'Add MFA flow' near auth.") **Deferred.**

### Why user-authored links instead of LLM matching

We considered passing all open issues + the just-completed task's spec to an LLM to infer connections. We rejected it: the user already knows which issue they were working on, the LLM hallucinates connections that aren't real, every refresh costs tokens, and surfacing noise that the user has to dismiss undermines the trust the panel needs. Manual links are zero-cost, deterministic, and aligned with the spec-driven mandate (the user authors the relationship; the agent does not).

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
  source_ref TEXT NOT NULL,            -- 'github:owner/name#142' for issue source, '<priorTaskId>:<line>' for history
  title TEXT NOT NULL,
  body_md TEXT,
  status TEXT NOT NULL,                -- shown | pinned | dismissed
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Many-to-many: tasks ←→ GitHub issues. User-authored. The integration
-- suggestion source reads this table to know which issues to refresh.
CREATE TABLE task_issue_links (
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  repo           TEXT NOT NULL,    -- "owner/name"
  issue_number   INTEGER NOT NULL,
  title_snapshot TEXT,             -- captured at link time for offline render
  url_snapshot   TEXT,
  linked_at      INTEGER NOT NULL,
  PRIMARY KEY (task_id, repo, issue_number)
);
```

## API surface (additions)

```
GET    /api/integrations
PUT    /api/integrations/:id            ← enable, set token, set repo allowlist
POST   /api/integrations/:id/test       ← probe connection
DELETE /api/integrations/:id            ← disconnect, clear stored token

GET    /api/tasks/:id/suggestions                      → list (status != dismissed)
PUT    /api/tasks/:id/suggestions/:sid                 ← pin | dismiss
POST   /api/tasks/:id/suggestions/refresh              ← re-run github source (manual)
GET    /api/suggestions/pinned                         → dashboard "Up next" feed

GET    /api/tasks/:id/issue-links                      → links for one task
POST   /api/tasks/:id/issue-links {ref, repo?}         ← validate against GitHub + persist
DELETE /api/tasks/:id/issue-links/:owner/:repo/:n      ← unlink
GET    /api/tasks/issue-links/by-tasks?ids=a,b,c       → batch (for card chips)
```

## Background refresh

The backend runs a `githubPoller` on a configurable interval (`settings.pr_review_poll_interval_minutes`, default 5). Two passes per tick:

1. **Issue refresh** — for every Done task with at least one issue link, re-run `generateGithubIssueSuggestions`. Picks up issue closes/opens the user has done on github.com without waiting for another task completion. Dismissed suggestions stay dismissed (no resurrection).
2. **PR auto-pickup** — list open PRs across `watched_repos` where the user is a requested reviewer. For any not yet present as a `workspace='review'` task, create one and start the orchestrator. Idempotent — relies on `tasks.metadata_json.github.{repo, number}` for dedup.

The user can also click "refresh from github" on the per-task suggestions panel for an immediate re-check.

## v1 scope

Shipped:
- Integrations tab in Settings (UI + storage).
- GitHub provider with PAT or env-var auth.
- Per-repo allowlist.
- "Suggested next" section per task with **history** + **integration (linked-issues)** sources.
- User-authored issue ↔ task linking (Spec tab) with #N chips on cards.
- Background poller: issue-state refresh + PR auto-pickup (every 5 min).
- Manual "refresh from github" on the per-task panel.
- Off switch (`suggestions_enabled` setting).

Deferred:
- BACKLOG.md scan as a third suggestion source.
- Inverse query — "open issues with no task linked yet" for the dashboard "Up next" feed (the `/pinned` endpoint exists; no UI yet).
- Auto-fetch of related issues/PRs on task creation (in favor of explicit linking).
- GitLab/Linear/Jira providers.
- OAuth flow for GitHub (PAT only in v1).
- MCP-tool exposure of integrations to agents.
- Slack notifications.
- Writing back to GitHub beyond the explicit-click PR comment/review proxy.

## Anti-patterns

- ❌ Auto-creating tasks from suggestions.
- ❌ Pre-filled specs from suggestions.
- ❌ Background polling that creates suggestions outside an active task. (Suggestions are computed when a task completes, not continuously.)
- ❌ Surfacing suggestions across repo boundaries the user hasn't allowlisted.
- ❌ Storing tokens in plaintext.
