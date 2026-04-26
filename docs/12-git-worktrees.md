# Git Worktrees for Agent Isolation

Every agent task that may modify code runs in its own **git worktree** on its own branch. The user can open the worktree in their normal IDE (VS Code, JetBrains, neovim) and watch / inspect changes live, without polluting the working tree they're actively coding in.

## Why worktrees

Without isolation:
- Agents step on the user's uncommitted changes.
- Multiple parallel agents on the same repo race each other.
- "What did the agent actually change?" requires diffing against an unstable HEAD.
- The user can't keep coding while an agent runs.

With worktrees:
- Each task gets a clean, independent checkout on a dedicated branch.
- The user's main working tree is untouched.
- The IDE can be pointed at the worktree path; agent changes appear in the editor's file watcher in real time.
- Cleanup is `git worktree remove`; nothing about the parent repo is affected.
- Branches make it natural to cherry-pick, push, or open a PR from a worktree later.

## When a worktree is created

| Workspace | Worktree? |
|---|---|
| Review (read-only — diff or path inspection) | No. Agents run with `cwd` = the user-provided path; no writes expected. |
| Feature | Yes — created at the start of the Implement gate (after Spec & Plan are approved). |
| Bugfix | Yes — created at the start of the Implement gate. |
| Architecture Compare | Yes if the analysis writes scratch files; otherwise no. v1: no. |
| Background — `dead-code-detector`, `todo-aging`, `doc-drift` | No (read-only analyses). |
| Background — agents that *propose patches* | Yes (v2). |

The worktree only exists for the duration of agent activity + however long the user wants to keep inspecting it. Read-only flows skip the cost.

## Layout and naming

Worktrees live outside the parent repo, in a configurable root directory:

- Default: `~/.local/share/agent-orchestrator/worktrees/<repo-name>/<task-id>/`
- Configurable in Settings → General → "Worktree root" (must be a writable absolute path).
- Branch name: `agent/<task-id>` or `agent/<workspace>-<short-id>` for readability (e.g. `agent/feature-7f3a`).

The worktree path is **shown prominently** in the task UI with a "copy path" button and an "open in IDE" affordance (configurable IDE command in Settings — defaults to `$EDITOR` env var).

## Lifecycle

```
task created
   │
   ▼
spec & plan approved (Feature/Bugfix only)
   │
   ▼
backend runs:
   git worktree add <root>/<repo>/<task-id> -b agent/<task-id> <baseRef>
   │  baseRef defaults to the parent repo's current HEAD; user-overridable per task
   ▼
OpenCode session opened with cwd = worktree path
   ▼
agent works → user inspects in IDE in real time → user can comment into agent
   ▼
task accepted / sent back / archived
   ▼
on archive (or manual cleanup): git worktree remove <path> [--force]
```

Worktrees are **not** auto-removed on task completion. The user explicitly archives or removes them. Reasons:

- The user may want to keep inspecting after the agent is done.
- The user may want to push the branch and open a PR from the worktree.
- Auto-cleanup risks deleting work the user wanted to keep.

A "Worktrees" sub-section in Settings → General lists all known worktrees with size, age, last commit, and a Remove button. Plus a "Sweep older than N days" action.

## Concurrency interaction

The job queue's `max_parallel_tasks` already limits foreground concurrency. Worktrees add:

- One worktree per active task (foreground or background-with-patches).
- Disk usage: each worktree is essentially a working-tree-sized copy of the repo (excluding `.git` proper, which is shared via `.git/worktrees/`).
- For Node/Bun projects, `node_modules` is a real concern — by default a fresh worktree has none. Three options the agent setup script can pick from (per-repo configurable):
  1. **Reinstall** in the worktree (`bun install`). Slow but correct.
  2. **Bind-mount or symlink** the parent's `node_modules` (fast but fragile across branches with different deps).
  3. **Pnpm-style content-addressed cache** if available in the repo's setup.
  Default v1: option 1 (reinstall), with a "skip dep install" toggle for repos where it's unnecessary.
- Settings: `worktree_max_age_days` (default 14) — the sweep target, soft. Nothing is auto-deleted until the user runs the sweep.

## Requirements

- Parent path must be a git repo. We detect via `git rev-parse --is-inside-work-tree` before offering Feature/Bugfix tabs for that repo. Otherwise the tab shows a paper-toned message: "Feature and Bugfix workflows require a git repository. Run `git init` to enable."
- The user must specify the **repo path** when starting Feature/Bugfix tasks. v1: a simple path picker. The path is persisted as `tasks.repo_path`.
- Branch protection: we never operate against the parent repo's HEAD. All operations happen in the worktree.

## What the agent sees

The OpenCode session is opened with:
- `cwd` = worktree path
- `directory` query param on relevant API calls = worktree path
- The full repo is checked out at the worktree's branch
- `.git` works normally (worktrees share the object database with the parent)

The agent can `git status`, `git diff`, `git add`, `git commit` freely within the worktree. Pushes are off by default — we don't expose a remote to the agent unless the user explicitly enables it for the task. v1: pushes happen via the user from the IDE, not the agent.

## What the user sees

Per-task UI elements:

```
┌─ Worktree ─────────────────────────────────────────────────────────┐
│ ~/.local/share/agent-orchestrator/worktrees/myrepo/feature-7f3a/   │
│ Branch: agent/feature-7f3a   Base: main@e4c8a1                     │
│ 3 modified files · 1 untracked   [ Open in IDE ]   [ Copy path ]   │
└────────────────────────────────────────────────────────────────────┘
```

A small "Files changed" sub-list updates live as the agent works (driven by the `session.diff` events from OpenCode).

## v1 scope

In:
- Worktree creation per Feature/Bugfix task at Implement gate.
- Configurable worktree root.
- "Open in IDE" + "Copy path" affordances.
- Live "files changed" list driven by `session.diff` events.
- Settings → Worktrees list with Remove and Sweep.
- Repo-not-git detection with the friendly message.

Out (v2):
- Auto bind-mount `node_modules`.
- Background-agent worktrees.
- Push / PR from the UI.
- Multi-repo concurrent worktree views.

## Anti-patterns

- ❌ Auto-cleanup on task completion.
- ❌ Worktree path inside the parent repo's working tree.
- ❌ Operating on the parent repo's HEAD or branches directly from any agent.
- ❌ Sharing one worktree between multiple concurrent tasks.
