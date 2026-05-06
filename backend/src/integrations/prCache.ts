/**
 * In-memory TTL cache for the generic /api/integrations/prs endpoint.
 *
 * Why bother: Bitbucket has no cross-repo PR index, so every list call
 * fans out N per-repo HTTP requests against api.bitbucket.org. Polling
 * every 60 seconds with 30 watched repos is 1800 requests an hour, most
 * of which return identical data. A 60-second TTL collapses repeated
 * Review-page polls to one upstream fetch without changing the user-
 * visible refresh cadence.
 *
 * Cache key encodes (provider, filter, watched-set hash) — flipping
 * filters or editing watched repos invalidates implicitly. The user can
 * also force a refresh with ?fresh=1 (the manual refresh button on the
 * Review page passes this).
 */

import type { NormalizedPull } from "./provider";

interface CacheEntry {
  prs: NormalizedPull[];
  cachedAt: number;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

function hashWatched(watched: string[]): string {
  // Sort so order doesn't matter; cheap djb2-ish hash since the watched
  // list is short. Don't need cryptographic strength.
  const joined = [...watched].sort().join("\n");
  let h = 5381;
  for (let i = 0; i < joined.length; i++) {
    h = ((h << 5) + h + joined.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

export function cacheKey(
  providerId: string,
  filter: string,
  watched: string[],
): string {
  return `${providerId}|${filter}|${hashWatched(watched)}`;
}

/** Returns the cached entry if still fresh (within TTL_MS), else null. */
export function getFresh(key: string, now = Date.now()): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (e.expiresAt <= now) {
    cache.delete(key);
    return null;
  }
  return e;
}

/** Stores the result with a fresh expiry stamp. */
export function set(
  key: string,
  prs: NormalizedPull[],
  now = Date.now(),
): CacheEntry {
  const entry: CacheEntry = { prs, cachedAt: now, expiresAt: now + TTL_MS };
  cache.set(key, entry);
  return entry;
}

/** Drop every cached entry for a provider — invoked when watched_repos
 *  changes. Cheap because the cache is small (few keys per provider). */
export function invalidate(providerId: string): void {
  for (const k of cache.keys()) {
    if (k.startsWith(`${providerId}|`)) cache.delete(k);
  }
}
