/**
 * Time-format helpers shared by every page that renders a timestamp.
 * Pulled out of `pages/home/home.ts` so peer pages (review, etc) don't
 * have to cross-import a sibling page.
 */

/** ISO date + time, UTC. Hover shows the same; we just want unambiguous text. */
export function formatTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

/** Compact local clock time `HH:MM:SS` — for streaming logs where rows
 *  arrive seconds apart and a relative "5s ago" reads as noise. */
export function clockTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** "5s ago", "12m ago", "2h ago", "3d ago" — coarse but consistent. */
export function relativeTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const diff = Math.max(0, Date.now() - ms);
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
