/**
 * Bitbucket Cloud HTTP client. We only need validate(username, appPassword)
 * for now — the orchestrator stores the credential pair and labels the
 * integration as configured. Repo / PR fetching can land later when the
 * Review page grows a Bitbucket source.
 *
 * Auth: HTTP Basic — username + app password. App passwords are created at
 * https://bitbucket.org/account/settings/app-passwords/ and are scoped per
 * app. Atlassian API tokens (the email + token model used elsewhere in the
 * Atlassian suite) also work via Basic auth, with the email in the username
 * field.
 */

const BB_BASE = "https://api.bitbucket.org";

export class BitbucketError extends Error {
  constructor(
    public readonly status: number,
    public readonly path: string,
    public readonly body: string,
  ) {
    super(`bitbucket ${path} → ${status}: ${body.slice(0, 240)}`);
    this.name = "BitbucketError";
  }
}

function basicHeader(username: string, appPassword: string): string {
  return `Basic ${Buffer.from(`${username}:${appPassword}`).toString("base64")}`;
}

async function bbFetch(
  path: string,
  username: string,
  appPassword: string,
): Promise<Response> {
  return fetch(`${BB_BASE}${path}`, {
    headers: {
      authorization: basicHeader(username, appPassword),
      accept: "application/json",
      "user-agent": "agent-orchestrator",
    },
  });
}

async function bbJson<T>(
  path: string,
  username: string,
  appPassword: string,
): Promise<T> {
  const res = await bbFetch(path, username, appPassword);
  if (!res.ok) throw new BitbucketError(res.status, path, await res.text());
  return res.json() as Promise<T>;
}

async function bbText(
  path: string,
  username: string,
  appPassword: string,
): Promise<string> {
  const res = await bbFetch(path, username, appPassword);
  if (!res.ok) throw new BitbucketError(res.status, path, await res.text());
  return res.text();
}

interface PaginatedResponse<T> {
  values?: T[];
  next?: string;
  pagelen?: number;
  size?: number;
}

export interface BitbucketUser {
  /** Atlassian account id — stable across username changes. */
  account_id?: string;
  /** Bitbucket-internal UUID, formatted as `{guid}`. Distinct from
   *  account_id; used for q-filter matching against reviewers.uuid. */
  uuid?: string;
  /** Display name; absent on some workspace-token responses. */
  display_name?: string;
  /** Username (slug); absent on token-only auth. */
  username?: string;
  /** Email field is gated behind the "email" scope on the credential. */
  email?: string;
}

interface UserWorkspacesResponse {
  values?: Array<{
    slug?: string;
    name?: string;
    uuid?: string;
  }>;
}

export interface BitbucketValidation extends BitbucketUser {
  /** All workspace slugs the credential can see — populated from
   *  /2.0/user/workspaces. The first one is selected by default for the
   *  navbar workspace label. */
  workspaces?: string[];
}

/**
 * Validate the credential pair against Bitbucket.
 *
 * The /2.0/user/workspaces endpoint (the supported replacement after
 * CHANGE-2770 killed /2.0/workspaces and /2.0/user/permissions/workspaces
 * in 2026-Q1) lists every workspace the caller can see — auth check +
 * workspace enumeration in one call. We try /2.0/user first for the
 * display name, but fall through to /2.0/user/workspaces on 403/410
 * since some scoped tokens have workspace scope but not account scope.
 */
export async function validate(
  username: string,
  appPassword: string,
): Promise<BitbucketValidation> {
  let display_name: string | undefined;
  let account_id: string | undefined;
  let uuid: string | undefined;

  const userRes = await bbFetch("/2.0/user", username, appPassword);
  if (userRes.ok) {
    const u = (await userRes.json()) as BitbucketUser;
    display_name = u.display_name;
    account_id = u.account_id;
    uuid = u.uuid;
  } else if (userRes.status === 401) {
    // Bad credential — no fallback worth attempting.
    throw new BitbucketError(401, "/2.0/user", await userRes.text());
  } else if (userRes.status !== 403 && userRes.status !== 410 && userRes.status !== 404) {
    throw new BitbucketError(userRes.status, "/2.0/user", await userRes.text());
  }
  // 403/410/404 just means the token lacks `account` scope; the
  // workspace listing is the actual authorization probe.

  const wsRes = await bbFetch("/2.0/user/workspaces?pagelen=100", username, appPassword);
  if (!wsRes.ok) {
    throw new BitbucketError(
      wsRes.status,
      "/2.0/user/workspaces",
      await wsRes.text(),
    );
  }
  const data = (await wsRes.json()) as UserWorkspacesResponse;
  const workspaces = (data.values ?? [])
    .map((w) => w.slug)
    .filter((s): s is string => typeof s === "string" && s.length > 0);

  return {
    display_name,
    account_id,
    uuid,
    workspaces,
  };
}

