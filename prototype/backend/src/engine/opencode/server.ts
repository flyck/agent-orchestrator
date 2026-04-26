/**
 * Manage a child `opencode serve` process. Spawns it with a generated
 * Basic-auth password, polls /global/health until ready, and provides
 * a clean shutdown.
 */

import { randomBytes } from "node:crypto";
import { OpenCodeClient } from "./client";

export interface OpenCodeServerOptions {
  /** Binary on PATH or absolute path. Default: "opencode". */
  bin?: string;
  /** Hostname to bind. Default: "127.0.0.1". */
  hostname?: string;
  /** Port to bind. Default: 0 (we don't actually use 0 — see below). */
  port?: number;
  /** Max ms to wait for /global/health. Default: 10000. */
  readyTimeoutMs?: number;
  /** Inherit additional env vars (e.g. GITHUB_TOKEN). Default: process.env. */
  env?: Record<string, string | undefined>;
  /** Pipe child stdout/stderr to console. Default: false. */
  verbose?: boolean;
}

export interface OpenCodeServerHandle {
  client: OpenCodeClient;
  baseUrl: string;
  port: number;
  pid: number;
  password: string;
  shutdown: () => Promise<void>;
}

function pickPort(): number {
  // opencode `--port 0` is OS-assigned, but we'd then need to parse
  // it out of stdout/stderr (no programmatic emit). Easier to pick
  // a high random port and retry on EADDRINUSE.
  return 14000 + Math.floor(Math.random() * 4000);
}

export async function startOpenCodeServer(
  opts: OpenCodeServerOptions = {},
): Promise<OpenCodeServerHandle> {
  const bin = opts.bin ?? "opencode";
  const hostname = opts.hostname ?? "127.0.0.1";
  const port = opts.port ?? pickPort();
  const password = randomBytes(16).toString("hex");
  const readyTimeoutMs = opts.readyTimeoutMs ?? 10_000;

  const proc = Bun.spawn({
    cmd: [bin, "serve", "--port", String(port), "--hostname", hostname],
    env: {
      ...(opts.env ?? process.env),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdin: "ignore",
    stdout: opts.verbose ? "inherit" : "pipe",
    stderr: opts.verbose ? "inherit" : "pipe",
  });

  const baseUrl = `http://${hostname}:${port}`;
  const client = new OpenCodeClient({ baseUrl, password });

  // Poll health until ready or timeout.
  const start = Date.now();
  let lastErr: unknown = null;
  while (Date.now() - start < readyTimeoutMs) {
    if (proc.exitCode !== null) {
      throw new Error(`opencode serve exited early (code ${proc.exitCode})`);
    }
    try {
      const h = await client.health();
      if (h.healthy) break;
    } catch (e) {
      lastErr = e;
      await Bun.sleep(150);
    }
  }
  if (Date.now() - start >= readyTimeoutMs) {
    proc.kill();
    throw new Error(
      `opencode serve did not become healthy within ${readyTimeoutMs}ms: ${String(lastErr)}`,
    );
  }

  let shut = false;
  const shutdown = async (): Promise<void> => {
    if (shut) return;
    shut = true;
    proc.kill();
    await proc.exited;
  };

  return {
    client,
    baseUrl,
    port,
    pid: proc.pid,
    password,
    shutdown,
  };
}
