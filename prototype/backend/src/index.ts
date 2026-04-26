import { app } from "./api";
import { db } from "./db";
import { syncAgentsFromDisk } from "./agents/sync";

// Initialize DB (schema + default settings) eagerly so sync can write.
db();

const sync = syncAgentsFromDisk();
console.log(
  `agents: scanned ${sync.scanned}, upserted ${sync.upserted}, errors ${sync.errors.length}`,
);
for (const e of sync.errors) console.error(`  ${e.path}: ${e.message}`);

const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`agent-orchestrator backend listening on http://localhost:${server.port}`);