// ─── Repos ──────────────────────────────────────────────────────────────

export interface BitbucketRepo {
  /** Slug used in URLs: bitbucket.org/{workspace}/{slug}. */
  slug: string;
  name: string;
  /** "{workspace}/{slug}" — matches the GitHub `full_name` shape so the
   *  rest of the system can treat them uniformly. */
  full_name: string;
  is_private: boolean;
  description: string | null;
  updated_on: string | null;
}

interface BitbucketRepoRaw {
  slug: string;
  name: string;
  full_name: string;
  is_private?: boolean;
  description?: string;
  updated_on?: string;
}

/**
 * List repos in a workspace that the credential has at least member
 * access to. Paginates up to 4 pages (≈400 repos) sorted by recent
 * activity, mirroring the GitHub listRepos shape.
 */
export async function listRepos(
  username: string,
  appPassword: string,
  workspace: string,
): Promise<BitbucketRepo[]> {
  const out: BitbucketRepo[] = [];
  let next: string | null = `/2.0/repositories/${encodeURIComponent(
    workspace,
  )}?role=member&pagelen=100&sort=-updated_on`;
  let pages = 0;
  while (next && pages < 4) {
    const path: string = next.startsWith(BB_BASE)
      ? next.slice(BB_BASE.length)
      : next;
    const data: PaginatedResponse<BitbucketRepoRaw> = await bbJson<
      PaginatedResponse<BitbucketRepoRaw>
    >(path, username, appPassword);
    for (const r of data.values ?? []) {
      out.push({
        slug: r.slug,
        name: r.name,
        full_name: r.full_name,
        is_private: r.is_private ?? false,
        description: r.description ?? null,
        updated_on: r.updated_on ?? null,
      });
    }
    next = data.next ?? null;
    pages += 1;
  }
  return out;
}

// ─── Pull requests ──────────────────────────────────────────────────────

export interface BitbucketPullRaw {
  id: number;
  title: string;
  description: string | null;
  state: "OPEN" | "MERGED" | "DECLINED" | "SUPERSEDED";
  draft?: boolean;
  author: { display_name?: string; uuid?: string; nickname?: string };
  source: { branch: { name: string }; commit?: { hash: string } };
  destination: { branch: { name: string }; commit?: { hash: string } };
  links?: { html?: { href?: string } };
  updated_on: string;
  created_on: string;
  reviewers?: Array<{ uuid?: string; display_name?: string }>;
  participants?: Array<{
    user?: { uuid?: string; display_name?: string };
    role: "PARTICIPANT" | "REVIEWER";
    approved?: boolean;
    state?: "approved" | "changes_requested" | null;
  }>;
}

/** Public-facing PR shape used by the Bitbucket API layer. Mirrors the
 *  GitHub `slimPull` output so the frontend renders both with the same
 *  card. */
export interface BitbucketPull {
  /** "{workspace}/{repo_slug}". */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  body: string;
  base_ref: string;
  head_ref: string;
  draft: boolean;
  updated_at: string;
  created_at: string;
  /** Set client-side: true when the authed user is a requested
   *  reviewer who hasn't approved or requested changes yet. */
  awaiting_me: boolean;
}

export const BitbucketPullFilter = {
  AwaitingMe: "awaiting_me",
  AllOpen: "all_open",
} as const;
export type BitbucketPullFilter =
  (typeof BitbucketPullFilter)[keyof typeof BitbucketPullFilter];

/**
 * List PRs across watched repos. Bitbucket has no GitHub-equivalent
 * "review-requested for me" search index, so the awaiting_me filter is
 * computed client-side from each PR's participants list (role=REVIEWER,
 * not yet approved, not yet changes_requested).
 *
 * `repos` is the list of "{workspace}/{slug}" full names the user opted
 * in to. `myUuid` is the credential's account uuid used to match against
 * participants[].user.uuid.
 */
