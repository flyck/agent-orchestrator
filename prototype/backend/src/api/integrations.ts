/**
 * Integrations API. The base /api/integrations endpoint lists known
 * providers and their status; /api/integrations/github/* is the
 * GitHub-specific shape (token + watched repos + PR list).
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  deleteIntegration,
  getGithubConfig,
  getIntegration,
  markError,
  markSynced,
  upsertIntegration,
} from "../db/integrations";
import {
  fetchPullDiff,
  fetchPullRequest,
  isRequestedReviewer,
  listPullRequests,
  listRepos,
  validate,
  type GithubPull,
  type PullFilter,
} from "../integrations/github";
import { createTask } from "../db/tasks";
import { startRun } from "../orchestrator";
import { log } from "../log";

interface IntegrationListItem {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  last_synced_at: number | null;
  last_error: string | null;
  /** GitHub only — surfaced so the UI can label "connected as @login". */
  login?: string | null;
  /** GitHub only — opt-in repo list so the UI can render the multi-select
   *  state without a separate request. */
  watched_repos?: string[];
}

const KNOWN: { id: string; name: string; description: string }[] = [
  { id: "github",    name: "GitHub",    description: "Read PRs awaiting your review across watched repos." },
  { id: "bitbucket", name: "Bitbucket", description: "Read PRs and issues from configured repos." },
  { id: "gitlab",    name: "GitLab",    description: "Read MRs and issues from configured projects." },
];

export const integrations = new Hono();

integrations.get("/", (c) => {
  const items: IntegrationListItem[] = KNOWN.map((k) => {
    const row = getIntegration(k.id);
    const base: IntegrationListItem = {
      id: k.id,
      name: k.name,
      description: k.description,
      configured: !!row,
      enabled: row?.enabled === 1,
      last_synced_at: row?.last_synced_at ?? null,
      last_error: row?.last_error ?? null,
    };
    if (k.id === "github") {
      const cfg = getGithubConfig();
      base.login = cfg?.login ?? null;
      base.watched_repos = cfg?.watched_repos ?? [];
    }
    return base;
  });
  return c.json({
    integrations: items,
    any_enabled: items.some((i) => i.enabled),
  });
});

// ─── GitHub ──────────────────────────────────────────────────────────────

const connectSchema = z.object({
  /** New token — replaces whatever is stored. Pass null to keep existing
   *  while updating watched_repos in the same call. */
  token: z.string().min(20).max(400).nullable().optional(),
  /** Full names: "owner/name". Empty array clears the watch list. */
  watched_repos: z.array(z.string().min(3).max(140)).max(50).optional(),
});

/**
 * Set the token + watched repos. The token is validated against
 * /user before persisting; an invalid token is rejected with the
 * github status code so the UI can show "401 — token rejected".
 */
integrations.post("/github/connect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = connectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }

  const existing = getGithubConfig();
  const token = parsed.data.token ?? existing?.token;
  if (!token) {
    return c.json({ error: "token_required" }, 400);
  }

  let login: string | null = existing?.login ?? null;
  if (parsed.data.token !== undefined && parsed.data.token !== null) {
    // Token was set or rotated — validate it.
    try {
      const user = await validate(token);
      login = user.login;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn("api.integrations.github.validate_failed", { message });
      return c.json({ error: "token_invalid", message }, 401);
    }
  }

  const watched = parsed.data.watched_repos ?? existing?.watched_repos ?? [];
  upsertIntegration("github", { token, watched_repos: watched, login }, true);
  markSynced("github");
  log.info("api.integrations.github.connected", { login, watched_count: watched.length });
  return c.json({ ok: true, login, watched_repos: watched });
});

/** Wipe the github config + token. */
integrations.delete("/github", (c) => {
  const ok = deleteIntegration("github");
  return c.json({ ok });
});

/**
 * List the user's repos. For populating the multi-select in Settings.
 * Slim shape — full_name + description + private + pushed_at is enough.
 */
