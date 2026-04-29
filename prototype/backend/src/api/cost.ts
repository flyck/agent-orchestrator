import { Hono } from "hono";
import { readByModel, readCostSummary, readTopTasksByCost } from "../db/usageEvents";

export const cost = new Hono();

function resolveDays(range: string): number {
  const r = range.toLowerCase();
  const n =
    r === "today" || r === "1d"
      ? 1
      : r === "7d"
        ? 7
        : r === "30d"
          ? 30
          : Number(r.replace(/d$/, "")) || 7;
  return Math.max(1, Math.min(90, n));
}

cost.get("/summary", (c) => {
  return c.json(readCostSummary(resolveDays(c.req.query("range") ?? "7d")));
});

cost.get("/by-model", (c) => {
  return c.json({ by_model: readByModel(resolveDays(c.req.query("range") ?? "7d")) });
});

cost.get("/top-tasks", (c) => {
  const days = resolveDays(c.req.query("range") ?? "7d");
  const limit = Math.max(1, Math.min(50, Number(c.req.query("limit") ?? 10)));
  return c.json({ tasks: readTopTasksByCost(days, limit) });
});
