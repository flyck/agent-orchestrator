import { Hono } from "hono";
import { readCostSummary } from "../db/usageEvents";

export const cost = new Hono();

cost.get("/summary", (c) => {
  const range = (c.req.query("range") ?? "7d").toLowerCase();
  const days =
    range === "today" || range === "1d"
      ? 1
      : range === "7d"
        ? 7
        : range === "30d"
          ? 30
          : Number(range.replace(/d$/, "")) || 7;
  return c.json(readCostSummary(Math.max(1, Math.min(90, days))));
});
