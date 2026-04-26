/**
 * Integrations stub. Phase 13 will wire real GitHub/Bitbucket connectors;
 * for now this exists so the Review tab can check whether any provider is
 * configured and surface a warning if not.
 */

import type { Database } from "bun:sqlite";
import { Hono } from "hono";
import { db } from "../db";

interface IntegrationRow {
  id: string;
  enabled: number;
  config_json: string;
  last_synced_at: number | null;
  last_error: string | null;
  updated_at: number;
}

function listConfigured(handle: Database = db()) {
  return handle
    .query<IntegrationRow, []>("SELECT * FROM integrations")
    .all()
    .map((r) => ({
      id: r.id,
      enabled: r.enabled === 1,
      last_synced_at: r.last_synced_at,
      last_error: r.last_error,
      updated_at: r.updated_at,
    }));
}

const KNOWN: { id: string; name: string; description: string }[] = [
  { id: "github",    name: "GitHub",    description: "Read issues and PRs from configured repos." },
  { id: "bitbucket", name: "Bitbucket", description: "Read PRs and issues from configured repos." },
  { id: "gitlab",    name: "GitLab",    description: "Read MRs and issues from configured projects." },
];

export const integrations = new Hono();

integrations.get("/", (c) => {
  const configured = listConfigured();
  const byId = new Map(configured.map((i) => [i.id, i]));
  const items = KNOWN.map((k) => {
    const c = byId.get(k.id);
    return {
      id: k.id,
      name: k.name,
      description: k.description,
      configured: !!c,
      enabled: c?.enabled ?? false,
      last_synced_at: c?.last_synced_at ?? null,
      last_error: c?.last_error ?? null,
    };
  });
  return c.json({
    integrations: items,
    any_enabled: items.some((i) => i.enabled),
  });
});
