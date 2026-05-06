import { Hono } from "hono";
import { z } from "zod";
import { recordContextSwitch, listContextSwitchesForDate } from "../db/contextSwitches";
import { generateContextLabel } from "../orchestrator/contextLabel";
import { log } from "../log";

export const contextSwitches = new Hono();

const markSchema = z.object({
  task_id: z.string().min(1).max(80),
});

contextSwitches.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = markSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "invalid_payload", issues: parsed.error.issues }, 400);
  }

  const record = recordContextSwitch(parsed.data.task_id);
  log.info("api.context_switch.recorded", {
    ctxId: record.id,
    taskId: record.task_id,
  });

  // Fire-and-forget the LLM label query. We return immediately so the UI
  // can update the counter; the label fills in asynchronously.
  generateContextLabel(record).catch((err) => {
    log.warn("api.context_switch.label_failed", {
      ctxId: record.id,
      error: String(err),
    });
  });

  return c.json({ ok: true, ...record });
});

contextSwitches.get("/", (c) => {
  const date = c.req.query("date") ?? new Date().toISOString().slice(0, 10);
  const rows = listContextSwitchesForDate(date);
  return c.json({ date, switches: rows });
});
