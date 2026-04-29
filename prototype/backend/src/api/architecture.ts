/**
 * Architecture tab. Aggregates approved tasks (status='done') that
 * carry at least one mermaid diagram — the intake agent's concept
 * sketch and/or the reviewer's per-alternative shapes — so the user
 * can flip back through past architectures.
 *
 * Mermaid extraction matches the same YAML-block regex the home page
 * uses for the live Review tab.
 */

import { Hono } from "hono";
import { db } from "../db";

export const architecture = new Hono();

interface DoneTaskRow {
  id: string;
  title: string;
  workspace: string;
  repo_path: string | null;
  updated_at: number;
  current_state: string | null;
}

interface PhaseOutputRow {
  task_id: string;
  output_md: string;
}

interface AlternativeRow {
  task_id: string;
  label: string;
  verdict: string;
  diagram_mermaid: string | null;
}

export interface ArchitectureDiagram {
  kind: "intake" | "alternative";
  label: string;
  source: string;
  /** Reviewer verdict for alternatives ('better' | 'equal' | 'worse'). */
  verdict?: string;
}

export interface ArchitectureTask {
  id: string;
  title: string;
  workspace: string;
  repo_path: string | null;
  completed_at: number;
  state: string | null;
  diagrams: ArchitectureDiagram[];
}

/** Pull the `diagram_mermaid: |` block out of a YAML-ish reply. Returns
 *  null when the block isn't present. Mirror of the home-page client
 *  extractor so a task's stored agent reply renders identically here. */
function extractMermaid(text: string): string | null {
  // Match without /m so `$` anchors to end-of-string. With /m the
  // `$` alternative matched every line end and truncated the block
  // to its first line.
  const match = text.match(
    /(?:^|\n)[ \t]*diagram_mermaid:[ \t]*\|[ \t]*\n([\s\S]*?)(?=\n[A-Za-z_][A-Za-z0-9_-]*:|$)/,
  );
  if (!match) return null;
  const block = match[1] ?? "";
  const lines = block.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  const indents = lines.map((l) => l.match(/^[ \t]*/)?.[0].length ?? 0);
  const minIndent = Math.min(...indents);
  return block
    .split("\n")
    .map((l) => l.slice(minIndent))
    .join("\n")
    .trim();
}

architecture.get("/diagrams", (c) => {
  const handle = db();

  const doneTasks = handle
    .query<DoneTaskRow, []>(
      `SELECT id, title, workspace, repo_path, updated_at, current_state
         FROM tasks
        WHERE status = 'done'
        ORDER BY updated_at DESC`,
    )
    .all();
  if (doneTasks.length === 0) return c.json({ tasks: [] });

  const ids = doneTasks.map((t) => t.id);
  const placeholders = ids.map(() => "?").join(",");

  const intakeRows = handle
    .query<PhaseOutputRow, never[]>(
      `SELECT task_id, output_md
         FROM task_phase_outputs
        WHERE phase_id = 'intake' AND task_id IN (${placeholders})
        ORDER BY created_at DESC`,
    )
    .all(...(ids as never[]));
  const intakeByTask = new Map<string, string>();
  for (const r of intakeRows) {
    if (!intakeByTask.has(r.task_id)) intakeByTask.set(r.task_id, r.output_md);
  }

  const altRows = handle
    .query<AlternativeRow, never[]>(
      `SELECT task_id, label, verdict, diagram_mermaid
         FROM task_alternatives
        WHERE diagram_mermaid IS NOT NULL AND task_id IN (${placeholders})
        ORDER BY id ASC`,
    )
    .all(...(ids as never[]));
  const altsByTask = new Map<string, AlternativeRow[]>();
  for (const r of altRows) {
    const arr = altsByTask.get(r.task_id) ?? [];
    arr.push(r);
    altsByTask.set(r.task_id, arr);
  }

  const out: ArchitectureTask[] = [];
  for (const t of doneTasks) {
    const diagrams: ArchitectureDiagram[] = [];

    const intakeMd = intakeByTask.get(t.id);
    if (intakeMd) {
      const src = extractMermaid(intakeMd);
      if (src) diagrams.push({ kind: "intake", label: "concept", source: src });
    }

    for (const alt of altsByTask.get(t.id) ?? []) {
      if (alt.diagram_mermaid) {
        diagrams.push({
          kind: "alternative",
          label: alt.label,
          source: alt.diagram_mermaid,
          verdict: alt.verdict,
        });
      }
    }

    if (diagrams.length === 0) continue;

    out.push({
      id: t.id,
      title: t.title,
      workspace: t.workspace,
      repo_path: t.repo_path,
      completed_at: t.updated_at,
      state: t.current_state,
      diagrams,
    });
  }

  return c.json({ tasks: out });
});
