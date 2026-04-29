/**
 * Background GitHub poller. Two passes per tick (interval =
 * settings.pr_review_poll_interval_minutes; default 5 min):
 *
 *   1. Issue refresh — for every Done task with linked issues, re-run
 *      the GitHub-issue suggestion source. Picks up issue closes/opens
 *      the user has done on github.com without waiting for another
 *      task completion.
 *
 *   2. PR auto-pickup — list open PRs across watched repos where the
 *      user is a requested reviewer, and create a PR-review task for
 *      any not yet present. Starts the orchestrator on each new task.
 *
 * Best-effort. Errors on individual records are logged and skipped;
 * we don't want one bad PR or one rate-limited request to wedge the
 * whole tick.
 */

import { getGithubConfig } from "../db/integrations";
import { readAllSettings } from "../db/settings";
import {
  createTask,
  getTask,
  parseTaskMetadata,
  setTaskMetadata,
  TaskStatus,
  type TaskRow,
} from "../db/tasks";
import { db } from "../db/index";
import {
  fetchPullDiff,
  fetchPullRequest,
  isRequestedReviewer,
  listPullRequests,
  PullFilter,
} from "../integrations/github";
import { log } from "../log";
import { generateGithubIssueSuggestions } from "./suggestions";
import { startRun } from "./index";

let pollerTimer: ReturnType<typeof setInterval> | null = null;
/** Set true on the first tick after start so an explicit kickoff runs
 *  on boot rather than waiting a full interval. */
let firstTickPending = true;

const DEFAULT_INTERVAL_MIN = 5;

function intervalMs(): number {
  const s = readAllSettings();
  const n = Number(s.pr_review_poll_interval_minutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_INTERVAL_MIN * 60_000;
  return Math.max(60_000, n * 60_000); // floor at 1 min
}

/** Tasks that are Done and have at least one issue link. We only refresh
 *  for these — running tasks haven't finalized yet so suggestions don't
 *  surface, and queued tasks haven't seen their first generation pass. */
function listDoneTasksWithLinks(): TaskRow[] {
  return db()
    .query<TaskRow, [string]>(
      `SELECT DISTINCT t.* FROM tasks t
         INNER JOIN task_issue_links l ON l.task_id = t.id
        WHERE t.status = ?
        ORDER BY t.updated_at DESC
        LIMIT 200`,
    )
    .all(TaskStatus.Done);
}

/** Find an existing task for a given (repo, prNumber). The metadata is
 *  stored as JSON in `tasks.metadata_json` — LIKE-match on the embedded
 *  coordinates. Fragile vs. a proper column, but avoids a migration. */
function findTaskForPr(repo: string, number: number): TaskRow | null {
  const pattern = `%"github":%"repo":"${repo}"%"number":${number}%`;
  const altPattern = `%"github":%"number":${number}%"repo":"${repo}"%`;
  const handle = db();
  const r =
    handle
      .query<TaskRow, [string]>(
        "SELECT * FROM tasks WHERE metadata_json LIKE ? LIMIT 1",
      )
      .get(pattern) ??
    handle
      .query<TaskRow, [string]>(
        "SELECT * FROM tasks WHERE metadata_json LIKE ? LIMIT 1",
      )
      .get(altPattern);
  if (r) return r;
  // Fall-through: scan candidates and parse metadata. Slow but reliable.
  const candidates = handle
    .query<TaskRow, never[]>(
      `SELECT * FROM tasks WHERE workspace = 'review' AND metadata_json IS NOT NULL ORDER BY created_at DESC LIMIT 500`,
    )
    .all();
  for (const t of candidates) {
    const meta = parseTaskMetadata(t.metadata_json);
    if (meta?.github?.repo === repo && meta.github.number === number) return t;
  }
  return null;
}

function renderPrInput(repo: string, prTitle: string, prBody: string | null, diff: string): string {
  return `# PR ${repo} — ${prTitle}\n\n${prBody ?? "(no description)"}\n\n---\n\n\`\`\`diff\n${diff}\n\`\`\`\n`;
}

async function refreshIssueSuggestionsTick(): Promise<void> {
  const tasks = listDoneTasksWithLinks();
  for (const t of tasks) {
    try {
      await generateGithubIssueSuggestions(t);
    } catch (err) {
      log.warn("github_poller.issue_refresh_failed", { taskId: t.id, error: String(err) });
    }
  }
  if (tasks.length > 0) {
    log.info("github_poller.issue_refresh_done", { tasks: tasks.length });
  }
}

async function pickupPrsTick(): Promise<void> {
  const cfg = getGithubConfig();
  if (!cfg || !cfg.login) return;
  if (cfg.watched_repos.length === 0) return;

  let prs;
  try {
    prs = await listPullRequests(
      cfg.token,
      cfg.watched_repos,
      PullFilter.AwaitingMe,
      cfg.login,
    );
  } catch (err) {
    log.warn("github_poller.list_prs_failed", { error: String(err) });
    return;
  }

  for (const pr of prs) {
    const repo = pr.repo_full_name;
    const number = pr.number;
    if (!repo || !Number.isFinite(number)) continue;
    if (findTaskForPr(repo, number)) continue;

    // Re-confirm reviewer status — search-API result can lag.
    try {
      const ok = await isRequestedReviewer(cfg.token, repo, number, cfg.login);
      if (!ok) continue;
    } catch (err) {
      log.warn("github_poller.reviewer_check_failed", { repo, number, error: String(err) });
      continue;
    }

    let prDetail;
    let diff: string;
    try {
      prDetail = await fetchPullRequest(cfg.token, repo, number);
      diff = await fetchPullDiff(cfg.token, repo, number);
    } catch (err) {
      log.warn("github_poller.fetch_pr_failed", { repo, number, error: String(err) });
      continue;
    }

    const task = createTask({
      workspace: "review",
      title: `${repo}#${number} — ${prDetail.title}`,
      input_kind: "diff",
      input_payload: renderPrInput(repo, prDetail.title, prDetail.body, diff),
      repo_path: null,
      initial_state: "review",
    });
    setTaskMetadata(task.id, {
      github: {
        repo,
        number,
        base_ref: prDetail.base.ref,
        head_ref: prDetail.head.ref,
        html_url: prDetail.html_url,
      },
    });
    log.info("github_poller.pr_task_created", { taskId: task.id, repo, number });
    startRun(task.id).catch((err) =>
      log.warn("github_poller.start_run_failed", { taskId: task.id, error: String(err) }),
    );
  }
}

async function tick(): Promise<void> {
  await Promise.allSettled([refreshIssueSuggestionsTick(), pickupPrsTick()]);
}

export function startGithubPoller(): void {
  if (pollerTimer) return;
  const ms = intervalMs();
  log.info("github_poller.started", { intervalMs: ms });
  // Kick off once on boot (after a small delay so the rest of the
  // backend has settled), then settle into the interval cadence.
  setTimeout(() => {
    if (!firstTickPending) return;
    firstTickPending = false;
    tick().catch((err) => log.warn("github_poller.tick_failed", { error: String(err) }));
  }, 5_000);
  pollerTimer = setInterval(() => {
    tick().catch((err) => log.warn("github_poller.tick_failed", { error: String(err) }));
  }, ms);
}

export function stopGithubPoller(): void {
  if (!pollerTimer) return;
  clearInterval(pollerTimer);
  pollerTimer = null;
}