integrations.get("/github/repos", async (c) => {
  const cfg = getGithubConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  try {
    const repos = await listRepos(cfg.token);
    markSynced("github");
    return c.json({
      repos: repos.map((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        description: r.description,
        pushed_at: r.pushed_at,
      })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markError("github", message);
    log.warn("api.integrations.github.list_repos_failed", { message });
    return c.json({ error: "github_request_failed", message }, 502);
  }
});

/**
 * PRs across watched repos. Filters:
 *   - awaiting_me (default) — review-requested for the authed user
 *   - all_open — every open PR in any watched repo
 *
 * Returns `awaiting_me: bool` per PR so the Review button can be
 * gated client-side too (server still rechecks before spawning).
 */
integrations.get("/github/prs", async (c) => {
  const cfg = getGithubConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  if (cfg.watched_repos.length === 0) {
    return c.json({ prs: [], message: "no_watched_repos" });
  }
  const filterRaw = c.req.query("filter");
  const filter: PullFilter = filterRaw === "all_open" ? "all_open" : "awaiting_me";
  try {
    const prs = await listPullRequests(cfg.token, cfg.watched_repos, filter, cfg.login ?? undefined);
    markSynced("github");
    return c.json({ filter, prs: prs.map((pr) => slimPull(pr)) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markError("github", message);
    log.warn("api.integrations.github.list_prs_failed", { message });
    return c.json({ error: "github_request_failed", message }, 502);
  }
});

/**
 * Spawn a review task from a GitHub PR. Fetches the diff, creates a
 * task with workspace='review' and input_kind='diff', then starts the
 * orchestrator run. Returns the task id so the UI can navigate.
 */
integrations.post("/github/prs/:owner/:repo/:number/review", async (c) => {
  const cfg = getGithubConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const number = Number(c.req.param("number"));
  if (!owner || !repo || !Number.isFinite(number)) {
    return c.json({ error: "invalid_pr_ref" }, 400);
  }
  const repoFullName = `${owner}/${repo}`;
  if (!cfg.watched_repos.includes(repoFullName)) {
    return c.json({ error: "repo_not_watched", message: `${repoFullName} is not in your watched list` }, 400);
  }
  if (!cfg.login) {
    return c.json({ error: "no_login", message: "GitHub login wasn't recorded — reconnect" }, 400);
  }

  // Spec: don't review uninvited. Re-check `requested_reviewers` here
  // even though the UI already gates the button — the user could have
  // been removed as reviewer between the list call and the click.
  try {
    const ok = await isRequestedReviewer(cfg.token, repoFullName, number, cfg.login);
    if (!ok) {
      return c.json(
        {
          error: "not_requested_reviewer",
          message: `@${cfg.login} is not currently a requested reviewer on ${repoFullName}#${number}.`,
        },
        403,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.github.review_check_failed", { repoFullName, number, message });
    return c.json({ error: "review_check_failed", message }, 502);
  }

  let pr;
  let diff: string;
  try {
    pr = await fetchPullRequest(cfg.token, repoFullName, number);
    diff = await fetchPullDiff(cfg.token, repoFullName, number);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.github.fetch_pr_failed", { repoFullName, number, message });
    return c.json({ error: "github_request_failed", message }, 502);
  }

  const inputPayload = renderPrInput(repoFullName, pr, diff);
  const task = createTask({
    workspace: "review",
    title: `${repoFullName}#${number} — ${pr.title}`,
    input_kind: "diff",
    input_payload: inputPayload,
    repo_path: null,
    initial_state: "review",
  });
  log.info("api.integrations.github.review_task_created", {
    taskId: task.id,
    repoFullName,
    number,
  });
  // Fire the orchestrator. Same lifecycle as a regular task — the
  // workspace='review' path skips Plan/Code (initial_state='review')
  // so the reviewer agent runs directly on the diff.
  startRun(task.id).catch((err) => {
    log.warn("api.integrations.github.start_run_failed", { taskId: task.id, error: String(err) });
  });
  return c.json({ task_id: task.id });
});

/** Slim the GH pull-request shape for transport — we don't surface the
 *  full sha map in the UI. */
function slimPull(pr: GithubPull) {
  return {
    repo: pr.repo_full_name,
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    author: pr.user.login,
    author_avatar: pr.user.avatar_url,
    body: (pr.body ?? "").slice(0, 800),
    base_ref: pr.base.ref,
    head_ref: pr.head.ref,
    draft: pr.draft,
    updated_at: pr.updated_at,
    created_at: pr.created_at,
    awaiting_me: pr.awaiting_me ?? false,
  };
}

/**
 * Compose the input payload for the review task. The reviewer agent
 * reads `task.input_payload` so this is what shows up in its user
 * message — PR metadata + the verbatim unified diff.
 */
function renderPrInput(repoFullName: string, pr: GithubPull, diff: string): string {
  const author = pr.user.login;
  const body = (pr.body ?? "").trim();
  return `# Pull Request: ${repoFullName}#${pr.number}

**${pr.title}**
- Author: @${author}
- Base: \`${pr.base.ref}\` → Head: \`${pr.head.ref}\`
- URL: ${pr.html_url}

## Description

${body || "_(no description)_"}

## Diff

\`\`\`diff
${diff}
\`\`\`
`;
}
