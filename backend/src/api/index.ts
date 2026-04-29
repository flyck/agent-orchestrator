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
import { architecture } from "./architecture";
import { suggestionsForTasks, suggestionsRoot } from "./suggestions";
import { issueLinks } from "./issueLinks";

export const app = new Hono();

app.route("/api/health", health);
app.route("/api/settings", settings);
app.route("/api/agents", agents);
app.route("/api/bug-reports", bugReports);
app.route("/api/internal", internal);
app.route("/api/integrations", integrations);
// Per-task suggestions are mounted under /api/tasks so paths read as
// /api/tasks/:id/suggestions — matches the per-task subresource convention.
app.route("/api/tasks", suggestionsForTasks);
app.route("/api/tasks", issueLinks);
app.route("/api/tasks", tasks);
app.route("/api/suggestions", suggestionsRoot);
app.route("/api/cost", cost);
app.route("/api/repo", repo);
app.route("/api/nudge", nudge);
app.route("/api/activities", activities);
app.route("/api/analysis", analysis);
app.route("/api/architecture", architecture);
