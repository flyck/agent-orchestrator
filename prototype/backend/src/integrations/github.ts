/**
 * GitHub HTTP client. Just the calls we need:
 *   - validate(token) — confirms the token works, returns the login
 *   - listRepos(token) — repos the user has read access to (for the
 *     watched-repos multi-select in Settings)
 *   - listReviewRequests(token, watched) — PRs across watched repos
 *     where the user is a requested reviewer
 *   - fetchPullRequest(token, repo, number) — diff + metadata for one PR
 *
 * No SDK dependency — fetch() + a thin error wrapper. The token is a
 * personal access token (classic or fine-grained) with `repo:read`
 * scope; we never write back. All requests target api.github.com.
 */

const GH_BASE = "https://api.github.com";

export class GithubError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`github ${path} → ${status}: ${body.slice(0, 240)}`);
    this.name = "GithubError";
  }
}

async function ghFetch(
  path: string,
  token: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/vnd.github+json");
  headers.set("user-agent", "agent-orchestrator");
  headers.set("x-github-api-version", "2022-11-28");
  const res = await fetch(`${GH_BASE}${path}`, { ...init, headers });
  return res;
}

async function ghJson<T>(path: string, token: string): Promise<T> {
  const res = await ghFetch(path, token);
  if (!res.ok) throw new GithubError(res.status, path, await res.text());
  return res.json() as Promise<T>;
}

export interface GithubUser {
  login: string;
  id: number;
  avatar_url: string;
}

export async function validate(token: string): Promise<GithubUser> {
  return ghJson<GithubUser>("/user", token);
}

export interface GithubRepo {
  id: number;
  full_name: string;     // "owner/name"
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  pushed_at: string | null;
}

/**
 * List repos the user has access to. Paginates up to 4 pages (≈400
 * repos). Sorted by recent activity so frequently-touched repos float
 * to the top of the multi-select.
 */
export async function listRepos(token: string): Promise<GithubRepo[]> {
  const all: GithubRepo[] = [];
  for (let page = 1; page <= 4; page++) {
    const repos = await ghJson<GithubRepo[]>(
      `/user/repos?per_page=100&sort=pushed&page=${page}`,
      token,
    );
    all.push(...repos);
    if (repos.length < 100) break;
  }
  return all;
}

export interface GithubPull {
  id: number;
  number: number;
  title: string;
  state: "open" | "closed";
  draft: boolean;
  user: { login: string; avatar_url: string };
  html_url: string;
  body: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  updated_at: string;
  created_at: string;
  requested_reviewers?: Array<{ login: string }>;
  merged_at?: string | null;
  /** repo ref so callers can group / link without a second lookup. */
  repository_url?: string;
  /** Synthetic — we set this from the calling repo's full_name. */
  repo_full_name?: string;
  /** Synthetic — true when the authenticated user is in
   *  requested_reviewers. Computed by the API layer. */
  awaiting_me?: boolean;
}

/** Confirm the authenticated user is currently requested as a reviewer
 *  on this PR. Used to gate spawn-review-task — spec says we don't
 *  start review work uninvited. */
export async function isRequestedReviewer(
  token: string,
  repoFullName: string,
  number: number,
  myLogin: string,
): Promise<boolean> {
  const pr = await fetchPullRequest(token, repoFullName, number);
  return (pr.requested_reviewers ?? []).some((r) => r.login === myLogin);
}

export const PullFilter = {
  AwaitingMe: "awaiting_me",
  AllOpen: "all_open",
} as const;
export type PullFilter = (typeof PullFilter)[keyof typeof PullFilter];

/**
 * List PRs across the watched repos. Two filters:
 *
 *   - "awaiting_me" — PRs where the authenticated user is a requested
 *     reviewer. The Review button on the page only spawns tasks from
 *     this set; spec is "we don't review uninvited".
 *   - "all_open" — every open PR in any watched repo. Useful for
 *     situational awareness; spawn-review is rejected for these.
 */
