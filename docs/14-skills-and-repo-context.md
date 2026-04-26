# Skills Library & Repo Context

Two related mechanisms for giving agents better real-world context, so they don't have to discover the same things every run.

1. **Skills library** — a user-configured directory of markdown files containing reusable knowledge (conventions, runbooks, domain notes, gotchas). Relevant skills are surfaced to agents per task.
2. **Repo context auto-read** — when a task targets a git repo, every agent in that task sees the repo's README and any backlog-style files (BACKLOG.md, TODO.md, ROADMAP.md) as ambient context.

Both are about reducing the "blank-slate agent" problem without violating the spec-driven principle (the user still authors specs; this just gives the agents working background).

## Skills library

### What a skill is

A markdown file the user wrote that captures something agents should know. Examples:

- "How we name React components in this codebase"
- "Why we don't use the `requests` library — use `httpx` instead"
- "Deployment runbook for the staging environment"
- "Internal vocabulary: 'tenant' means org, 'workspace' means project"

Skills are **the user's institutional knowledge**, not the agent's role definition. They are orthogonal to the agent prompts in `prototype/backend/agents/`.

### Configuration

Settings → General → "Skills directory" — single optional path setting. Default: empty (no skills library configured).

When set, the backend:
- Scans the directory recursively for `*.md` files on startup.
- Watches for file changes via polling (every 30s) — no inotify dependency.
- Indexes each skill by its frontmatter (`name`, `description`, `when_to_use`, `tags`) plus filename.

### Skill file format

```markdown
---
name: HTTP client convention
description: We use httpx, not requests. AsyncClient for all server calls.
when_to_use: writing or reviewing Python code that makes HTTP calls
tags: [python, http, conventions]
---

# HTTP client convention

In this codebase, all outbound HTTP traffic uses `httpx`. The `requests`
library is banned because it doesn't support async and we standardised
on `asyncio` in 2024.

## Patterns
...
```

`when_to_use` is the most important field — it's what the matcher uses.

### How skills reach agents

For each agent run the backend computes a **relevant skills set** by:

1. **Tag match** — the agent role has a `relevant_skill_tags` field in its frontmatter (e.g. `[python, http, security]` for a security reviewer working on Python code).
2. **Keyword match** — the task input (spec, diff, file paths) is scanned for keywords appearing in skill `when_to_use` lines.
3. **Manual pin** — the user can pin specific skills to specific agents in Settings (per-agent skill picker), or globally to all agents.

The matched skills are appended to the agent's system prompt under a fixed header:

```
---
# Available reference material

You may consult the following skills written by the human you're working with.
Treat them as binding conventions for this codebase unless explicitly overridden.

## HTTP client convention
We use httpx, not requests. AsyncClient for all server calls.

[full skill body inlined]

## React component naming
...

---
```

A token budget caps how much skill content gets inlined per invocation (default `4000` tokens; configurable). If the relevant set exceeds the budget, skills are truncated by relevance score and a "(truncated — N more skills available)" footer is added.

### Why inline, not retrieve

OpenCode supports MCP servers and `/experimental/tool` endpoints which could host a "skills" tool the agent calls on demand. That's more elegant but more moving parts. v1 just inlines — predictable, deterministic, easy to debug. v2 can move to a tool-call model once we know what's actually being consulted.

### v1 scope (skills)

In:
- Single skills directory setting.
- File scan + frontmatter parse.
- Per-agent `relevant_skill_tags` field.
- Inlining matched skills into system prompt with a token budget.
- Settings UI: skills directory picker, per-agent skill pinning, "Rescan skills" button.

Out (v2):
- Vector / semantic retrieval.
- MCP-tool-based on-demand consultation.
- Cross-skill links / dependencies.
- Multiple skills directories.

## Repo context auto-read

### What it does

When a task has a `repo_path` (Feature, Bugfix, Architecture Compare, and Review-with-path), the backend reads a small set of conventional files from the repo and includes them as initial context to **every agent in the task**.

Files read, in order, first one wins for each category:

| Category | Files (first match wins) |
|---|---|
| Project overview | `README.md`, `README`, `Readme.md`, `docs/README.md` |
| Backlog / known work | `BACKLOG.md`, `TODO.md`, `ROADMAP.md`, `docs/BACKLOG.md`, `docs/TODO.md`, `docs/ROADMAP.md` |
| Contributing rules | `CONTRIBUTING.md`, `docs/CONTRIBUTING.md` |
| Changelog (recent only) | `CHANGELOG.md` (last N entries) |

Plus: extract any heading sections in the README named `## Backlog`, `## TODO`, `## Roadmap`, `## Known issues`, `## Open questions` — these often live inside the README rather than separate files.

### How it reaches agents

Two parts:

1. **Project overview block** — appended to the agent's system prompt under `# Project context` (after any inlined skills). Truncated to a configurable token budget (default `2000` tokens for the README, `1000` for backlog/contributing/changelog combined).

2. **Backlog notes** — surfaced separately in the task's UI (a small expandable panel near the input area that says "Backlog noted in this repo (3 items)"). The point is to remind *the user* that they had these listed — not to nudge the agent to start working on them. The agent only sees these as informational context.

### Token budget interaction

The budget order, per agent invocation:
1. Agent role prompt (variable, but typically 500–2000 tokens).
2. Inlined skills (up to 4000 tokens default).
3. Repo context: README (up to 2000) + backlog/contributing/changelog (up to 1000).
4. Task input (spec / diff / path).

If the total approaches the model's context window, the orchestrator truncates in reverse order (changelog → backlog → README → low-relevance skills → high-relevance skills → role prompt). Truncation is logged so we can tune budgets.

### Configuration

Settings → General → "Repo context" subsection:

- `repo_context_enabled` — default true. Off = no auto-read; agents start blank.
- `readme_token_budget` — default 2000.
- `backlog_token_budget` — default 1000.
- `extra_files_per_repo` (advanced) — list of additional file globs to read for specific repos. Per-repo overrides stored in `tasks.repo_path` keyed config (a `repo_overrides` table).

### Caching

Read once per task creation, cached in the task row (`tasks.repo_context_snapshot`). If the user re-runs a task or the repo has changed, the snapshot is refreshed. This means all agents in one task see the same snapshot, even if the repo changes mid-run.

### v1 scope (repo context)

In:
- Auto-read on task creation for tasks with a `repo_path`.
- README + first matching backlog file + CONTRIBUTING.
- Token budgets (configurable in Settings).
- "Backlog noted in this repo" UI panel.
- Snapshot cached per task.

Out (v2):
- Per-repo override config.
- Multi-file README aggregation (e.g. `docs/*.md` index).
- Reading remote repo info (issue trackers, etc).

## Anti-patterns

- ❌ Auto-creating tasks from backlog items found in README. The user reads, the user decides.
- ❌ Skill content drafted by agents. Skills are user-authored, like specs.
- ❌ Pulling in the entire `docs/` tree. Token budgets exist for a reason.
- ❌ Auto-pinning every skill to every agent. Relevance is the point.
- ❌ Surfacing backlog items as agent-driven recommendations ("Hey, you should work on item 3 from the README"). The agent sees backlog as context only.
