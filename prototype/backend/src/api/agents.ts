import { Hono } from "hono";
import { listAgents, getAgentById } from "../db/agents";

export const agents = new Hono();

agents.get("/", (c) => c.json({ agents: listAgents() }));

agents.get("/:id", (c) => {
  const row = getAgentById(c.req.param("id"));
  if (!row) return c.json({ error: "not_found" }, 404);
  return c.json(row);
});
