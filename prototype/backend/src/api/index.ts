import { Hono } from "hono";
import { health } from "./health";
import { settings } from "./settings";
import { agents } from "./agents";

export const app = new Hono();

app.route("/api/health", health);
app.route("/api/settings", settings);
app.route("/api/agents", agents);
