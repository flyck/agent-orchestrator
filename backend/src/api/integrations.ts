/**
 * Integrations API. The base /api/integrations endpoint lists known
 * providers and their status; /api/integrations/github/* is the
 * GitHub-specific shape (token + watched repos + PR list).
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  deleteIntegration,
  disableOtherIntegrations,
  getBitbucketConfig,
  getGithubConfig,
  getIntegration,
  markError,
  markSynced,
  upsertIntegration,
} from "../db/integrations";
import {
  fetchPullDiff,
  fetchPullRequest,
  listPullRequests,
  listRepos,
  postIssueComment,
  postPullReview,
  PullFilter,
  validate,
  type GithubPull,
} from "../integrations/github";
import { validate as validateBitbucket } from "../integrations/bitbucket";
import {
  PullFilter as ProviderPullFilter,
  getActiveProvider,
  type NormalizedPull,
} from "../integrations/provider";
import {
  cacheKey as prCacheKey,
  getFresh as getFreshPrCache,
  set as setPrCache,
  invalidate as invalidatePrCache,
} from "../integrations/prCache";
import {
  createTask,
  getTask,
  listActivePrTaskKeys,
  parseTaskMetadata,
  setTaskMetadata,
  type TaskRow,
} from "../db/tasks";
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
  /** Bitbucket only — username (or Atlassian email) used as basic-auth
   *  user. The app password itself is never returned. */
  username?: string | null;
  /** Bitbucket only — display name from /2.0/user, when the credential
   *  has the scope to read it. */
  display_name?: string | null;
  /** Bitbucket only — workspace slug the credential is scoped to. */
  workspace?: string | null;
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
    if (k.id === "bitbucket") {
      const cfg = getBitbucketConfig();
      base.username = cfg?.username ?? null;
      base.display_name = cfg?.display_name ?? null;
      base.workspace = cfg?.workspace ?? null;
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
  // Single-active rule: turning on GitHub disables Bitbucket / GitLab.
  // Their stored configs are kept so the user can flip back without
  // re-entering credentials.
  disableOtherIntegrations("github");
  markSynced("github");
  log.info("api.integrations.github.connected", { login, watched_count: watched.length });
  return c.json({ ok: true, login, watched_repos: watched });
});

/** Wipe the github config + token. */
integrations.delete("/github", (c) => {
  const ok = deleteIntegration("github");
  return c.json({ ok });
});

// ─── Bitbucket ───────────────────────────────────────────────────────────

const bitbucketConnectSchema = z.object({
  /** Bitbucket username, or the Atlassian email if you're using an API
   *  token instead of an app password. */
  username: z.string().min(1).max(160),
  /** App password or Atlassian API token. Stored only on this host. */
  app_password: z.string().min(8).max(400),
});

/**
 * Validate the credential pair against /2.0/user, persist it, and flip
 * the single-active flag so any other provider gets disabled. We don't
 * support a separate "rotate without revalidating" path — Bitbucket's
 * model is simpler than GitHub's so the user just re-submits.
 */
integrations.post("/bitbucket/connect", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = bitbucketConnectSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }

  const { username, app_password } = parsed.data;
  let display_name: string | null = null;
  let account_id: string | null = null;
  let uuid: string | null = null;
  let workspaces: string[] = [];
  try {
    const user = await validateBitbucket(username, app_password);
    display_name = user.display_name ?? null;
    account_id = user.account_id ?? null;
    uuid = user.uuid ?? null;
    workspaces = user.workspaces ?? [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.bitbucket.validate_failed", { message });
    const hint =
      "App passwords need 'Account: Read' (or 'Workspaces: Read'). Atlassian-issued Bitbucket API tokens need the 'read:workspace:bitbucket' scope ticked at creation. Plain Atlassian API tokens scoped only for Jira/Confluence won't authenticate against api.bitbucket.org.";
    return c.json(
      { error: "credentials_invalid", message, hint },
      401,
    );
  }

  // Pick the first workspace as the default. Multi-workspace selection
  // can land later; for now the orchestrator scopes calls to one.
  const workspace = workspaces[0] ?? null;
  upsertIntegration(
    "bitbucket",
    { username, app_password, workspace, account_id, uuid, display_name },
    true,
  );
  disableOtherIntegrations("bitbucket");
  markSynced("bitbucket");
  log.info("api.integrations.bitbucket.connected", {
    username,
    workspace,
    workspace_count: workspaces.length,
  });
  return c.json({
    ok: true,
    username,
    workspace,
    workspaces,
    display_name,
  });
});

