/**
 * Finalize a task. With per-task worktrees, the agent's edits live on a
 * dedicated `agent/<id>` branch in its own working dir. Finalize commits
 * those edits inside the worktree, then either fast-forwards the parent
 * repo's current branch or renames the worktree branch into a fresh
 * user-named branch the parent can check out later.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "../log";
import { getTask, updateTaskStatus } from "../db/tasks";
import { recordActivity } from "../db/activities";
import {
  commitInWorktree,
  fastForwardParent,
  renameBranch,
} from "./worktree";

export interface FinalizeInput {
  strategy: "current" | "new";
  branch?: string;
  message?: string;
}

export interface FinalizeResult {
  ok: boolean;
  branch: string;
  commit: string | null;
  files_committed: string[];
  log: string[];
}

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  while (cur !== "/" && cur !== "") {
    if (existsSync(join(cur, ".git"))) return cur;
    cur = dirname(cur);
  }
  return null;
}

const SAFE_BRANCH_RE = /[^a-zA-Z0-9._/-]+/g;
function safeBranchName(raw: string): string {
  const trimmed = raw.trim().replace(SAFE_BRANCH_RE, "-").slice(0, 80);
  return trimmed || "agent-finalize";
}

export async function finalizeTask(
  taskId: string,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const parentRoot = findRepoRoot(import.meta.dir);
  if (!parentRoot) throw new Error("no .git found above backend dir — cannot finalize");

  const trail: string[] = [];

  log.info("orchestrator.finalize.start", {
    taskId,
    strategy: input.strategy,
    worktree_path: task.worktree_path,
    worktree_branch: task.worktree_branch,
  });

  // Path 1: legacy task with no worktree — keep the old in-place flow.
  if (!task.worktree_path || !task.worktree_branch) {
    log.warn("orchestrator.finalize.no_worktree", { taskId });
    return await legacyInPlaceFinalize(parentRoot, task.title, taskId, input);
  }

  // Path 2: worktree-based finalize.
  // Step 1: commit the agent's edits inside the worktree. If the agent
  // already committed (against orders — but the build agent's bash tool
  // sometimes does this), commitInWorktree detects HEAD past base and
  // succeeds with the existing SHA.
  const commitMsg = input.message ?? `${task.title}\n\n(via agent-orchestrator task ${task.id})`;
  const commit = commitInWorktree({
    worktreePath: task.worktree_path,
    message: commitMsg,
    baseRef: task.worktree_base_ref ?? undefined,
  });
  trail.push(...commit.log);
  if (!commit.ok) {
    return {
      ok: false,
      branch: task.worktree_branch,
      commit: null,
      files_committed: [],
      log: trail,
    };
  }

  // Step 2: route the commit per strategy.
  if (input.strategy === "new") {
    if (!input.branch) throw new Error("strategy='new' requires `branch`");
    const target = `agent/${safeBranchName(input.branch)}`;
    const ren = renameBranch({
      parentRoot,
      fromBranch: task.worktree_branch,
      toBranch: target,
    });
    trail.push(...ren.log);
    if (!ren.ok) {
      return {
        ok: false,
        branch: task.worktree_branch,
        commit: commit.sha,
        files_committed: commit.files,
        log: [...trail, `rename failed: ${ren.message ?? ""}`],
      };
    }
    updateTaskStatus(taskId, "done", "ready");
    log.info("orchestrator.finalize.ok", {
      taskId,
      strategy: "new",
      branch: target,
      commit: commit.sha,
    });
    recordActivity("finalize", "user", taskId, `→ ${target}`);
    return {
      ok: true,
      branch: target,
      commit: commit.sha,
      files_committed: commit.files,
      log: [
        ...trail,
        `Branch ${target} now holds the agent's commit. Switch to it from your shell with: git checkout ${target}`,
      ],
    };
  }

  // strategy === "current": fast-forward parent's current branch.
  const ff = fastForwardParent({ parentRoot, worktreeBranch: task.worktree_branch });
  trail.push(...ff.log);
  if (!ff.ok) {
    return {
      ok: false,
      branch: task.worktree_branch,
      commit: commit.sha,
      files_committed: commit.files,
      log: [...trail, ff.message ?? "fast-forward failed"],
    };
  }
  updateTaskStatus(taskId, "done", "ready");
  log.info("orchestrator.finalize.ok", {
    taskId,
    strategy: "current",
    branch: ff.parentBranch,
    commit: commit.sha,
  });
  recordActivity("finalize", "user", taskId, `→ ${ff.parentBranch}`);
  return {
    ok: true,
    branch: ff.parentBranch,
    commit: commit.sha,
    files_committed: commit.files,
    log: trail,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Legacy fallback for tasks created before per-task worktrees existed.
// Keeps git status + commit semantics on the parent repo's working tree.
async function legacyInPlaceFinalize(
  parentRoot: string,
  title: string,
  taskId: string,
  input: FinalizeInput,
): Promise<FinalizeResult> {
  const { spawn } = await import("node:child_process");
  const trail: string[] = [];
  const run = (cmd: string, args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const p = spawn(cmd, args, { cwd: parentRoot });
      let stdout = "";
      let stderr = "";
      p.stdout.on("data", (b) => (stdout += b.toString()));
      p.stderr.on("data", (b) => (stderr += b.toString()));
      p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
    });
  const sayRun = (label: string, r: { code: number; stdout: string; stderr: string }) =>
    trail.push(
      `${label} → exit ${r.code}` +
        (r.stderr ? ` · ${r.stderr.trim().split("\n").slice(-2).join(" | ")}` : ""),
    );

  const status = await run("git", ["status", "--porcelain"]);
  sayRun("git status --porcelain", status);
  if (status.stdout.trim().length === 0) {
    return { ok: false, branch: "(unchanged)", commit: null, files_committed: [], log: trail };
  }

  let branchName: string;
  if (input.strategy === "new") {
    if (!input.branch) throw new Error("strategy='new' requires `branch`");
    branchName = `agent/${safeBranchName(input.branch)}`;
    const co = await run("git", ["checkout", "-b", branchName]);
    sayRun(`git checkout -b ${branchName}`, co);
    if (co.code !== 0) throw new Error(`failed to create branch ${branchName}`);
  } else {
    const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
    sayRun("git rev-parse HEAD", head);
    branchName = head.stdout.trim();
  }

  const add = await run("git", ["add", "-A"]);
  sayRun("git add -A", add);

  const msg = input.message ?? `${title}\n\n(via agent-orchestrator task ${taskId})`;
  const commit = await run("git", ["commit", "-m", msg]);
  sayRun("git commit", commit);
  if (commit.code !== 0) throw new Error(`git commit failed`);

  const sha = await run("git", ["rev-parse", "HEAD"]);
  sayRun("git rev-parse HEAD", sha);
  const filesRes = await run("git", ["show", "--name-only", "--pretty=format:", "HEAD"]);
  sayRun("git show --name-only HEAD", filesRes);
  const files = filesRes.stdout
    .trim()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  updateTaskStatus(taskId, "done", "ready");
  return {
    ok: true,
    branch: branchName,
    commit: sha.stdout.trim(),
    files_committed: files,
    log: trail,
  };
}
