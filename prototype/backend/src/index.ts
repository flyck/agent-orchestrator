import { app } from "./api";

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`agent-orchestrator backend listening on http://localhost:${server.port}`);
