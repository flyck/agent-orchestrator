import { Hono } from "hono";
import { z } from "zod";
import { createBugReport, getBugReport, listBugReports } from "../db/bugReports";
import { log } from "../log";

const MAX_HTML_BYTES = 1_500_000; // ~1.5 MB cap on snapshots; backend rejects larger

const createSchema = z.object({
  page_url: z.string().url(),
  user_agent: z.string().max(2000).nullable().optional(),
  comment: z.string().max(10_000).nullable().optional(),
  html_snapshot: z.string().min(1).max(MAX_HTML_BYTES),
});

export const bugReports = new Hono();

bugReports.get("/", (c) => {
  const status = c.req.query("status");
  const limit = c.req.query("limit");
  const reports = listBugReports({
    status,
    limit: limit ? Number(limit) : undefined,
  }).map(({ html_snapshot, ...rest }) => ({
    ...rest,
    html_snapshot_bytes: html_snapshot.length,
    // Don't return the snapshot in the list view — too heavy.
  }));
  return c.json({ reports });
});

bugReports.get("/:id", (c) => {
  const r = getBugReport(c.req.param("id"));
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

bugReports.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_bug_report", issues: parsed.error.issues }, 400);
  }
  const r = createBugReport(parsed.data);
  log.info("bug_report.created", {
    id: r.id,
    page_url: r.page_url,
    has_comment: !!r.comment,
    snapshot_bytes: r.html_snapshot.length,
  });
  return c.json({ id: r.id, status: r.status, created_at: r.created_at }, 201);
});
