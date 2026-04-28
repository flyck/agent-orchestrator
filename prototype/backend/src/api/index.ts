import { Hono } from "hono";
import { health } from "./health";
import { settings } from "./settings";
import { agents } from "./agents";
import { bugReports } from "./bug-reports";
import { internal } from "./internal";
import { integrations } from "./integrations";
import { tasks } from "./tasks";
import { cost } from "./cost";
import { repo } from "./repo";
import { nudge } from "./nudge";
import { activities } from "./activities";
import { analysis } from "./analysis";

export const app = new Hono();

app.route("/api/health", health);
app.route("/api/settings", settings);
app.route("/api/agents", agents);
app.route("/api/bug-reports", bugReports);
app.route("/api/internal", internal);
app.route("/api/integrations", integrations);
app.route("/api/tasks", tasks);
app.route("/api/cost", cost);
app.route("/api/repo", repo);
app.route("/api/nudge", nudge);
app.route("/api/activities", activities);
app.route("/api/analysis", analysis);
