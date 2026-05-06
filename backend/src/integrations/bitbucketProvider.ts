/**
 * Bitbucket PrSourceProvider adapter. Wraps the HTTP helpers in
 * `./bitbucket.ts` so the API + Review page can dispatch through the
 * common `PrSourceProvider` interface.
 *
 * Single-workspace assumption (for now): the connect flow stamps the
 * first workspace `/2.0/user/workspaces` returns onto the config, and
 * watched-repo selections are scoped to that workspace. Multi-workspace
 * users can flip workspaces by reconnecting; broader support is a
 * follow-up.
 */

import { getBitbucketConfig } from "../db/integrations";
import {
  fetchPullDiff as bbFetchPullDiff,
  fetchPullRequest as bbFetchPullRequest,
  listPullRequests as bbListPullRequests,
  listRepos as bbListRepos,
  postPullComment as bbPostPullComment,
  BitbucketPullFilter,
  type BitbucketPullRaw,
} from "./bitbucket";
import {
  PullFilter,
  type NormalizedPull,
  type NormalizedRepo,
  type PrSourceProvider,
} from "./provider";

function toNormalizedPullFromRaw(
  repo: string,
  pr: BitbucketPullRaw,
  myUuid: string | null,
): NormalizedPull {
  const isReviewer = (pr.reviewers ?? []).some((r) => r.uuid === myUuid);
  let awaiting = !!myUuid && isReviewer;
  if (awaiting) {
    const me = (pr.participants ?? []).find(
      (p) => p.user?.uuid === myUuid && p.role === "REVIEWER",
    );
    if (me?.approved || me?.state === "approved" || me?.state === "changes_requested") {
      awaiting = false;
    }
  }
  return {
    source: "bitbucket",
    repo,
    number: pr.id,
    title: pr.title,
    url:
      pr.links?.html?.href ??
      `https://bitbucket.org/${repo}/pull-requests/${pr.id}`,
    author: pr.author?.display_name ?? pr.author?.nickname ?? "unknown",
    author_avatar: null,
    body: (pr.description ?? "").slice(0, 800),
    base_ref: pr.destination?.branch?.name ?? "",
    head_ref: pr.source?.branch?.name ?? "",
    draft: pr.draft === true,
    updated_at: pr.updated_on,
    created_at: pr.created_on,
    awaiting_me: awaiting,
  };
}

export function makeBitbucketProvider(): PrSourceProvider {
  return {
    id: "bitbucket",

    isConfigured() {
      return !!getBitbucketConfig();
    },

    listWatchedRepos() {
      return getBitbucketConfig()?.watched_repos ?? [];
    },

    async listRepos() {
      const cfg = getBitbucketConfig();
      if (!cfg) throw new Error("bitbucket_not_connected");
      if (!cfg.workspace) {
        throw new Error("bitbucket_workspace_unset");
      }
      const workspace = cfg.workspace;
      const repos = await bbListRepos(cfg.username, cfg.app_password, workspace);
      return repos.map<NormalizedRepo>((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: workspace,
        private: r.is_private,
        description: r.description,
        pushed_at: r.updated_on,
      }));
    },

    async listPullRequests(filter: PullFilter) {
      const cfg = getBitbucketConfig();
      if (!cfg) throw new Error("bitbucket_not_connected");
      const watched = cfg.watched_repos ?? [];
      const bbFilter =
        filter === PullFilter.AllOpen
          ? BitbucketPullFilter.AllOpen
          : BitbucketPullFilter.AwaitingMe;
      const prs = await bbListPullRequests(
        cfg.username,
        cfg.app_password,
        watched,
        bbFilter,
        cfg.account_id ?? null,
      );
      // bbListPullRequests already returns the BitbucketPull shape
      // (slim, with awaiting_me set). Map to NormalizedPull.
      return prs.map((p) => ({
        source: "bitbucket" as const,
        repo: p.repo,
        number: p.number,
        title: p.title,
        url: p.url,
        author: p.author,
        author_avatar: null,
        body: p.body,
        base_ref: p.base_ref,
        head_ref: p.head_ref,
        draft: p.draft,
        updated_at: p.updated_at,
        created_at: p.created_at,
        awaiting_me: p.awaiting_me,
      }));
    },

    async fetchPullRequest(repo: string, number: number) {
      const cfg = getBitbucketConfig();
      if (!cfg) throw new Error("bitbucket_not_connected");
      const raw = await bbFetchPullRequest(cfg.username, cfg.app_password, repo, number);
      return toNormalizedPullFromRaw(repo, raw, cfg.account_id ?? null);
    },

    async fetchPullDiff(repo: string, number: number) {
      const cfg = getBitbucketConfig();
      if (!cfg) throw new Error("bitbucket_not_connected");
      return bbFetchPullDiff(cfg.username, cfg.app_password, repo, number);
    },

    async postPullComment(repo: string, number: number, body: string) {
      const cfg = getBitbucketConfig();
      if (!cfg) throw new Error("bitbucket_not_connected");
      const r = await bbPostPullComment(
        cfg.username,
        cfg.app_password,
        repo,
        number,
        body,
      );
      return { html_url: r.html_url };
    },
  };
}
