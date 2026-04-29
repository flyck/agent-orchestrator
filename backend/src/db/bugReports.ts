import type { Database } from "bun:sqlite";
import { nanoid } from "nanoid";
import { db } from "./index";

export interface BugReportRow {
  id: string;
  page_url: string;
  user_agent: string | null;
  comment: string | null;
  html_snapshot: string;
  status: "open" | "investigating" | "resolved" | "dismissed";
  task_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface BugReportInput {
  page_url: string;
  user_agent?: string | null;
  comment?: string | null;
  html_snapshot: string;
}

export function createBugReport(input: BugReportInput, handle: Database = db()): BugReportRow {
  const id = `bug_${nanoid(16)}`;
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO bug_reports (id, page_url, user_agent, comment, html_snapshot, status, task_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
    )
    .run(
      id,
      input.page_url,
      input.user_agent ?? null,
      input.comment ?? null,
      input.html_snapshot,
      now,
      now,
    );
  return getBugReport(id, handle)!;
}

export function getBugReport(id: string, handle: Database = db()): BugReportRow | null {
  return handle
    .query<BugReportRow, [string]>("SELECT * FROM bug_reports WHERE id = ?")
    .get(id);
}

export function listBugReports(
  opts: { status?: string; limit?: number } = {},
  handle: Database = db(),
): BugReportRow[] {
  const limit = opts.limit ?? 100;
  if (opts.status) {
    return handle
      .query<BugReportRow, [string, number]>(
        "SELECT * FROM bug_reports WHERE status = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(opts.status, limit);
  }
  return handle
    .query<BugReportRow, [number]>(
      "SELECT * FROM bug_reports ORDER BY created_at DESC LIMIT ?",
    )
    .all(limit);
}
