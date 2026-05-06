/**
 * Per-integration config storage. The integrations table is generic
 * (id + JSON blob), this module owns the JSON shape per provider.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface IntegrationRow {
  id: string;
  enabled: number;
  config_json: string;
  last_synced_at: number | null;
  last_error: string | null;
  updated_at: number;
}

export interface GithubConfig {
  /** Personal-access token. Persisted only on this host. */
  token: string;
  /** `owner/name` strings the user opted in to. PRs from other repos
   *  are ignored even if the token would have access. */
  watched_repos: string[];
  /** Username from the validated token, surfaced in UI for clarity. */
  login?: string | null;
}

export interface BitbucketConfig {
  /** Bitbucket username or Atlassian email (basic-auth username field). */
  username: string;
  /** App password (or Atlassian API token) — basic-auth secret. */
  app_password: string;
  /** Workspace slug. Required for the post-CHANGE-2770 Atlassian API
   *  tokens since cross-workspace introspection is gone; legacy app
   *  passwords that hit /2.0/user without one set this from the
   *  validated user's primary workspace, or null if unknown. */
  workspace?: string | null;
  /** "{workspace}/{slug}" repo full names the user opted in to, mirroring
   *  the GitHub config shape so the rest of the system can treat them
   *  uniformly. */
  watched_repos?: string[];
  /** Atlassian account id from /2.0/user, surfaced for clarity. */
  account_id?: string | null;
  /** Bitbucket-internal UUID (`{guid}` format). Required for the
   *  `q=reviewers.uuid="…"` filter on PR listings — distinct from
   *  account_id which uses Atlassian's colon-separated id format. */
  uuid?: string | null;
  /** Display name from /2.0/user; null when the credential lacks the
   *  scope to read it. */
  display_name?: string | null;
}

/** Read raw row by id. */
export function getIntegration(id: string, handle: Database = db()): IntegrationRow | null {
  return handle
    .query<IntegrationRow, [string]>("SELECT * FROM integrations WHERE id = ?")
    .get(id);
}

/** Strongly-typed read for github specifically. Returns null when unset. */
export function getGithubConfig(handle: Database = db()): GithubConfig | null {
  const row = getIntegration("github", handle);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.config_json) as GithubConfig;
    if (!parsed?.token) return null;
    return {
      token: parsed.token,
      watched_repos: Array.isArray(parsed.watched_repos) ? parsed.watched_repos : [],
      login: parsed.login ?? null,
    };
  } catch {
    return null;
  }
}

/** Strongly-typed read for bitbucket. Returns null when unset. */
export function getBitbucketConfig(handle: Database = db()): BitbucketConfig | null {
  const row = getIntegration("bitbucket", handle);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.config_json) as BitbucketConfig;
    if (!parsed?.username || !parsed?.app_password) return null;
    return {
      username: parsed.username,
      app_password: parsed.app_password,
      workspace: parsed.workspace ?? null,
      watched_repos: Array.isArray(parsed.watched_repos)
        ? parsed.watched_repos
        : [],
      account_id: parsed.account_id ?? null,
      uuid: parsed.uuid ?? null,
      display_name: parsed.display_name ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Single-active enforcement. The product rule is "at most one integration
 * is active at a time" — connecting a new one disables the others without
 * deleting their stored config so the user can flip back without
 * re-entering credentials.
 */
export function disableOtherIntegrations(
  activeId: string,
  handle: Database = db(),
): void {
  handle
    .prepare(
      `UPDATE integrations SET enabled = 0, updated_at = ? WHERE id != ?`,
    )
    .run(Date.now(), activeId);
}

/**
 * Upsert the integration row. Writes config + sets enabled flag in one
 * call so the caller doesn't have to mask the legacy schema.
 */
export function upsertIntegration(
  id: string,
  config: unknown,
  enabled: boolean,
  handle: Database = db(),
): IntegrationRow {
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO integrations (id, enabled, config_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         enabled = excluded.enabled,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
    )
    .run(id, enabled ? 1 : 0, JSON.stringify(config), now);
  return getIntegration(id, handle)!;
}

/** Stamp last_synced_at + clear last_error. Best-effort. */
export function markSynced(id: string, handle: Database = db()): void {
  handle
    .prepare(
      "UPDATE integrations SET last_synced_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
    )
    .run(Date.now(), Date.now(), id);
}

/** Record an error against the integration without disabling it. */
export function markError(id: string, message: string, handle: Database = db()): void {
  handle
    .prepare(
      "UPDATE integrations SET last_error = ?, updated_at = ? WHERE id = ?",
    )
    .run(message.slice(0, 500), Date.now(), id);
}

export function deleteIntegration(id: string, handle: Database = db()): boolean {
  return handle.prepare("DELETE FROM integrations WHERE id = ?").run(id).changes > 0;
}
