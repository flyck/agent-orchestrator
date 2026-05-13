import { inject, Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface IntegrationStatus {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  enabled: boolean;
  last_synced_at: number | null;
  last_error: string | null;
  /** GitHub only: the validated user's login. */
  login?: string | null;
  /** GitHub only: opted-in repo full names. */
  watched_repos?: string[];
  /** Bitbucket only: the basic-auth username (or Atlassian email). */
  username?: string | null;
  /** Bitbucket only: display name from /2.0/user (when scope allows). */
  display_name?: string | null;
  /** Bitbucket only: workspace slug the credential is scoped to. */
  workspace?: string | null;
}

export interface IntegrationsResponse {
  integrations: IntegrationStatus[];
  any_enabled: boolean;
}

export interface GithubRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
}

/** Same slim shape as GithubRepo — the generic /api/integrations/repos
 *  endpoint returns this for both providers. */
export interface NormalizedRepo {
  full_name: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  pushed_at: string | null;
}

export interface GithubPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_avatar: string;
  body: string;
  base_ref: string;
  head_ref: string;
  draft: boolean;
  updated_at: string;
  created_at: string;
  /** Server-computed: true when the authed user is in
   *  requested_reviewers. The Review button is gated on this. */
  awaiting_me: boolean;
}

/** Normalized PR shape served by the generic /api/integrations/prs
 *  endpoint. Same shape as GithubPr plus a `source` tag and a
 *  nullable avatar (Bitbucket doesn't surface one on the listing). */
export interface NormalizedPr {
  source: 'github' | 'bitbucket';
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  author_avatar: string | null;
  body: string;
  base_ref: string;
  head_ref: string;
  draft: boolean;
  updated_at: string;
  created_at: string;
  awaiting_me: boolean;
  reviewers: PrReviewer[];
}

export interface PrReviewer {
  id: string;
  name: string;
  avatar_url: string | null;
  state: 'pending' | 'approved' | 'changes_requested';
}

export const PrFilter = {
  AwaitingMe: 'awaiting_me',
  AllOpen: 'all_open',
} as const;
export type PrFilter = (typeof PrFilter)[keyof typeof PrFilter];

export interface ConnectInput {
  token?: string | null;
  watched_repos?: string[];
}

@Injectable({ providedIn: 'root' })
export class IntegrationsService {
  private http = inject(HttpClient);

  list(): Observable<IntegrationsResponse> {
    return this.http.get<IntegrationsResponse>('/api/integrations');
  }

  /** Set / update the GitHub token + watched repos. Token validation
   *  happens server-side; a 401 means the token was rejected. */
  connectGithub(
    input: ConnectInput,
  ): Observable<{ ok: boolean; login: string | null; watched_repos: string[] }> {
    return this.http.post<{ ok: boolean; login: string | null; watched_repos: string[] }>(
      '/api/integrations/github/connect',
      input,
    );
  }

