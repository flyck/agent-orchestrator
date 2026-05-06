/**
 * Provider abstraction for PR-source integrations (GitHub, Bitbucket, …).
 *
 * The product rule is "one integration active at a time" — every Review
 * Page request goes through whichever provider has `enabled=1` in the
 * integrations table. The provider implementations sit alongside in
 * github.ts / bitbucket.ts; this file just defines the shared shape +
 * the active-provider lookup.
 *
 * Settings-specific endpoints (token connect, repo picker for watched-
 * repos) stay per-provider — those forms are intrinsically shaped by
 * the upstream auth model and don't benefit from genericization.
 */

import {
  getBitbucketConfig,
  getGithubConfig,
  getIntegration,
} from "../db/integrations";

export const PullFilter = {
  AwaitingMe: "awaiting_me",
  AllOpen: "all_open",
} as const;
export type PullFilter = (typeof PullFilter)[keyof typeof PullFilter];

/**
 * Slim, transport-ready repo shape. Mirrors what the GitHub /github/repos
 * endpoint already returns, so the existing Settings → watched-repos
 * picker can switch over without UI changes.
 */
export interface NormalizedRepo {
  /** "{owner_or_workspace}/{slug}" — used as the stable id everywhere. */
  full_name: string;
  /** Last segment of full_name. */
  name: string;
  /** First segment — the GH owner login, or the BB workspace slug. */
  owner: string;
  private: boolean;
  description: string | null;
  /** ISO timestamp of the last push (null when the provider doesn't
   *  surface it on the listing). */
  pushed_at: string | null;
}

/**
 * Slim PR shape served by the generic /api/integrations/prs endpoint.
 * Same field set as the existing GitHub `slimPull` output so the Review
 * page can stay provider-agnostic.
 */
export interface NormalizedPull {
  /** Provider id ("github" | "bitbucket") so the UI can label the row. */
  source: ProviderId;
  /** "{owner_or_workspace}/{slug}". */
  repo: string;
  /** Numeric PR id (GH) or PR id (BB). */
  number: number;
  title: string;
  url: string;
  author: string;
  /** Avatar URL when the provider exposes one; null otherwise. */
  author_avatar: string | null;
  body: string;
  base_ref: string;
  head_ref: string;
  draft: boolean;
  /** ISO timestamp. */
  updated_at: string;
  /** ISO timestamp. */
  created_at: string;
  /** True when the authed user is a requested reviewer who hasn't yet
   *  approved or requested changes. */
  awaiting_me: boolean;
}

export type ProviderId = "github" | "bitbucket";

/**
 * The runtime contract every PR-source provider satisfies. Methods
 * throw on transport / auth errors — callers translate to HTTP status
 * codes the same way the github routes do today.
 */
export interface PrSourceProvider {
  readonly id: ProviderId;
  /** Has the user persisted credentials for this provider? Used to
   *  short-circuit the generic endpoints with "not_connected" before
   *  attempting a network call. */
  isConfigured(): boolean;
  /** Repos in scope for this credential. For GH, the user's
   *  accessible repos; for BB, the connected workspace's repos. */
  listRepos(): Promise<NormalizedRepo[]>;
  /** Repos the user opted in to via the watched-repos picker. PR
   *  listing only walks these; empty means "no watched repos". */
  listWatchedRepos(): string[];
  /** Persist the watched-repos selection. The implementation rewrites
   *  the provider's stored config in place; the credential portion is
   *  untouched. Caller already validated the array shape. */
  setWatchedRepos(repos: string[]): void;
  /** PRs across the watched repos. */
  listPullRequests(filter: PullFilter): Promise<NormalizedPull[]>;
  /** Single PR — fetched when the user clicks Review. */
  fetchPullRequest(repo: string, number: number): Promise<NormalizedPull>;
  /** Unified diff text for the PR. */
  fetchPullDiff(repo: string, number: number): Promise<string>;
  /** Post a top-level conversation comment back to the PR. */
  postPullComment(
    repo: string,
    number: number,
    body: string,
  ): Promise<{ html_url: string | null }>;
}

/**
 * Look up the currently active provider — the integration row whose
 * `enabled=1` flag is set. The single-active rule (enforced when the
 * user connects any provider) guarantees at most one match. Returns
 * null when nothing is enabled.
 *
 * Lazy import of the provider modules avoids the cycle between
 * provider.ts ↔ githubProvider.ts which would otherwise pull in the
 * github HTTP client at module-load time.
 */
export async function getActiveProvider(): Promise<PrSourceProvider | null> {
  const gh = getIntegration("github");
  if (gh?.enabled === 1 && getGithubConfig()) {
    const mod = await import("./githubProvider");
    return mod.makeGithubProvider();
  }
  const bb = getIntegration("bitbucket");
  if (bb?.enabled === 1 && getBitbucketConfig()) {
    const mod = await import("./bitbucketProvider");
    return mod.makeBitbucketProvider();
  }
  return null;
}
