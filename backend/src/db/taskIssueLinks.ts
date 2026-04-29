/**
 * Task ↔ GitHub-issue links. The user authors the relationship; the
 * orchestrator never invents one. Used by the suggestion generator to
 * surface still-open issues after a linked task completes.
 *
 * Snapshots (title, URL) are stored at link time so the UI can render
 * even when GitHub is unreachable. The live open/closed state is
 * fetched on demand by the generator.
 */

import type { Database } from "bun:sqlite";
import { db } from "./index";

export interface TaskIssueLink {
  task_id: string;
  repo: string; // "owner/name"
  issue_number: number;
  title_snapshot: string | null;
  url_snapshot: string | null;
  linked_at: number;
}

export interface CreateLinkInput {
  task_id: string;
  repo: string;
  issue_number: number;
  title_snapshot?: string | null;
  url_snapshot?: string | null;
}

export function createLink(
  input: CreateLinkInput,
  handle: Database = db(),
): TaskIssueLink {
  const now = Date.now();
  handle
    .prepare(
      `INSERT INTO task_issue_links
         (task_id, repo, issue_number, title_snapshot, url_snapshot, linked_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id, repo, issue_number) DO UPDATE SET
         title_snapshot = excluded.title_snapshot,
         url_snapshot   = excluded.url_snapshot`,
    )
    .run(
      input.task_id,
      input.repo,
      input.issue_number,
      input.title_snapshot ?? null,
      input.url_snapshot ?? null,
      now,
    );
  return {
    task_id: input.task_id,
    repo: input.repo,
    issue_number: input.issue_number,
    title_snapshot: input.title_snapshot ?? null,
    url_snapshot: input.url_snapshot ?? null,
    linked_at: now,
  };
}

export function deleteLink(
  taskId: string,
  repo: string,
  issueNumber: number,
  handle: Database = db(),
): boolean {
  const r = handle
    .prepare(
      "DELETE FROM task_issue_links WHERE task_id = ? AND repo = ? AND issue_number = ?",
    )
    .run(taskId, repo, issueNumber);
  return r.changes > 0;
}

export function listLinksForTask(
  taskId: string,
  handle: Database = db(),
): TaskIssueLink[] {
  return handle
    .query<TaskIssueLink, [string]>(
      `SELECT * FROM task_issue_links WHERE task_id = ? ORDER BY linked_at ASC`,
    )
    .all(taskId);
}

/** Tasks that share a link to a given issue. Used by the inverse query
 *  (future "Up next" feed: open issues with at least one task linked
 *  but no completed task). */
export function listTasksForIssue(
  repo: string,
  issueNumber: number,
  handle: Database = db(),
): TaskIssueLink[] {
  return handle
    .query<TaskIssueLink, [string, number]>(
      `SELECT * FROM task_issue_links WHERE repo = ? AND issue_number = ?`,
    )
    .all(repo, issueNumber);
}
