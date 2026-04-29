/**
 * "Suggested next steps" generator. Spec: docs/15-integrations-and-suggested-next.md.
 *
 * v1 implements only the `history` source: when a task completes, scan
 * recent completed tasks in the same `repo_path` and surface lines from
 * their specs that look like deferred work (TODO / FIXME / "out of
 * scope" / "later" / "v2"). The point is to remind the user of items
 * they themselves flagged as not-done — not to propose new work.
 *
 * Anti-patterns (per the spec) we explicitly avoid:
 *   - No auto-creation of follow-up tasks.
 *   - No pre-filled spec drafts.
 *   - No background polling — generation runs only when a task finalizes.
 *   - No cross-repo bleed: results stay scoped to the source task's repo.
 */

import { Database } from "bun:sqlite";
import { db } from "../db/index";
import {
  SuggestionSource,
  SuggestionStatus,
  createSuggestion,
  findExistingSuggestion,
  setSuggestionStatus,
  type SuggestionRow,
} from "../db/suggestions";
import { TaskStatus, type TaskRow } from "../db/tasks";
import { readAllSettings } from "../db/settings";
import { listLinksForTask, type TaskIssueLink } from "../db/taskIssueLinks";
import { getGithubConfig } from "../db/integrations";
import { fetchIssue, GithubError } from "../integrations/github";
import { log } from "../log";

const HISTORY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS_PER_TASK = 5;
const MAX_HISTORY_TASKS_SCANNED = 20;
const MAX_ITEMS_PER_HISTORY_TASK = 2;

/** Patterns that flag a spec line as a deferred / TODO item. Conservative
 *  by design — false positives become noise the user has to dismiss. */
const DEFERRED_PATTERNS: RegExp[] = [
  /\b(TODO|FIXME|XXX)\b/i,
  /\b(skip(ped)?\s+for\s+now)\b/i,
  /\b(out\s+of\s+scope)\b/i,
  /\b(in\s+a\s+later|next\s+iteration|next\s+pass|future\s+work|future\s+pass)\b/i,
  /\bnot\s+(in\s+)?scope\b/i,
  /\b(v[2-9](\.\d+)?\s+(only|scope|feature)?)\b/i,
  /\bdefer(red)?\b/i,
];

function looksDeferred(line: string): boolean {
  return DEFERRED_PATTERNS.some((re) => re.test(line));
}

