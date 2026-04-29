import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";

export interface AgentRow {
  id: string;
  slug: string;
  name: string;
  icon: string;
  role: string;
  concurrency_class: "foreground" | "background";
  file_path: string;
  prompt_hash: string;
  model_provider_id: string | null;
  model_id: string | null;
  cadence_json: string | null;
  limits_json: string | null;
  enabled: boolean;
  is_builtin: boolean;
  created_at: number;
  updated_at: number;
}

interface RawAgentRow {
  id: string;
  slug: string;
  name: string;
  icon: string;
  role: string;
  concurrency_class: string;
  file_path: string;
  prompt_hash: string;
  model_provider_id: string | null;
  model_id: string | null;
  cadence_json: string | null;
  limits_json: string | null;
  enabled: number;
  is_builtin: number;
  created_at: number;
  updated_at: number;
}

const fromRaw = (r: RawAgentRow): AgentRow => ({
  ...r,
  concurrency_class: r.concurrency_class as AgentRow["concurrency_class"],
  enabled: r.enabled === 1,
  is_builtin: r.is_builtin === 1,
});

export interface UpsertAgentInput {
  slug: string;
  name: string;
  icon: string;
  role: string;
  concurrency_class: "foreground" | "background";
  file_path: string;
  prompt_hash: string;
  model_provider_id?: string | null;
  model_id?: string | null;
  cadence_json?: string | null;
  limits_json?: string | null;
  enabled: boolean;
  is_builtin: boolean;
}

export function upsertAgentBySlug(input: UpsertAgentInput, handle: Database = db()): AgentRow {
  const now = Date.now();
  const existing = handle
    .query<RawAgentRow, [string]>("SELECT * FROM agents WHERE slug = ?")
    .get(input.slug);

  if (existing) {
    handle
      .prepare(
        `UPDATE agents SET
           name = ?, icon = ?, role = ?, concurrency_class = ?,
           file_path = ?, prompt_hash = ?,
           model_provider_id = ?, model_id = ?,
           cadence_json = ?, limits_json = ?,
           is_builtin = ?,
           updated_at = ?
         WHERE slug = ?`,
      )
      .run(
        input.name,
        input.icon,
        input.role,
        input.concurrency_class,
        input.file_path,
        input.prompt_hash,
        input.model_provider_id ?? null,
        input.model_id ?? null,
        input.cadence_json ?? null,
        input.limits_json ?? null,
        input.is_builtin ? 1 : 0,
        now,
        input.slug,
      );
    // We deliberately do NOT overwrite `enabled` on update — the user may
    // have toggled it via the UI, and a re-sync of the file shouldn't
    // override that intent.
    return getAgentBySlug(input.slug, handle)!;
  }

  const id = `agt_${nanoid(16)}`;
  handle
    .prepare(
      `INSERT INTO agents (
         id, slug, name, icon, role, concurrency_class,
         file_path, prompt_hash,
         model_provider_id, model_id, cadence_json, limits_json,
         enabled, is_builtin, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.slug,
      input.name,
      input.icon,
      input.role,
      input.concurrency_class,
      input.file_path,
      input.prompt_hash,
      input.model_provider_id ?? null,
      input.model_id ?? null,
      input.cadence_json ?? null,
      input.limits_json ?? null,
      input.enabled ? 1 : 0,
      input.is_builtin ? 1 : 0,
      now,
      now,
    );
  return getAgentBySlug(input.slug, handle)!;
}

export function getAgentBySlug(slug: string, handle: Database = db()): AgentRow | null {
  const r = handle
    .query<RawAgentRow, [string]>("SELECT * FROM agents WHERE slug = ?")
    .get(slug);
  return r ? fromRaw(r) : null;
}

export function getAgentById(id: string, handle: Database = db()): AgentRow | null {
  const r = handle.query<RawAgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  return r ? fromRaw(r) : null;
}

export function listAgents(handle: Database = db()): AgentRow[] {
  return handle
    .query<RawAgentRow, []>("SELECT * FROM agents ORDER BY role, name")
    .all()
    .map(fromRaw);
}