export async function listPullRequests(
  token: string,
  watched: string[],
  filter: PullFilter = PullFilter.AwaitingMe,
  myLogin?: string,
): Promise<GithubPull[]> {
  if (watched.length === 0) return [];
  if (filter === PullFilter.AllOpen) {
    return listAllOpen(token, watched, myLogin);
  }
  return listReviewRequests(token, watched, myLogin);
}

async function listAllOpen(
  token: string,
  watched: string[],
  myLogin?: string,
): Promise<GithubPull[]> {
  const out: GithubPull[] = [];
  for (const repo of watched) {
    try {
      const pulls = await ghJson<GithubPull[]>(
        `/repos/${repo}/pulls?state=open&per_page=50`,
        token,
      );
      for (const pr of pulls) {
        const awaiting = !!myLogin && (pr.requested_reviewers ?? []).some((r) => r.login === myLogin);
        out.push({ ...pr, repo_full_name: repo, awaiting_me: awaiting });
      }
    } catch (err) {
      console.warn("[github] list pulls failed", repo, err);
    }
  }
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

async function listReviewRequests(
  token: string,
  watched: string[],
  myLogin?: string,
): Promise<GithubPull[]> {
  if (watched.length === 0) return [];
  // Search query: review-requested PRs, scoped to watched repos.
  // GitHub limits qualifier list length, so chunk in groups of 8.
  const out: GithubPull[] = [];
  for (let i = 0; i < watched.length; i += 8) {
    const chunk = watched.slice(i, i + 8);
    const repoQ = chunk.map((r) => `repo:${r}`).join("+");
    const q = encodeURIComponent(`is:pr is:open review-requested:@me`);
    const search = await ghJson<{
      items: Array<{
        number: number;
        title: string;
        html_url: string;
        repository_url: string;
        user: { login: string; avatar_url: string };
        body: string | null;
        updated_at: string;
        created_at: string;
        state: string;
        draft?: boolean;
      }>;
    }>(`/search/issues?q=${q}+${repoQ}&per_page=50`, token);
    for (const it of search.items ?? []) {
      // repository_url looks like "https://api.github.com/repos/owner/name"
      const repoFullName = it.repository_url.replace(
        "https://api.github.com/repos/",
        "",
      );
      // The search response is shaped like an issue — fetch the full PR
      // to get base/head. Skip on per-PR error; one bad PR shouldn't
      // poison the whole list.
      try {
        const pr = await fetchPullRequest(token, repoFullName, it.number);
        const awaiting = !!myLogin && (pr.requested_reviewers ?? []).some((r) => r.login === myLogin);
        out.push({ ...pr, repo_full_name: repoFullName, awaiting_me: awaiting || true });
      } catch (err) {
        // best-effort
        console.warn("[github] fetchPR failed", repoFullName, it.number, err);
      }
    }
  }
  // Newest activity first.
  out.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return out;
}

export async function fetchPullRequest(
  token: string,
  repoFullName: string,
  number: number,
): Promise<GithubPull> {
  return ghJson<GithubPull>(`/repos/${repoFullName}/pulls/${number}`, token);
}

/**
 * Post a top-level comment on the PR's underlying issue. This is what
 * `gh pr comment` does — it lands in the PR conversation tab, not as
 * an inline review comment.
 *
 * Requires the token to have write scope (classic: `repo`,
 * fine-grained: `Pull requests: Read and write`). Read-only tokens
 * 403 here.
 */
export async function postIssueComment(
  token: string,
  repoFullName: string,
  issueNumber: number,
  body: string,
): Promise<{ id: number; html_url: string }> {
  const res = await ghFetch(
    `/repos/${repoFullName}/issues/${issueNumber}/comments`,
    token,
    { method: "POST", body: JSON.stringify({ body }) },
  );
  if (!res.ok) throw new GithubError(res.status, `/repos/${repoFullName}/issues/${issueNumber}/comments`, await res.text());
  return res.json() as Promise<{ id: number; html_url: string }>;
}

/**
 * Submit a PR review with a body and an event verdict. Used when the
 * orchestrator wants to publish the synthesizer's output as a single
 * formal review (rather than a free-form comment).
 *
 * `event` matches the GitHub API: APPROVE / REQUEST_CHANGES / COMMENT.
 * The orchestrator only emits COMMENT in v1 — APPROVE / REQUEST_CHANGES
 * imply the agent is the reviewer of record, which we don't want
 * without an explicit user approval step.
 */
export async function postPullReview(
  token: string,
  repoFullName: string,
  number: number,
  body: string,
  event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES" = "COMMENT",
): Promise<{ id: number; html_url: string }> {
  const res = await ghFetch(
    `/repos/${repoFullName}/pulls/${number}/reviews`,
    token,
    { method: "POST", body: JSON.stringify({ body, event }) },
  );
  if (!res.ok) throw new GithubError(res.status, `/repos/${repoFullName}/pulls/${number}/reviews`, await res.text());
  return res.json() as Promise<{ id: number; html_url: string }>;
}

/**
 * Fetch the unified diff for a PR. Uses the `application/vnd.github.v3.diff`
 * accept header, which returns plain text.
 */
export async function fetchPullDiff(
  token: string,
  repoFullName: string,
  number: number,
): Promise<string> {
  const res = await ghFetch(`/repos/${repoFullName}/pulls/${number}`, token, {
    headers: { accept: "application/vnd.github.v3.diff" },
  });
  if (!res.ok) {
    throw new GithubError(res.status, `/repos/${repoFullName}/pulls/${number}`, await res.text());
  }
  return res.text();
}

export interface GithubIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  html_url: string;
  body: string | null;
  // GitHub returns issues AND PRs from the issues endpoint; this field is
  // present (and truthy) when the record is actually a PR. Callers that
  // only want true issues should check this.
  pull_request?: { url: string } | undefined;
}

