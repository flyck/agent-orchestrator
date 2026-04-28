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

export type PrFilter = 'awaiting_me' | 'all_open';

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
}
