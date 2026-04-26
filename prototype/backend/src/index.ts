import { app } from "./api";
import { db } from "./db";
import { syncAgentsFromDisk } from "./agents/sync";
import { installCrashHandlers, log } from "./log";
import { bootScan as queueBootScan } from "./queue";

installCrashHandlers();

// Initialize DB (schema + default settings) eagerly so sync can write.
db();

queueBootScan();

const sync = syncAgentsFromDisk();
log.info("agents.sync", {
  scanned: sync.scanned,
  upserted: sync.upserted,
  errors: sync.errors.length,
});
for (const e of sync.errors) log.error("agents.sync.error", { path: e.path, message: e.message });

const port = Number(process.env.PORT ?? 3000);
const server = Bun.serve({
  port,
  fetch: app.fetch,
});

log.info("backend.listening", { url: `http://localhost:${server.port}` });
