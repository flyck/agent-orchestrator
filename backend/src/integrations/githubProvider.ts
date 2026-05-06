/**
 * GitHub PrSourceProvider implementation. Thin adapter over the existing
 * functions in `./github.ts` plus the slim-shape mappers from the API
 * layer — kept here so the provider interface fully owns the
 * transport-ready output.
 */

import { getGithubConfig, upsertIntegration } from "../db/integrations";
import {
  fetchPullDiff as ghFetchPullDiff,
  fetchPullRequest as ghFetchPullRequest,
  listPullRequests as ghListPullRequests,
  listRepos as ghListRepos,
  postIssueComment as ghPostIssueComment,
  PullFilter as GhPullFilter,
  type GithubPull,
} from "./github";
import {
  PullFilter,
  type NormalizedPull,
  type NormalizedRepo,
  type PrSourceProvider,
} from "./provider";

function toRepo(r: {
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  description: string | null;
  pushed_at: string | null;
}): NormalizedRepo {
  return {
    full_name: r.full_name,
    name: r.name,
    owner: r.owner.login,
    private: r.private,
    description: r.description,
    pushed_at: r.pushed_at,
  };
}

function toPull(pr: GithubPull): NormalizedPull {
  return {
    source: "github",
    repo: pr.repo_full_name ?? "",
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

export function makeGithubProvider(): PrSourceProvider {
  return {
    id: "github",

    isConfigured() {
      return !!getGithubConfig();
    },

    listWatchedRepos() {
      return getGithubConfig()?.watched_repos ?? [];
    },

    setWatchedRepos(repos: string[]) {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      upsertIntegration(
        "github",
        { ...cfg, watched_repos: repos },
        true,
      );
    },

    async listRepos() {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      const repos = await ghListRepos(cfg.token);
      return repos.map(toRepo);
    },

    async listPullRequests(filter: PullFilter) {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      const ghFilter =
        filter === PullFilter.AllOpen
          ? GhPullFilter.AllOpen
          : GhPullFilter.AwaitingMe;
      const prs = await ghListPullRequests(
        cfg.token,
        cfg.watched_repos,
        ghFilter,
        cfg.login ?? undefined,
      );
      return prs.map(toPull);
    },

    async fetchPullRequest(repo: string, number: number) {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      const pr = await ghFetchPullRequest(cfg.token, repo, number);
      const awaiting =
        !!cfg.login &&
        (pr.requested_reviewers ?? []).some((r) => r.login === cfg.login);
      return toPull({ ...pr, repo_full_name: repo, awaiting_me: awaiting });
    },

    async fetchPullDiff(repo: string, number: number) {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      return ghFetchPullDiff(cfg.token, repo, number);
    },

    async postPullComment(repo: string, number: number, body: string) {
      const cfg = getGithubConfig();
      if (!cfg) throw new Error("github_not_connected");
      const r = await ghPostIssueComment(cfg.token, repo, number, body);
      return { html_url: r.html_url ?? null };
    },
  };
}
