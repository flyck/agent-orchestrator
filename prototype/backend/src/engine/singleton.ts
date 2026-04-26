/**
 * Lazy-initialized engine singleton. The orchestrator uses this so we only
 * pay the opencode-serve startup cost when an actual task runs (not on
 * backend boot). Default model is read from settings.
 */

import { OpenCodeAdapter } from "./opencode";
import type { ModelRef } from "./types";
import { log } from "../log";
import { readAllSettings } from "../db/settings";

let _engine: OpenCodeAdapter | null = null;
let _starting: Promise<OpenCodeAdapter> | null = null;

// gpt-5-nano choked on opencode's build-agent tool repertoire (no events
// after initial_message_sent for 90s+). Bumping the default to gpt-5-mini
// which still costs cents per task but handles tool-use reliably.
const FALLBACK_MODEL: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5-mini",
};

function defaultModelFromSettings(): ModelRef {
  // Settings stores `engine` as a string identifier ("opencode"); the actual
  // default model isn't a setting yet — we hard-code a cheap default and let
  // a per-task override take precedence in Phase 6.
  void readAllSettings(); // future hook
  return { ...FALLBACK_MODEL };
}

export async function getEngine(): Promise<OpenCodeAdapter> {
  // If we have a cached adapter, verify the underlying opencode-serve is
  // still reachable. The dev workflow (bun --hot, terminal cleanup,
  // crashes, etc) can leave the singleton holding a reference to a dead
  // child process — every subsequent fetch then errors with Bun's
  // "Unable to connect" message and the user has to restart manually.
  // Respawn on first failed health check so recovery is automatic.
  if (_engine) {
    if (await _engine.health()) return _engine;
    log.warn("engine.health.failed_respawning");
    try {
      await _engine.shutdown();
    } catch (e) {
      log.warn("engine.shutdown.failed", { error: String(e) });
    }
    _engine = null;
    _starting = null;
  }
  if (_starting) return _starting;
  log.info("engine.start.requested");
  _starting = (async () => {
    const t0 = Date.now();
    try {
      const adapter = await OpenCodeAdapter.start({
        defaultModel: defaultModelFromSettings(),
      });
      log.info("engine.start.ready", { ms: Date.now() - t0 });
      _engine = adapter;
      return adapter;
    } catch (err) {
      log.error("engine.start.failed", {
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      _starting = null;
      throw err;
    }
  })();
  return _starting;
}

export async function shutdownEngine(): Promise<void> {
  if (!_engine) return;
  log.info("engine.shutdown.requested");
  try {
    await _engine.shutdown();
    log.info("engine.shutdown.ok");
  } catch (err) {
    log.error("engine.shutdown.failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    _engine = null;
    _starting = null;
  }
}