/** Wipe the bitbucket config + credential. */
integrations.delete("/bitbucket", (c) => {
  const ok = deleteIntegration("bitbucket");
  return c.json({ ok });
});

/**
 * Manual workspace slug override. Some credentials — particularly
 * Atlassian API tokens whose identity differs from the Bitbucket
 * member account — return an empty /2.0/user/workspaces response
 * even though the user has access via the bitbucket.org UI. Letting
 * the user type the slug directly bypasses the auto-discovery path.
 */
const bitbucketWorkspaceSchema = z.object({
  workspace: z.string().min(1).max(160),
});
integrations.patch("/bitbucket/workspace", async (c) => {
  const cfg = getBitbucketConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = bitbucketWorkspaceSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  const workspace = parsed.data.workspace.trim();
  upsertIntegration(
    "bitbucket",
    { ...cfg, workspace },
    true,
  );
  log.info("api.integrations.bitbucket.workspace_set", { workspace });
  return c.json({ ok: true, workspace });
});

// ─── Generic (provider-agnostic) ─────────────────────────────────────────

/**
 * Repos the active provider can see. Used by the watched-repos picker
 * in Settings. Same slim shape regardless of provider.
 */
integrations.get("/repos", async (c) => {
  const provider = await getActiveProvider();
  if (!provider) return c.json({ error: "not_connected", source: null }, 400);
  try {
    const repos = await provider.listRepos();
    markSynced(provider.id);
    return c.json({ source: provider.id, repos });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markError(provider.id, message);
    log.warn("api.integrations.list_repos_failed", { source: provider.id, message });
    return c.json({ error: "provider_request_failed", source: provider.id, message }, 502);
  }
});

/**
 * Update the watched-repos selection on the active provider. The picker
 * sends the full desired list (not a diff) so this is idempotent and
 * tolerant of stale views.
 */
