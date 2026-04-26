/**
 * Repo-level read endpoints used by the inline task detail:
 *   GET /api/repo/diff    — current working-tree diff (vs HEAD) + untracked file list
 *   POST /api/repo/open   — spawn the user's IDE on a path
 *
 * Currently scope is the whole repo, since v1 doesn't yet isolate per-task
 * worktrees (Phase 12). When worktrees land, this gets a `?worktree=` param
 * to scope cwd accordingly.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { readAllSettings } from "../db/settings";
import { log } from "../log";

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

interface FileEntry {
  path: string;
  /** working-tree status from `git status --porcelain` (e.g. "M ", " M", "??", "A ") */
  status: string;
  added: number;
  deleted: number;
}

export const repo = new Hono();

repo.get("/diff", async (c) => {
  const root = findRepoRoot(import.meta.dir);
  if (!root) return c.json({ error: "no_repo", message: "no .git found above backend dir" }, 500);

  // Optional ?base=<sha> scopes the diff to "everything since this ref"
  // (committed + uncommitted). Defaults to HEAD = working-tree-only.
  const requestedBase = c.req.query("base");
  let base = "HEAD";
  if (requestedBase) {
    // Validate the ref exists; otherwise fall back to HEAD with a marker.
    const verify = await run("git", ["rev-parse", "--verify", `${requestedBase}^{commit}`], root);
    if (verify.code === 0) base = requestedBase;
  }

  // File list: status for working-tree state, plus diff --name-status for
  // anything committed since base. Merge them by path.
  const statusRes = await run("git", ["status", "--porcelain"], root);
  const map = new Map<string, FileEntry>();
  for (const line of statusRes.stdout.split("\n")) {
    if (line.length === 0) continue;
    const path = line.slice(3);
    map.set(path, { path, status: line.slice(0, 2), added: 0, deleted: 0 });
  }
  if (base !== "HEAD") {
    const since = await run("git", ["diff", `${base}..HEAD`, "--name-status"], root);
    for (const line of since.stdout.split("\n")) {
      const m = line.match(/^([A-Z])\s+(.+)$/);
      if (!m) continue;
      const [, code, path] = m;
      if (!map.has(path!)) {
        map.set(path!, { path: path!, status: `${code} `, added: 0, deleted: 0 });
      }
    }
  }

  // numstat for +/- per file, scoped to the chosen base
  const numstat = await run("git", ["diff", base, "--numstat"], root);
  for (const line of numstat.stdout.split("\n")) {
    const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
    if (!m) continue;
    const [, addStr, delStr, p] = m;
    const e = map.get(p!);
    if (e) {
      e.added = addStr === "-" ? 0 : Number(addStr);
      e.deleted = delStr === "-" ? 0 : Number(delStr);
    } else {
      map.set(p!, {
        path: p!,
        status: "  ",
        added: addStr === "-" ? 0 : Number(addStr),
        deleted: delStr === "-" ? 0 : Number(delStr),
      });
    }
  }

  const entries = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));

  // Unified patch
  const diff = await run("git", ["diff", base, "--no-color"], root);
  const MAX_DIFF_BYTES = 400_000;
  let patch = diff.stdout;
  let truncated = false;
  if (patch.length > MAX_DIFF_BYTES) {
    patch = patch.slice(0, MAX_DIFF_BYTES) + "\n\n…[truncated — diff too large]";
    truncated = true;
  }

  return c.json({
    repo_root: root,
    base,
    base_resolved: base !== "HEAD",
    files: entries,
    patch,
    truncated,
    fetched_at: Date.now(),
  });
});

const openSchema = z.object({
  /** "ide" uses ide_open_command; "magit" uses magit_open_command. */
  command: z.enum(["ide", "magit"]).default("ide"),
  /** Path passed to the command. If omitted, repo root is used. */
  path: z.string().max(1000).optional(),
});

/**
 * Splits a command line, preserving "..." quoted segments so things like
 * `'(magit-status "{path}")'` reach emacsclient as a single arg.
 */
function tokenize(cmdline: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  for (let i = 0; i < cmdline.length; i++) {
    const ch = cmdline[i]!;
    if (q) {
      if (ch === q) q = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      q = ch as '"' | "'";
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);
  return tokens;
}

repo.post("/open", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = openSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "invalid_open_args" }, 400);

  const settings = readAllSettings();
  const cmdline =
    parsed.data.command === "magit"
      ? settings.magit_open_command?.trim()
      : settings.ide_open_command?.trim();

  if (!cmdline) {
    const which =
      parsed.data.command === "magit" ? "magit_open_command" : "ide_open_command";
    return c.json(
      {
        error: "command_not_configured",
        message:
          `Set '${which}' in Settings → General first. ` +
          (parsed.data.command === "magit"
            ? `Example: 'emacsclient --no-wait --eval (magit-status-setup-buffer "{path}")' (assumes an emacs --daemon is running).`
            : `Example: 'code' or 'cursor --reuse-window'.`),
      },
      400,
    );
  }

  const root = findRepoRoot(import.meta.dir);
  if (!root) return c.json({ error: "no_repo" }, 500);

  const requested = parsed.data.path?.length ? parsed.data.path : root;
  const target = requested.startsWith("/") ? requested : join(root, requested);
  if (!target.startsWith(root)) {
    return c.json({ error: "path_outside_repo" }, 400);
  }

  // {path} placeholder: substitute everywhere it appears. If no placeholder,
  // append the path as the last arg (covers `code`, `cursor`, `subl`, etc.).
  let tokens = tokenize(cmdline);
  if (tokens.some((t) => t.includes("{path}"))) {
    tokens = tokens.map((t) => t.replaceAll("{path}", target));
  } else {
    tokens.push(target);
  }
  const cmd = tokens.shift();
  if (!cmd) return c.json({ error: "empty_command" }, 400);

  log.info("repo.open", { which: parsed.data.command, cmd, args: tokens, target });
  const proc = spawn(cmd, tokens, { cwd: root, detached: true, stdio: "ignore" });
  proc.unref();
  return c.json({ ok: true, cmd, args: tokens, target });
});
