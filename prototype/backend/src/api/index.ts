import { Hono } from "hono";
import { health } from "./health";
import { settings } from "./settings";
import { agents } from "./agents";
import { bugReports } from "./bug-reports";
import { internal } from "./internal";
import { integrations } from "./integrations";

export const app = new Hono();

app.route("/api/health", health);
app.route("/api/settings", settings);
app.route("/api/agents", agents);
app.route("/api/bug-reports", bugReports);
app.route("/api/internal", internal);
app.route("/api/integrations", integrations);
