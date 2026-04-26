import { Hono } from "hono";
import { health } from "./health";

export const app = new Hono();

app.route("/api/health", health);