export async function listPullRequests(
  username: string,
  appPassword: string,
  repos: string[],
  filter: BitbucketPullFilter,
  myUuid: string | null,
): Promise<BitbucketPull[]> {
  if (repos.length === 0) return [];

  // Bitbucket has no workspace-level "all open PRs" endpoint, so we fan
  // out per-repo. We push as much filtering as possible into the `q=`
  // query so the wire payload only contains rows we'll actually return.
  // For awaiting_me, q=reviewers.uuid="{me}" is supported (per Bitbucket's
  // filtering docs) and skips the post-filter loop entirely.
  const baseQuery = `state="OPEN"`;
  const fullQuery =
    filter === BitbucketPullFilter.AwaitingMe && myUuid
      ? `${baseQuery} AND reviewers.uuid="${myUuid}"`
      : baseQuery;

  const perRepo = await mapWithConcurrency(repos, 6, async (full) => {
    let workspace: string;
    let slug: string;
    try {
      ({ workspace, slug } = splitRepo(full));
    } catch {
      return [] as BitbucketPull[];
    }
    try {
      const url =
        `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
          slug,
        )}/pullrequests?pagelen=50&q=${encodeURIComponent(fullQuery)}`;
      const data = await bbJson<PaginatedResponse<BitbucketPullRaw>>(
        url,
        username,
        appPassword,
      );
      const out: BitbucketPull[] = [];
      for (const pr of data.values ?? []) {
        // Server already pre-filtered, but recompute awaiting_me so the
        // approved/changes_requested cases are surfaced in the UI even
        // when the q-filter let them through.
        const awaiting = isAwaitingMe(pr, myUuid);
        if (filter === BitbucketPullFilter.AwaitingMe && !awaiting) continue;
        out.push(toBitbucketPull(full, pr, awaiting));
      }
      return out;
    } catch (err) {
      console.warn("[bitbucket] list pulls failed", full, err);
      return [] as BitbucketPull[];
    }
  });
  const flat = perRepo.flat();
  flat.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return flat;
}

/** Bounded parallelism — runs `fn` over `items` with at most `limit`
 *  in-flight at any time, preserving order in the returned array. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

function isAwaitingMe(pr: BitbucketPullRaw, myUuid: string | null): boolean {
  if (!myUuid) return false;
  // Direct reviewers list — present on the listing response.
  const isReviewer = (pr.reviewers ?? []).some((r) => r.uuid === myUuid);
  if (!isReviewer) return false;
  // Has the reviewer already weighed in? participants tracks state.
  const me = (pr.participants ?? []).find(
    (p) => p.user?.uuid === myUuid && p.role === "REVIEWER",
  );
  if (!me) return true; // requested but no participant entry yet
  if (me.approved || me.state === "approved") return false;
  if (me.state === "changes_requested") return false;
  return true;
}

function toBitbucketPull(
  repo: string,
  pr: BitbucketPullRaw,
  awaitingMe: boolean,
): BitbucketPull {
  return {
    repo,
    number: pr.id,
    title: pr.title,
    url: pr.links?.html?.href ?? `https://bitbucket.org/${repo}/pull-requests/${pr.id}`,
    author: pr.author?.display_name ?? pr.author?.nickname ?? "unknown",
    body: (pr.description ?? "").slice(0, 800),
    base_ref: pr.destination?.branch?.name ?? "",
    head_ref: pr.source?.branch?.name ?? "",
    draft: pr.draft === true,
    updated_at: pr.updated_on,
    created_at: pr.created_on,
    awaiting_me: awaitingMe,
  };
}

function splitRepo(repo: string): { workspace: string; slug: string } {
  const i = repo.indexOf("/");
  if (i <= 0 || i === repo.length - 1) {
    throw new Error(`bitbucket: malformed repo full_name "${repo}"`);
  }
  return { workspace: repo.slice(0, i), slug: repo.slice(i + 1) };
}

export async function fetchPullRequest(
  username: string,
  appPassword: string,
  repo: string,
  id: number,
): Promise<BitbucketPullRaw> {
  const { workspace, slug } = splitRepo(repo);
  return bbJson<BitbucketPullRaw>(
    `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      slug,
    )}/pullrequests/${id}`,
    username,
    appPassword,
  );
}

/** Unified diff for a Bitbucket PR. The /diff endpoint returns plain
 *  text by default — same shape as GitHub's vnd.github.v3.diff response. */
export async function fetchPullDiff(
  username: string,
  appPassword: string,
  repo: string,
  id: number,
): Promise<string> {
  const { workspace, slug } = splitRepo(repo);
  return bbText(
    `/2.0/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(
      slug,
    )}/pullrequests/${id}/diff`,
    username,
    appPassword,
  );
}

/** Post a top-level conversation comment on the PR. Bitbucket renders
 *  comments in markdown when `content.raw` is provided. */
export async function postPullComment(
  username: string,
  appPassword: string,
  repo: string,
  id: number,
  body: string,
): Promise<{ id: number; html_url: string | null }> {
  const { workspace, slug } = splitRepo(repo);
  const path = `/2.0/repositories/${encodeURIComponent(
    workspace,
  )}/${encodeURIComponent(slug)}/pullrequests/${id}/comments`;
  const res = await fetch(`${BB_BASE}${path}`, {
    method: "POST",
    headers: {
      authorization: basicHeader(username, appPassword),
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "agent-orchestrator",
    },
    body: JSON.stringify({ content: { raw: body } }),
  });
  if (!res.ok) throw new BitbucketError(res.status, path, await res.text());
  const data = (await res.json()) as { id: number; links?: { html?: { href?: string } } };
  return { id: data.id, html_url: data.links?.html?.href ?? null };
}
