/**
 * Minimal JSON-lines logger that writes to ./data/logs/YYYY-MM-DD.log.
 * Each line is one event: { ts, level, message, meta? }.
 *
 * Intended consumer: the orchestrator-debugger background agent, which
 * reads recent log lines via GET /api/internal/logs and surfaces issues.
 * Also useful for human inspection.
 */

import { mkdirSync, appendFileSync, readdirSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";

const LOG_DIR = join(process.cwd(), "data", "logs");

function ensureDir() {
  mkdirSync(LOG_DIR, { recursive: true });
}

function todayPath(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return join(LOG_DIR, `${yyyy}-${mm}-${dd}.log`);
}

export function record(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  ensureDir();
  const line = JSON.stringify({ ts: Date.now(), level, message, ...(meta && { meta }) }) + "\n";
  try {
    appendFileSync(todayPath(), line);
  } catch {
    // logging must never throw on the caller; fall through silently
  }
  // Mirror to console so dev runs still show output.
  const prefix = level === "error" ? "[err]" : level === "warn" ? "[warn]" : "[info]";
  if (level === "error") console.error(prefix, message, meta ?? "");
  else if (level === "warn") console.warn(prefix, message, meta ?? "");
  else console.log(prefix, message, meta ?? "");
}

export const log = {
  info: (m: string, meta?: Record<string, unknown>) => record("info", m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => record("warn", m, meta),
  error: (m: string, meta?: Record<string, unknown>) => record("error", m, meta),
};

/** Hook fatal errors into the file log so the debugger agent can find them. */
export function installCrashHandlers() {
  process.on("uncaughtException", (err) => {
    record("error", "uncaughtException", { name: err.name, message: err.message, stack: err.stack });
  });
  process.on("unhandledRejection", (reason) => {
    record("error", "unhandledRejection", { reason: String(reason) });
  });
}

/** List log filenames, newest first. */
export function listLogFiles(): string[] {
  ensureDir();
  return readdirSync(LOG_DIR)
    .filter((f) => f.endsWith(".log"))
    .map((f) => ({ name: f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
    .map((f) => f.name);
}

/** Read the tail of today's log (or a specific date). */
export function readLogTail(opts: { date?: string; limit?: number; sinceMs?: number } = {}): unknown[] {
  ensureDir();
  const file = opts.date ? join(LOG_DIR, `${opts.date}.log`) : todayPath();
  let raw = "";
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n").filter(Boolean);
  const parsed: { ts: number; level: string; message: string; meta?: unknown }[] = [];
  for (const l of lines) {
    try {
      parsed.push(JSON.parse(l));
    } catch {
      /* skip bad line */
    }
  }
  let filtered = parsed;
  if (opts.sinceMs !== undefined) filtered = filtered.filter((e) => e.ts >= opts.sinceMs!);
  const limit = opts.limit ?? 500;
  return filtered.slice(-limit);
}