/** Strip leading markdown noise (#, -, *, >) and trailing whitespace. */
function clean(line: string): string {
  return line.replace(/^[#>\-*\s]+/, "").replace(/\s+$/, "");
}

/** A "deferred item" is a line that flags work AND has substance beyond
 *  the marker. Pure headers like "## Out of scope" trip the regex but
 *  carry no actionable text — skip them. */
function looksLikeUsefulItem(line: string): boolean {
  const cleaned = clean(line);
  if (cleaned.length < 14) return false;
  // The non-marker remainder should still have ≥ ~3 words of content.
  const remainder = cleaned
    .replace(/\b(TODO|FIXME|XXX)\b:?/i, "")
    .replace(/\b(out\s+of\s+scope|skip(ped)?\s+for\s+now|in\s+a\s+later|next\s+(iteration|pass)|future\s+(work|pass)|not\s+(in\s+)?scope|defer(red)?|v[2-9](\.\d+)?)\b:?/i, "")
    .trim();
  return remainder.split(/\s+/).filter(Boolean).length >= 3;
}

/** Pull at most N short, deferred-looking lines out of a spec body.
 *  Strips leading markdown noise (#, -, *, >) so the surfaced text reads
 *  like a sentence in the suggestions panel. */
export function extractDeferredItems(spec: string, limit = MAX_ITEMS_PER_HISTORY_TASK): string[] {
  if (!spec) return [];
  const out: string[] = [];
  for (const rawLine of spec.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length < 8 || line.length > 240) continue;
    if (!looksDeferred(line)) continue;
    if (!looksLikeUsefulItem(line)) continue;
    const cleaned = clean(line);
    if (out.includes(cleaned)) continue;
    out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function suggestionsEnabled(handle: Database): boolean {
  const s = readAllSettings(handle);
  // Default to enabled when the row is missing — spec defaults on.
  return s.suggestions_enabled !== false;
}

/** Recent completed tasks in the same repo, newest first, excluding self. */
function recentCompletedInRepo(
  task: TaskRow,
  handle: Database,
): TaskRow[] {
  if (!task.repo_path) return [];
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  return handle
    .query<TaskRow, [string, string, string, number, number]>(
      `SELECT * FROM tasks
        WHERE repo_path = ?
          AND status = ?
          AND id != ?
          AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?`,
    )
    .all(
      task.repo_path,
      TaskStatus.Done,
      task.id,
      cutoff,
      MAX_HISTORY_TASKS_SCANNED,
    );
}

/** Generate up to N history-based suggestions for a just-completed task.
 *  Idempotent — re-runs (e.g. on watchdog recovery) won't dupe entries. */
export function generateHistorySuggestions(
  task: TaskRow,
  handle: Database = db(),
): SuggestionRow[] {
  if (!suggestionsEnabled(handle)) {
    log.info("suggestions.skipped_disabled", { taskId: task.id });
    return [];
  }
  if (!task.repo_path) {
    return [];
  }

  const recent = recentCompletedInRepo(task, handle);
  const created: SuggestionRow[] = [];

  outer: for (const prior of recent) {
    const items = extractDeferredItems(prior.input_payload ?? "");
    for (const item of items) {
      if (created.length >= MAX_SUGGESTIONS_PER_TASK) break outer;
      const sourceRef = `${prior.id}:${item.slice(0, 80)}`;
      if (findExistingSuggestion(task.id, SuggestionSource.History, sourceRef, handle)) {
        continue;
      }
      const title = item.length > 120 ? `${item.slice(0, 117)}…` : item;
      const body = `From "${prior.title}" · noted ${formatRelative(prior.updated_at)}\n\n${item}`;
      created.push(
        createSuggestion(
          {
            task_id: task.id,
            source: SuggestionSource.History,
            source_ref: sourceRef,
            title,
            body_md: body,
          },
          handle,
        ),
      );
    }
  }

  if (created.length > 0) {
    log.info("suggestions.generated", {
      taskId: task.id,
      count: created.length,
      repo: task.repo_path,
    });
  }
  return created;
}

/**
 * GitHub-issue source: for each issue linked to this task, fetch its
 * current state. If the issue is still 'open' on GitHub, surface a
 * suggestion so the user remembers to either close it or keep working.
 *
 * Best-effort — when GitHub is unreachable or the integration isn't
 * connected, we silently skip. The history source still runs.
 *
 * Permissions: requires the GitHub integration token to have
 * `issues:read` on the linked repo. PATs with `repo` (private) or
 * `public_repo` (public) include that scope.
 */
export async function generateGithubIssueSuggestions(
  task: TaskRow,
  handle: Database = db(),
): Promise<SuggestionRow[]> {
  if (!suggestionsEnabled(handle)) return [];

  const links = listLinksForTask(task.id, handle);
  if (links.length === 0) return [];

  const cfg = getGithubConfig(handle);
  if (!cfg) {
    log.info("suggestions.github.no_integration", { taskId: task.id, links: links.length });
    return [];
  }

  const created: SuggestionRow[] = [];
  for (const link of links) {
    if (created.length >= MAX_SUGGESTIONS_PER_TASK) break;
    const sourceRef = `github:${link.repo}#${link.issue_number}`;
    try {
      const issue = await fetchIssue(cfg.token, link.repo, link.issue_number);
      if (issue.state !== "open") continue;
      const existing = findExistingSuggestion(
        task.id,
        SuggestionSource.Integration,
        sourceRef,
        handle,
      );
      if (existing) {
        // Refresh path: an earlier run already created this suggestion.
        // If the user dismissed it, leave it dismissed — don't resurrect.
        if (existing.status === SuggestionStatus.Dismissed) continue;
        // Bump it back to shown so the panel surfaces it again, in case
        // the issue re-opened or this is a manual refresh.
        if (existing.status !== SuggestionStatus.Shown && existing.status !== SuggestionStatus.Pinned) {
          setSuggestionStatus(existing.id, SuggestionStatus.Shown, handle);
        }
        continue;
      }
      const titleNote = issue.title.length > 100 ? issue.title.slice(0, 97) + "…" : issue.title;
      created.push(
        createSuggestion(
          {
            task_id: task.id,
            source: SuggestionSource.Integration,
            source_ref: sourceRef,
            title: `Issue #${issue.number} still open: ${titleNote}`,
            body_md: `${link.repo}#${issue.number} is open on GitHub.\n\nDoes this completed task close it? Either close the issue, or keep going on the remaining work.\n\n${issue.html_url}`,
          },
          handle,
        ),
      );
    } catch (err) {
      const status = err instanceof GithubError ? err.status : null;
      log.warn("suggestions.github.fetch_failed", {
        taskId: task.id,
        repo: link.repo,
        number: link.issue_number,
        status,
        error: String(err),
      });
      // Fall back to the snapshot — surface it as a suggestion anyway,
      // marked "could not refresh state". The user can pin or dismiss.
      const fallbackTitle = link.title_snapshot ?? "(unknown title)";
      const sliced = fallbackTitle.length > 100 ? fallbackTitle.slice(0, 97) + "…" : fallbackTitle;
      if (!findExistingSuggestion(task.id, SuggestionSource.Integration, sourceRef, handle)) {
        created.push(
          createSuggestion(
            {
              task_id: task.id,
              source: SuggestionSource.Integration,
              source_ref: sourceRef,
              title: `Issue #${link.issue_number}: ${sliced} (state unknown — github unreachable)`,
              body_md: link.url_snapshot ?? "",
            },
            handle,
          ),
        );
      }
    }
  }

  if (created.length > 0) {
    log.info("suggestions.github.generated", {
      taskId: task.id,
      count: created.length,
    });
  }
  return created;
}

/** Manual-refresh entry point — re-runs the github source on a task and
 *  returns the freshly computed suggestion set. Wired to the
 *  /api/tasks/:id/suggestions/refresh endpoint. */
export async function refreshSuggestions(
  task: TaskRow,
  handle: Database = db(),
): Promise<SuggestionRow[]> {
  await generateGithubIssueSuggestions(task, handle);
  // History suggestions are stable per task — no need to regenerate on
  // refresh. Just return the current list.
  return [];
}

function formatRelative(ts: number): string {
  const diffMs = Date.now() - ts;
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 8) return `${weeks}w ago`;
  const months = Math.round(days / 30);
  return `${months}mo ago`;
}
