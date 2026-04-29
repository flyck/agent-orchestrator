import { Hono } from "hono";
import { readAllSettings, resetCompletedSinceNudge } from "../db/settings";
import { log } from "../log";

export const nudge = new Hono();

/**
 * Dismiss the manual-coding nudge: zero the counter so the banner stays
 * down until the user completes another N tasks (per the configured
 * `manual_coding_nudge_after_n_tasks`). The frontend computes visibility
 * client-side from `completed_since_last_nudge >= threshold`.
 */
nudge.post("/dismiss", (c) => {
  resetCompletedSinceNudge();
  log.info("api.nudge.dismissed");
  return c.json(readAllSettings());
});
