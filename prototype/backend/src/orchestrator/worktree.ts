/**
 * Per-task git worktree management.
 *
 * Each task that may modify code runs in its own `git worktree`, branched
 * from the parent repo's current HEAD onto a dedicated `agent/<id>`
 * branch. The agent's `cwd` is the worktree path, so:
 *   - the agent's edits land in the worktree, not the parent checkout
 *   - the parent's current branch keeps moving without conflicts
 *   - `git diff` against the worktree's branch base is exactly the
 *     task's work, regardless of how main has moved on
 *   - finalize (commit current / commit new branch) merges the
 *     worktree's commits into the parent.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { log } from "../log";
import { readAllSettings } from "../db/settings";

export interface WorktreeHandle {
  path: string;
  branch: string;
  baseRef: string;
}

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  while (cur !== "/" && cur !== "") {
    if (existsSync(join(cur, ".git"))) return cur;
    cur = dirname(cur);
  }
  return null;
}

function git(
  cwd: string,
  args: string[],
): { code: number; stdout: string; stderr: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  return { code: r.status ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Resolve the worktree root: settings override, else a local default. */
export function resolveWorktreeRoot(): string {
  const setting = readAllSettings().worktree_root?.trim();
  if (setting) return setting.replace(/^~/, homedir());
  return join(homedir(), ".local", "share", "agent-orchestrator", "worktrees");
}

/** Slugify a task id into a safe branch component. */
function safeBranchName(taskId: string): string {
  const stripped = taskId.replace(/^tsk_/, "");
  // Branch components: keep alnum + dash; cap length so it fits cleanly.
  return `agent/${stripped.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 32)}`;
}

/** Repo name used as the per-repo subdir under the worktree root. */
function repoNameFor(parentRoot: string): string {
  return parentRoot.split("/").filter(Boolean).pop() ?? "repo";
}

export interface CreateWorktreeInput {
  taskId: string;
  parentRoot: string;
  baseRef: string;
}

/**
 * Create the worktree if it doesn't exist. Returns the existing handle if
 * one is already on disk (idempotent across retries / crashes).
 */
export function createWorktree(input: CreateWorktreeInput): WorktreeHandle {
  const root = resolveWorktreeRoot();
  const repoName = repoNameFor(input.parentRoot);
  const path = join(root, repoName, input.taskId);
  const branch = safeBranchName(input.taskId);

  if (existsSync(path)) {
    log.info("worktree.reuse", { taskId: input.taskId, path, branch });
    return { path, branch, baseRef: input.baseRef };
  }

  mkdirSync(dirname(path), { recursive: true });

  // git worktree add -b <branch> <path> <baseRef>
  const r = git(input.parentRoot, ["worktree", "add", "-b", branch, path, input.baseRef]);
  if (r.code !== 0) {
    log.error("worktree.create.failed", {
      taskId: input.taskId,
      path,
      branch,
      stderr: r.stderr.slice(0, 600),
    });
    throw new Error(`git worktree add failed: ${r.stderr.trim() || "(no stderr)"}`);
  }

  log.info("worktree.created", { taskId: input.taskId, path, branch, baseRef: input.baseRef });
  return { path, branch, baseRef: input.baseRef };
}

export interface RemoveWorktreeInput {
  parentRoot: string;
  worktreePath: string;
  force?: boolean;
}

export function removeWorktree(input: RemoveWorktreeInput): void {
  const args = ["worktree", "remove", input.worktreePath];
  if (input.force) args.push("--force");
  const r = git(input.parentRoot, args);
  if (r.code !== 0) {
    log.warn("worktree.remove.failed", {
      worktreePath: input.worktreePath,
      stderr: r.stderr.slice(0, 600),
    });
  } else {
    log.info("worktree.removed", { worktreePath: input.worktreePath });
  }
}

/**
 * Commit any uncommitted changes inside the worktree. Returns the new HEAD
 * sha + list of files in the commit, or null if there was nothing staged.
 */
export interface CommitInWorktreeInput {
  worktreePath: string;
  message: string;
}

export interface CommitInWorktreeResult {
  ok: boolean;
  sha: string | null;
  files: string[];
  log: string[];
}

