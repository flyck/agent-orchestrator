import { Hono } from "hono";
import { health } from "./health";
import { settings } from "./settings";

export const app = new Hono();

app.route("/api/health", health);
app.route("/api/settings", settings);