const watchedSchema = z.object({
  watched_repos: z.array(z.string().min(3).max(140)).max(500),
});
integrations.patch("/watched", async (c) => {
  const provider = await getActiveProvider();
  if (!provider) return c.json({ error: "not_connected", source: null }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = watchedSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  try {
    provider.setWatchedRepos(parsed.data.watched_repos);
    invalidatePrCache(provider.id);
    log.info("api.integrations.watched_updated", {
      source: provider.id,
      count: parsed.data.watched_repos.length,
    });
    return c.json({
      ok: true,
      source: provider.id,
      watched_repos: parsed.data.watched_repos,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.watched_update_failed", { source: provider.id, message });
    return c.json({ error: "provider_write_failed", source: provider.id, message }, 500);
  }
});

/**
 * Provider-agnostic PR listing. Dispatches to whichever integration row
 * has `enabled=1` (single-active rule). Returns NormalizedPull rows so
 * the Review page can render GitHub + Bitbucket PRs through the same
 * card. Filters mirror the github endpoint:
 *   - awaiting_me (default) — review-requested for the user
 *   - all_open — every open PR in any watched repo
 */
integrations.get("/prs", async (c) => {
  const provider = await getActiveProvider();
  if (!provider) return c.json({ error: "not_connected", source: null }, 400);
  const watched = provider.listWatchedRepos();
  if (watched.length === 0) {
    return c.json({ source: provider.id, prs: [], message: "no_watched_repos" });
  }
  const filterRaw = c.req.query("filter");
  const filter =
    filterRaw === ProviderPullFilter.AllOpen
      ? ProviderPullFilter.AllOpen
      : ProviderPullFilter.AwaitingMe;

  // 60s TTL cache — collapses repeated Review-page polls into one
  // upstream fetch. ?fresh=1 bypasses the cache (refresh button).
  // The active-review-task filter runs after the cache read so newly
  // created / deleted review tasks take effect on the next poll
  // without needing to invalidate the upstream cache.
  const fresh = c.req.query("fresh") === "1";
  const key = prCacheKey(provider.id, filter, watched);
  if (!fresh) {
    const hit = getFreshPrCache(key);
    if (hit) {
      return c.json({
        source: provider.id,
        filter,
        prs: hideActivePrs(hit.prs, filter),
        cached: true,
        cached_age_ms: Date.now() - hit.cachedAt,
      });
    }
  }

  try {
    const prs = await provider.listPullRequests(filter);
    setPrCache(key, prs);
    markSynced(provider.id);
    return c.json({
      source: provider.id,
      filter,
      prs: hideActivePrs(prs, filter),
      cached: false,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    markError(provider.id, message);
    log.warn("api.integrations.list_prs_failed", { source: provider.id, message });
    return c.json({ error: "provider_request_failed", source: provider.id, message }, 502);
  }
});

/** Drop PRs from the awaiting_me list when an active review task already
 *  exists for them. Pure pass-through for all_open so the user can still
 *  see the rest of the open-PR landscape. */
function hideActivePrs(
  prs: NormalizedPull[],
  filter: ProviderPullFilter,
): NormalizedPull[] {
  if (filter !== ProviderPullFilter.AwaitingMe) return prs;
  const active = listActivePrTaskKeys();
  if (active.size === 0) return prs;
  return prs.filter((p) => !active.has(`${p.repo}#${p.number}`));
}

/**
 * Spawn a review task from any provider's PR. The repo path is the
 * single full-name string ({owner_or_workspace}/{slug}); since slugs
 * can contain dashes but not slashes, we accept it as a single param
 * and split on the last "/" so the route matches both "owner/name/123"
 * and "workspace/repo-name/45".
 */
integrations.post("/prs/:owner/:repo/:number/review", async (c) => {
  const owner = c.req.param("owner");
  const repo = c.req.param("repo");
  const numStr = c.req.param("number");
  const number = Number(numStr);
  if (!owner || !repo || !Number.isFinite(number)) {
    return c.json({ error: "invalid_pr_ref" }, 400);
  }
  const provider = await getActiveProvider();
  if (!provider) return c.json({ error: "not_connected" }, 400);

  const repoFullName = `${owner}/${repo}`;
  if (!provider.listWatchedRepos().includes(repoFullName)) {
    return c.json(
      { error: "repo_not_watched", message: `${repoFullName} is not in your watched list` },
      400,
    );
  }

  let pull: NormalizedPull;
  let diff: string;
  try {
    pull = await provider.fetchPullRequest(repoFullName, number);
    diff = await provider.fetchPullDiff(repoFullName, number);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.fetch_pr_failed", {
      source: provider.id,
      repoFullName,
      number,
      message,
    });
    return c.json({ error: "provider_request_failed", source: provider.id, message }, 502);
  }

  const inputPayload = renderNormalizedPrInput(pull, diff);
  const task = createTask({
    workspace: "review",
    title: `${repoFullName}#${number} — ${pull.title}`,
    input_kind: "diff",
    input_payload: inputPayload,
    repo_path: null,
    initial_state: "review",
  });
  setTaskMetadata(task.id, {
    pr: {
      source: provider.id,
      repo: repoFullName,
      number,
      base_ref: pull.base_ref,
      head_ref: pull.head_ref,
      html_url: pull.url,
    },
  });
  log.info("api.integrations.review_task_created", {
    source: provider.id,
    taskId: task.id,
    repoFullName,
    number,
  });
  startRun(task.id).catch((err) => {
    log.warn("api.integrations.start_run_failed", { taskId: task.id, error: String(err) });
  });
  return c.json({ task_id: task.id, source: provider.id });
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
  const filter: PullFilter =
    filterRaw === PullFilter.AllOpen ? PullFilter.AllOpen : PullFilter.AwaitingMe;
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
  // Stash GH coordinates on the task so the comment-proxy endpoint can
  // post back to the right PR without re-parsing the title.
  setTaskMetadata(task.id, {
    github: {
      repo: repoFullName,
      number,
      base_ref: pr.base.ref,
      head_ref: pr.head.ref,
      html_url: pr.html_url,
    },
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

/**
 * Proxy: post a top-level conversation comment back to the PR for
 * `task_id`. Routes through the user's stored GitHub token — the
 * agent never sees it. v1 expects an autonomous-but-rare action;
 * `confirm: true` must be set in the payload so accidental calls
 * during development don't ping anyone.
 *
 * Required token scope: write (classic `repo` or fine-grained
 * `Pull requests: Read and write`). Read-only tokens 403.
 */
const postCommentSchema = z.object({
  task_id: z.string().min(1).max(80),
  body: z.string().min(1).max(60_000),
  /** Posting to PR/MR is irreversible. Make the agent assert intent. */
  confirm: z.literal(true),
});
integrations.post("/github/comment", async (c) => {
  const cfg = getGithubConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = postCommentSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  const task = getTask(parsed.data.task_id);
  if (!task) return c.json({ error: "task_not_found" }, 404);
  const meta = parseTaskMetadata(task.metadata_json).github;
  if (!meta?.repo || !meta?.number) {
    return c.json({ error: "task_not_a_pr_review", message: "Task has no GitHub PR coordinates." }, 400);
  }
  try {
    const r = await postIssueComment(cfg.token, meta.repo, meta.number, parsed.data.body);
    log.info("api.integrations.github.comment_posted", {
      task_id: task.id,
      repo: meta.repo,
      number: meta.number,
      comment_id: r.id,
    });
    return c.json({ ok: true, html_url: r.html_url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.github.comment_failed", { task_id: task.id, message });
    return c.json({ error: "github_request_failed", message }, 502);
  }
});

/**
 * Proxy: submit the PR-review payload as a formal review with body +
 * event=COMMENT. Same auth + confirm semantics as /github/comment.
 * Used by the synthesizer or by a "Post review to GitHub" UI button
 * on the Ready stage.
 */
const postReviewSchema = z.object({
  task_id: z.string().min(1).max(80),
  body: z.string().min(1).max(60_000),
  /** Reserved for the future. v1 forces COMMENT — the orchestrator
   *  doesn't approve / request-changes on the user's behalf. */
  event: z.literal("COMMENT").default("COMMENT"),
  confirm: z.literal(true),
});
integrations.post("/github/review", async (c) => {
  const cfg = getGithubConfig();
  if (!cfg) return c.json({ error: "not_connected" }, 400);
  const body = await c.req.json().catch(() => null);
  const parsed = postReviewSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  const task = getTask(parsed.data.task_id);
  if (!task) return c.json({ error: "task_not_found" }, 404);
  const meta = parseTaskMetadata(task.metadata_json).github;
  if (!meta?.repo || !meta?.number) {
    return c.json({ error: "task_not_a_pr_review", message: "Task has no GitHub PR coordinates." }, 400);
  }
  try {
    const r = await postPullReview(cfg.token, meta.repo, meta.number, parsed.data.body, "COMMENT");
    log.info("api.integrations.github.review_posted", {
      task_id: task.id,
      repo: meta.repo,
      number: meta.number,
      review_id: r.id,
    });
    return c.json({ ok: true, html_url: r.html_url });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("api.integrations.github.review_post_failed", { task_id: task.id, message });
    return c.json({ error: "github_request_failed", message }, 502);
  }
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

/** Provider-agnostic input payload renderer. Same shape as the GitHub
 *  one above, just sourced from a NormalizedPull. */
function renderNormalizedPrInput(pull: NormalizedPull, diff: string): string {
  const body = (pull.body ?? "").trim();
  const authorPrefix = pull.source === "github" ? "@" : "";
  return `# Pull Request: ${pull.repo}#${pull.number}

**${pull.title}**
- Author: ${authorPrefix}${pull.author}
- Base: \`${pull.base_ref}\` → Head: \`${pull.head_ref}\`
- URL: ${pull.url}
- Source: ${pull.source}

## Description

${body || "_(no description)_"}

## Diff

\`\`\`diff
${diff}
\`\`\`
`;
}