export function commitInWorktree(input: CommitInWorktreeInput & { baseRef?: string }): CommitInWorktreeResult {
  const trail: string[] = [];
  const sayRun = (label: string, r: { code: number; stdout: string; stderr: string }) => {
    const tail = (s: string) => s.trim().split("\n").slice(-3).join(" | ");
    trail.push(
      `${label} → exit ${r.code}` +
        (r.stdout ? ` · stdout: ${tail(r.stdout)}` : "") +
        (r.stderr ? ` · stderr: ${tail(r.stderr)}` : ""),
    );
  };

  const status = git(input.worktreePath, ["status", "--porcelain"]);
  sayRun("git status --porcelain", status);
  const dirty = status.stdout.trim().length > 0;

  // Path A: dirty tree → stage + commit normally.
  if (dirty) {
    const add = git(input.worktreePath, ["add", "-A"]);
    sayRun("git add -A", add);
    const commit = git(input.worktreePath, ["commit", "-m", input.message]);
    sayRun("git commit", commit);
    if (commit.code !== 0) {
      return { ok: false, sha: null, files: [], log: trail };
    }
    const sha = git(input.worktreePath, ["rev-parse", "HEAD"]);
    sayRun("git rev-parse HEAD", sha);
    const files = git(input.worktreePath, ["show", "--name-only", "--pretty=format:", "HEAD"]);
    sayRun("git show --name-only HEAD", files);
    return {
      ok: true,
      sha: sha.stdout.trim(),
      files: files.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean),
      log: trail,
    };
  }

  // Path B: clean tree but the agent may have already committed (the
  // build agent's bash tool can run `git commit` directly even though
  // we ask it not to). Compare HEAD to base_ref; if HEAD has moved,
  // the work is already on the agent branch — treat that as success.
  if (input.baseRef) {
    const sha = git(input.worktreePath, ["rev-parse", "HEAD"]);
    sayRun("git rev-parse HEAD", sha);
    const headSha = sha.stdout.trim();
    if (headSha && headSha !== input.baseRef) {
      const files = git(
        input.worktreePath,
        ["diff", `${input.baseRef}..HEAD`, "--name-only"],
      );
      sayRun(`git diff ${input.baseRef}..HEAD --name-only`, files);
      trail.push(
        "tree was clean but HEAD moved past base — treating agent's existing commit(s) as the change",
      );
      return {
        ok: true,
        sha: headSha,
        files: files.stdout.trim().split("\n").map((s) => s.trim()).filter(Boolean),
        log: trail,
      };
    }
  }

  // Truly nothing to commit.
  return { ok: false, sha: null, files: [], log: trail };
}

/**
 * Move the worktree's branch tip into the parent repo's current branch
 * via `git merge --ff-only`. If FF isn't possible (parent moved past the
 * base ref while the agent worked), the merge fails and the caller falls
 * back to "commit to new branch" (or surfaces the error).
 *
 * In a worktree setup, the parent and the worktree share the same `.git`
 * object database, so the parent can reference `agent/<task>` directly.
 */
export interface FastForwardInput {
  parentRoot: string;
  worktreeBranch: string;
}

export interface FastForwardResult {
  ok: boolean;
  parentBranch: string;
  message?: string;
  log: string[];
}

export function fastForwardParent(input: FastForwardInput): FastForwardResult {
  const trail: string[] = [];
  const sayRun = (label: string, r: { code: number; stdout: string; stderr: string }) => {
    trail.push(`${label} → exit ${r.code}` + (r.stderr ? ` · ${r.stderr.trim().split("\n").slice(-2).join(" | ")}` : ""));
  };

  const head = git(input.parentRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
  sayRun("git rev-parse HEAD (parent)", head);
  const parentBranch = head.stdout.trim();

  const merge = git(input.parentRoot, ["merge", "--ff-only", input.worktreeBranch]);
  sayRun(`git merge --ff-only ${input.worktreeBranch}`, merge);
  if (merge.code !== 0) {
    return {
      ok: false,
      parentBranch,
      message:
        `Parent branch '${parentBranch}' has moved since the worktree was created — ` +
        `fast-forward refused. Use 'Commit to new branch' to keep the agent's commits ` +
        `on '${input.worktreeBranch}', or rebase manually.`,
      log: trail,
    };
  }

  return { ok: true, parentBranch, log: trail };
}

/**
 * Rename the worktree's `agent/<id>` branch to a user-chosen name. The
 * worktree itself stays in place; from the parent repo, `git checkout
 * <name>` switches the parent's HEAD to that branch.
 */
export interface RenameBranchInput {
  parentRoot: string;
  fromBranch: string;
  toBranch: string;
}

export interface RenameBranchResult {
  ok: boolean;
  message?: string;
  log: string[];
}

export function renameBranch(input: RenameBranchInput): RenameBranchResult {
  const r = git(input.parentRoot, ["branch", "-m", input.fromBranch, input.toBranch]);
  return {
    ok: r.code === 0,
    message: r.code === 0 ? undefined : r.stderr.trim() || "(no stderr)",
    log: [`git branch -m ${input.fromBranch} ${input.toBranch} → exit ${r.code}`],
  };
}

export { findRepoRoot };
