/**
 * Per-task GitHub issue link API. Mounted under /api/tasks so paths
 * read as /api/tasks/:id/issue-links/...
 *
 * The user authors links manually — we never auto-link based on text
 * matching or LLM inference. The "refresh from github" endpoint
 * re-fetches issue state for the suggestion generator.
 */

import { Hono } from "hono";
import { z } from "zod";
import {
  createLink,
  deleteLink,
  listLinksForTask,
  type TaskIssueLink,
} from "../db/taskIssueLinks";
import { getGithubConfig } from "../db/integrations";
import { fetchIssue, GithubError, parseIssueRef } from "../integrations/github";
import { requireTask, type TaskVar } from "./middleware/requireTask";
import { log } from "../log";

export const issueLinks = new Hono<{ Variables: TaskVar }>();

issueLinks.use("/:taskId/issue-links", requireTask);
issueLinks.use("/:taskId/issue-links/*", requireTask);

issueLinks.get("/:taskId/issue-links", (c) => {
  return c.json({ links: listLinksForTask(c.var.task.id) });
});

const addSchema = z.object({
  /** "#142", "owner/name#142", or a github URL. */
  ref: z.string().min(1),
  /** Optional explicit repo override when `ref` is a bare number. Falls
   *  back to the GitHub integration's first watched_repo when omitted. */
  repo: z.string().optional(),
});

issueLinks.post("/:taskId/issue-links", async (c) => {
  const taskId = c.var.task.id;

  const parsed = addSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ error: "bad_request", details: parsed.error.format() }, 400);
  }

  const ref = parseIssueRef(parsed.data.ref);
  if (!ref) {
    return c.json({ error: "invalid_ref", message: "Could not parse issue reference." }, 400);
  }

  const cfg = getGithubConfig();
  if (!cfg) {
    return c.json(
      { error: "integration_missing", message: "Connect the GitHub integration first." },
      400,
    );
  }

  const repo =
    ref.repo ?? parsed.data.repo ?? cfg.watched_repos[0] ?? null;
  if (!repo) {
    return c.json(
      { error: "repo_required", message: "Bare issue numbers need a repo — pass owner/name#N or set a watched repo." },
      400,
    );
  }
  if (!cfg.watched_repos.includes(repo)) {
    return c.json(
      {
        error: "repo_not_watched",
        message: `Repo ${repo} isn't in your watched_repos allowlist.`,
        watched: cfg.watched_repos,
      },
      403,
    );
  }

  // Resolve the issue against GitHub so we can snapshot the title and
  // confirm it exists. Failure here means we don't link — better to
  // surface "issue not found" now than to record a phantom row.
  let title: string | null = null;
  let url: string | null = null;
  try {
    const issue = await fetchIssue(cfg.token, repo, ref.number);
    title = issue.title;
    url = issue.html_url;
  } catch (err) {
    if (err instanceof GithubError && err.status === 404) {
      return c.json({ error: "issue_not_found", repo, number: ref.number }, 404);
    }
    log.warn("api.issue_links.fetch_failed", {
      taskId,
      repo,
      number: ref.number,
      error: String(err),
    });
    return c.json({ error: "github_unreachable", message: String(err) }, 502);
  }

  const link = createLink({
    task_id: taskId,
    repo,
    issue_number: ref.number,
    title_snapshot: title,
    url_snapshot: url,
  });
  log.info("api.issue_links.created", { taskId, repo, number: ref.number });
  return c.json({ link });
});

issueLinks.delete("/:taskId/issue-links/:repoOwner/:repoName/:number", (c) => {
  const { repoOwner, repoName, number } = c.req.param();
  const ok = deleteLink(c.var.task.id, `${repoOwner}/${repoName}`, Number.parseInt(number, 10));
  if (!ok) return c.json({ error: "not_found" }, 404);
  return c.json({ ok: true });
});

/** Compact endpoint for batch "issue links across many tasks" — used by
 *  the home pipeline cards to show a #N chip per linked issue. */
issueLinks.get("/issue-links/by-tasks", (c) => {
  const ids = (c.req.query("ids") ?? "").split(",").filter(Boolean);
  if (ids.length === 0) return c.json({ links: {} as Record<string, TaskIssueLink[]> });
  const out: Record<string, TaskIssueLink[]> = {};
  for (const id of ids.slice(0, 200)) {
    out[id] = listLinksForTask(id);
  }
  return c.json({ links: out });
});
