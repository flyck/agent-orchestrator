import { Hono } from "hono";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { listAgents, getAgentById } from "../db/agents";
import { log } from "../log";

export const agents = new Hono();

agents.get("/", (c) => c.json({ agents: listAgents() }));

agents.get("/:id", (c) => {
  const row = getAgentById(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});

/** Return the raw markdown source of an agent's prompt file, split
 *  into frontmatter + body so the editor can render two panes
 *  without parsing on the client. */
agents.get("/:id/source", (c) => {
  const row = getAgentById(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  if (!existsSync(row.file_path)) {
    return c.json({ error: "file_missing", path: row.file_path }, 404);
  }
  try {
    const raw = readFileSync(row.file_path, "utf8");
    const m = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
    const frontmatter = m ? m[1] ?? "" : "";
    const body = m ? m[2] ?? "" : raw;
    return c.json({
      slug: row.slug,
      file_path: row.file_path,
      frontmatter,
      body,
      raw,
    });
  } catch (err) {
    log.error("api.agents.source_read_failed", { id: row.id, error: String(err) });
    return c.json({ error: "read_failed", message: String(err) }, 500);
  }
});

const sourceUpdateSchema = z.object({
  frontmatter: z.string().max(8_000),
  body: z.string().max(80_000),
});

/** Persist edits to the agent's prompt file. Frontmatter and body
 *  are recomposed into the `--- … ---` envelope before write. The
 *  pipeline runner reads agent prompts at module init so the user
 *  must restart the backend for edits to take effect — surfaced as
 *  `requires_restart: true` in the response so the UI can hint. */
agents.put("/:id/source", async (c) => {
  const row = getAgentById(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  const body = await c.req.json().catch(() => null);
  const parsed = sourceUpdateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }
  const fm = parsed.data.frontmatter.trim();
  const md = parsed.data.body.replace(/^\s+/, "");
  const recomposed = fm ? `---\n${fm}\n---\n\n${md}` : md;
  try {
    writeFileSync(row.file_path, recomposed, "utf8");
    log.info("api.agents.source_updated", { id: row.id, slug: row.slug, bytes: recomposed.length });
    return c.json({ ok: true, requires_restart: true, bytes: recomposed.length });
  } catch (err) {
    log.error("api.agents.source_write_failed", { id: row.id, error: String(err) });
    return c.json({ error: "write_failed", message: String(err) }, 500);
  }
});
