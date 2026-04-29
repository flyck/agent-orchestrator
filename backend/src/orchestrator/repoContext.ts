/**
 * Repo context auto-read. When a task has a worktree, every agent in
 * that task gets the repo's README and any backlog-style files inlined
 * as ambient context — saves them from re-discovering the project's
 * shape on every run.
 *
 * Spec: docs/14-skills-and-repo-context.md.
 *
 * Bounded by token budgets from settings (readme_token_budget,
 * backlog_token_budget). Tokens are estimated as `chars / 4` — coarse
 * but cheap and consistent across providers.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";

const README_CANDIDATES = [
  "README.md",
  "README",
  "Readme.md",
  "readme.md",
  "docs/README.md",
];

const BACKLOG_CANDIDATES = [
  "BACKLOG.md",
  "TODO.md",
  "ROADMAP.md",
  "docs/BACKLOG.md",
  "docs/TODO.md",
  "docs/ROADMAP.md",
];

const CONTRIBUTING_CANDIDATES = [
  "CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
];

interface RepoContextOptions {
  /** Worktree root to read from. */
  cwd: string;
  /** Default 2000. Agent runs that overrun get the README truncated. */
  readmeTokenBudget?: number;
  /** Default 1000. Backlog + contributing share this slot. */
  backlogTokenBudget?: number;
}

interface FoundFile {
  /** Path relative to cwd, e.g. "README.md". */
  rel: string;
  text: string;
}

function findFirst(cwd: string, candidates: string[]): FoundFile | null {
  for (const rel of candidates) {
    const full = join(cwd, rel);
    if (!existsSync(full)) continue;
    try {
      const text = readFileSync(full, "utf8");
      return { rel, text };
    } catch (err) {
      log.warn("orchestrator.repoContext.read_failed", { path: full, error: String(err) });
    }
  }
  return null;
}

/**
 * Truncate at the configured token budget. Estimation is `chars / 4`,
 * matching the Anthropic / OpenAI rule-of-thumb. We trim on a paragraph
 * boundary when possible so the cut isn't mid-sentence.
 */
function truncateToTokens(text: string, budget: number): { text: string; truncated: boolean } {
  const charBudget = Math.max(0, budget * 4);
  if (text.length <= charBudget) return { text, truncated: false };
  let cut = text.slice(0, charBudget);
  // Prefer cutting at a paragraph break, otherwise a newline, otherwise raw.
  const para = cut.lastIndexOf("\n\n");
  const line = cut.lastIndexOf("\n");
  if (para > charBudget * 0.7) cut = cut.slice(0, para);
  else if (line > charBudget * 0.85) cut = cut.slice(0, line);
  return {
    text: `${cut}\n\n_[truncated — exceeded ${budget}-token budget]_`,
    truncated: true,
  };
}

/**
 * Render the auto-read block. Empty string when nothing is available
 * (no worktree, no candidate files) so callers can concat unconditionally.
 */
export function renderRepoContext(opts: RepoContextOptions): string {
  const cwd = opts.cwd?.trim();
  if (!cwd) return "";

  const readmeBudget = opts.readmeTokenBudget ?? 2000;
  const backlogBudget = opts.backlogTokenBudget ?? 1000;

  const readme = findFirst(cwd, README_CANDIDATES);
  const backlog = findFirst(cwd, BACKLOG_CANDIDATES);
  const contributing = findFirst(cwd, CONTRIBUTING_CANDIDATES);

  if (!readme && !backlog && !contributing) return "";

  const parts: string[] = [];
  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("# Project context");
  parts.push("");
  parts.push("Auto-read from the repo. Treat as informational background — the user's spec is still the binding instruction. Don't act on backlog items unless the spec asks for them.");

  if (readme) {
    const { text, truncated } = truncateToTokens(readme.text, readmeBudget);
    parts.push("");
    parts.push(`## ${readme.rel}${truncated ? " (truncated)" : ""}`);
    parts.push("");
    parts.push(text);
  }

  // Backlog + contributing share the second budget; we give the budget
  // to whichever is present in priority order.
  let remainingBacklog = backlogBudget;
  if (backlog) {
    const { text, truncated } = truncateToTokens(backlog.text, remainingBacklog);
    remainingBacklog -= Math.min(remainingBacklog, Math.ceil(backlog.text.length / 4));
    parts.push("");
    parts.push(`## ${backlog.rel}${truncated ? " (truncated)" : ""}`);
    parts.push("");
    parts.push(text);
  }
  if (contributing && remainingBacklog > 200) {
    const { text, truncated } = truncateToTokens(contributing.text, remainingBacklog);
    parts.push("");
    parts.push(`## ${contributing.rel}${truncated ? " (truncated)" : ""}`);
    parts.push("");
    parts.push(text);
  }

  return parts.join("\n");
}
