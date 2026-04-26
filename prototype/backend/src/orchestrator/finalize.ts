/**
 * Finalize a task: take the agent's working-tree changes (which the user
 * has already manually reviewed) and commit them either on the parent
 * branch or on a new branch.
 *
 * Assumes the agent edited files in the parent repo (no worktree wrapper
 * yet — that's Phase 12). The repo root is detected by walking up from
 * the orchestrator's cwd until a `.git` dir is found.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { log } from "../log";
import { getTask, updateTaskStatus, type TaskRow } from "../db/tasks";

export interface FinalizeInput {
  strategy: "current" | "new";
  /** Required when strategy === "new". Slugified into agent/<branch>. */
  branch?: string;
  /** Optional override; default uses the task title. */
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

function run(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (b) => (stdout += b.toString()));
    p.stderr.on("data", (b) => (stderr += b.toString()));
    p.on("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

const SAFE_BRANCH_RE = /[^a-zA-Z0-9._/-]+/g;
function safeBranchName(raw: string): string {
  const trimmed = raw.trim().replace(SAFE_BRANCH_RE, "-").slice(0, 80);
  return trimmed || "agent-finalize";
}

export async function finalizeTask(taskId: string, input: FinalizeInput): Promise<FinalizeResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);

  const repoRoot = findRepoRoot(import.meta.dir);
  if (!repoRoot) throw new Error("no .git found above backend dir — cannot finalize");

  const trail: string[] = [];
  const sayRun = (label: string, r: { code: number; stdout: string; stderr: string }) => {
    const tail = (s: string) => s.trim().split("\n").slice(-3).join(" | ");
    trail.push(
      `${label} → exit ${r.code}` +
        (r.stdout ? ` · stdout: ${tail(r.stdout)}` : "") +
        (r.stderr ? ` · stderr: ${tail(r.stderr)}` : ""),
    );
  };

  log.info("orchestrator.finalize.start", { taskId, strategy: input.strategy, repoRoot });

  // Confirm there's something staged or unstaged to commit. `git status --porcelain`
  // is empty if the tree is clean.
  const statusRes = await run("git", ["status", "--porcelain"], repoRoot);
  sayRun("git status --porcelain", statusRes);
  if (statusRes.stdout.trim().length === 0) {
    log.warn("orchestrator.finalize.nothing_to_commit", { taskId });
    return { ok: false, branch: "(unchanged)", commit: null, files_committed: [], log: trail };
  }

  // Optional new branch.
  let branchName: string;
  if (input.strategy === "new") {
    if (!input.branch) throw new Error("strategy='new' requires `branch`");
    branchName = `agent/${safeBranchName(input.branch)}`;
    const co = await run("git", ["checkout", "-b", branchName], repoRoot);
    sayRun(`git checkout -b ${branchName}`, co);
    if (co.code !== 0) {
      throw new Error(
        `failed to create branch ${branchName}: ${co.stderr.trim() || "(no stderr)"}`,
      );
    }
  } else {
    const head = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    sayRun("git rev-parse HEAD", head);
    branchName = head.stdout.trim();
  }

  // Stage everything and commit.
  const add = await run("git", ["add", "-A"], repoRoot);
  sayRun("git add -A", add);

  const commitMsg = input.message ?? `${task.title}\n\n(via agent-orchestrator task ${task.id})`;
  const commit = await run("git", ["commit", "-m", commitMsg], repoRoot);
  sayRun(`git commit`, commit);
  if (commit.code !== 0) {
    log.error("orchestrator.finalize.commit_failed", { taskId, stderr: commit.stderr.slice(0, 600) });
    throw new Error(`git commit failed: ${commit.stderr.trim() || "(no stderr)"}`);
  }

  const sha = await run("git", ["rev-parse", "HEAD"], repoRoot);
  sayRun("git rev-parse HEAD", sha);

  const filesRes = await run(
    "git",
    ["show", "--name-only", "--pretty=format:", "HEAD"],
    repoRoot,
  );
  sayRun("git show --name-only HEAD", filesRes);
  const files = filesRes.stdout
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Mark the orchestrator task closed with a final state.
  updateTaskStatus(taskId, "done", "ready");

  log.info("orchestrator.finalize.ok", {
    taskId,
    branch: branchName,
    commit: sha.stdout.trim(),
    files: files.length,
  });

  return {
    ok: true,
    branch: branchName,
    commit: sha.stdout.trim(),
    files_committed: files,
    log: trail,
  };
}

export function _internal_for_typecheck(_t: TaskRow): void {
  void _t;
}
