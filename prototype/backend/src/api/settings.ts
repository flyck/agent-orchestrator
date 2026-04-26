import { Hono } from "hono";
import { z } from "zod";
import { readAllSettings, updateSettings } from "../db/settings";

const patchSchema = z.object({
  max_parallel_tasks: z.number().int().min(1).max(16).optional(),
  max_agents_per_task: z.number().int().min(1).max(16).optional(),
  daily_token_budget_usd: z.number().nonnegative().nullable().optional(),
  max_parallel_background_agents: z.number().int().min(1).max(8).optional(),
  max_background_runs_per_day: z.number().int().nonnegative().nullable().optional(),
  background_token_budget_usd_per_day: z.number().nonnegative().nullable().optional(),
  manual_coding_nudge_after_n_tasks: z.number().int().min(0).optional(),
  completed_since_last_nudge: z.number().int().min(0).optional(),
  engine: z.string().min(1).optional(),
  worktree_root: z.string().optional(),
  worktree_max_age_days: z.number().int().min(0).optional(),
  skills_directory: z.string().optional(),
  repo_context_enabled: z.boolean().optional(),
  readme_token_budget: z.number().int().nonnegative().optional(),
  backlog_token_budget: z.number().int().nonnegative().optional(),
  ide_open_command: z.string().optional(),
});

export const settings = new Hono();

settings.get("/", (c) => c.json(readAllSettings()));

settings.put("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_settings_patch", issues: parsed.error.issues }, 400);
  }
  return c.json(updateSettings(parsed.data));
});