/**
 * Fetch a single issue (or PR — they share the issues endpoint). The
 * caller decides whether to filter PR-shaped issues out via
 * `pull_request`. Used by the suggestion generator to check whether a
 * task-linked issue is still open at completion time.
 */
export async function fetchIssue(
  token: string,
  repoFullName: string,
  issueNumber: number,
): Promise<GithubIssue> {
  return ghJson<GithubIssue>(`/repos/${repoFullName}/issues/${issueNumber}`, token);
}

/**
 * Parse a user-supplied issue reference into `{repo?, number}`. Accepts:
 *   - "#142"                                  → {number: 142}
 *   - "142"                                   → {number: 142}
 *   - "owner/name#142"                        → {repo: "owner/name", number: 142}
 *   - "https://github.com/owner/name/issues/142"
 *   - "https://github.com/owner/name/pull/142"  (PR also a valid issue id)
 *
 * Returns null when the input doesn't look like an issue reference.
 */
export function parseIssueRef(
  input: string,
): { repo: string | null; number: number } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // URL form
  const urlMatch = trimmed.match(
    /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)\b/,
  );
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    return { repo: urlMatch[1], number: Number.parseInt(urlMatch[2], 10) };
  }

  // owner/name#N
  const repoRefMatch = trimmed.match(/^([^/\s]+\/[^/\s#]+)#(\d+)$/);
  if (repoRefMatch && repoRefMatch[1] && repoRefMatch[2]) {
    return { repo: repoRefMatch[1], number: Number.parseInt(repoRefMatch[2], 10) };
  }

  // bare #N or N
  const bareMatch = trimmed.match(/^#?(\d+)$/);
  if (bareMatch && bareMatch[1]) {
    return { repo: null, number: Number.parseInt(bareMatch[1], 10) };
  }

  return null;
}
