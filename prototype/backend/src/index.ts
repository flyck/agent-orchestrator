import { app } from "./api";
import { db } from "./db";
import { syncAgentsFromDisk } from "./agents/sync";
import { installCrashHandlers, log } from "./log";
import { bootScan as queueBootScan } from "./queue";
import { resumeQueuedTasks, startWatchdog } from "./orchestrator";

installCrashHandlers();

// Initialize DB (schema + default settings) eagerly so sync can write.
db();

queueBootScan();
startWatchdog();

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

// Re-submit any tasks left in `queued` status from a previous run. Done
// after the server is listening so anything failing here doesn't block
// the API surface from coming up.
resumeQueuedTasks().catch((e) => log.error("backend.resume_queued.failed", { error: String(e) }));