  /** Wipe the GitHub config. */
  disconnectGithub(): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>('/api/integrations/github');
  }

  /** Repos the user has access to via the stored token. */
  listGithubRepos(): Observable<{ repos: GithubRepo[] }> {
    return this.http.get<{ repos: GithubRepo[] }>('/api/integrations/github/repos');
  }

  /** PRs across watched repos. `filter` defaults to 'awaiting_me' (PRs
   *  where the user is a requested reviewer); 'all_open' returns every
   *  open PR in any watched repo. */
  listGithubPrs(
    filter: PrFilter = 'awaiting_me',
  ): Observable<{ prs: GithubPr[]; message?: string; filter: PrFilter }> {
    return this.http.get<{ prs: GithubPr[]; message?: string; filter: PrFilter }>(
      '/api/integrations/github/prs',
      { params: { filter } },
    );
  }

  /** Spawn a review task for one PR. Returns the new task id. */
  reviewPr(repoFullName: string, number: number): Observable<{ task_id: string }> {
    const [owner, repo] = repoFullName.split('/');
    return this.http.post<{ task_id: string }>(
      `/api/integrations/github/prs/${owner}/${repo}/${number}/review`,
      {},
    );
  }

  /** Connect Bitbucket. The backend introspects the credential against
   *  /2.0/user/workspaces (the supported replacement after CHANGE-2770)
   *  and stores the first visible workspace as the default. */
  connectBitbucket(input: {
    username: string;
    app_password: string;
  }): Observable<{
    ok: boolean;
    username: string;
    workspace: string | null;
    workspaces: string[];
    display_name: string | null;
  }> {
    return this.http.post<{
      ok: boolean;
      username: string;
      workspace: string | null;
      workspaces: string[];
      display_name: string | null;
    }>('/api/integrations/bitbucket/connect', input);
  }

  /** Wipe the Bitbucket config. */
  disconnectBitbucket(): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>('/api/integrations/bitbucket');
  }

  /** Manually override the Bitbucket workspace slug. Used when
   *  /2.0/user/workspaces returns empty (identity-mismatch case for
   *  some Atlassian API tokens). */
  setBitbucketWorkspace(workspace: string): Observable<{
    ok: boolean;
    workspace: string;
  }> {
    return this.http.patch<{ ok: boolean; workspace: string }>(
      '/api/integrations/bitbucket/workspace',
      { workspace },
    );
  }

  /** Provider-agnostic repo listing for the watched-repos picker. */
  listRepos(): Observable<{
    source: 'github' | 'bitbucket' | null;
    repos: NormalizedRepo[];
  }> {
    return this.http.get<{
      source: 'github' | 'bitbucket' | null;
      repos: NormalizedRepo[];
    }>('/api/integrations/repos');
  }

  /** Persist the watched-repos selection on the active provider. */
  setWatchedRepos(repos: string[]): Observable<{
    ok: boolean;
    source: 'github' | 'bitbucket';
    watched_repos: string[];
  }> {
    return this.http.patch<{
      ok: boolean;
      source: 'github' | 'bitbucket';
      watched_repos: string[];
    }>('/api/integrations/watched', { watched_repos: repos });
  }

  /** Provider-agnostic PR list. Routes through whichever integration is
   *  currently enabled (GitHub or Bitbucket). Returns `not_connected`
   *  when nothing is set up. Pass `fresh=true` to bypass the 60s
   *  server-side cache — used by the manual refresh button. */
  listPrs(
    filter: PrFilter = 'awaiting_me',
    fresh = false,
  ): Observable<{
    source: 'github' | 'bitbucket' | null;
    filter?: PrFilter;
    prs: NormalizedPr[];
    message?: string;
    error?: string;
    cached?: boolean;
    cached_age_ms?: number;
  }> {
    const params: Record<string, string> = { filter };
    if (fresh) params['fresh'] = '1';
    return this.http.get<{
      source: 'github' | 'bitbucket' | null;
      filter?: PrFilter;
      prs: NormalizedPr[];
      message?: string;
      error?: string;
      cached?: boolean;
      cached_age_ms?: number;
    }>('/api/integrations/prs', { params });
  }

  /** Spawn a review task for a normalized PR. Backend dispatches to the
   *  active provider. */
  reviewNormalizedPr(
    repoFullName: string,
    number: number,
  ): Observable<{ task_id: string; source: 'github' | 'bitbucket' }> {
    const [owner, repo] = repoFullName.split('/');
    return this.http.post<{ task_id: string; source: 'github' | 'bitbucket' }>(
      `/api/integrations/prs/${owner}/${repo}/${number}/review`,
      {},
    );
  }

  /** Post a curated review comment back to the PR for a review-workspace
   *  task. Backend looks up the PR coordinates on the task and dispatches
   *  to whichever provider the task was created against. */
  postReviewComment(
    taskId: string,
    body: string,
  ): Observable<{ ok: true; source: 'github' | 'bitbucket'; html_url: string | null }> {
    return this.http.post<{
      ok: true;
      source: 'github' | 'bitbucket';
      html_url: string | null;
    }>('/api/integrations/comment', { task_id: taskId, body, confirm: true });
  }
}
