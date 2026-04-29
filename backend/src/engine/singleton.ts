/**
 * Lazy-initialized engine singleton. The orchestrator uses this so we
 * only pay engine startup cost when an actual task runs. The active
 * engine is selected from `settings.engine` ("opencode" | "claude").
 * Switching engines via settings respawns on next health check.
 */

import { OpenCodeAdapter } from "./opencode";
import { ClaudeCodeAdapter } from "./claude";
import type { EngineAdapter, ModelRef } from "./types";
import { log } from "../log";
import { readAllSettings } from "../db/settings";

let _engine: EngineAdapter | null = null;
let _engineId: "opencode" | "claude" | null = null;
let _starting: Promise<EngineAdapter> | null = null;

// gpt-5-nano choked on opencode's build-agent tool repertoire (no events
// after initial_message_sent for 90s+). Bumping the default to gpt-5-mini
// which still costs cents per task but handles tool-use reliably.
const FALLBACK_MODEL: ModelRef = {
  providerID: "openai",
  modelID: "gpt-5-mini",
};

function selectedEngineId(): "opencode" | "claude" {
  const s = readAllSettings();
  const raw = String(s.engine ?? "opencode").toLowerCase();
  return raw === "claude" ? "claude" : "opencode";
}

function defaultModelFromSettings(engineId: "opencode" | "claude"): ModelRef {
  // Per-engine defaults: opencode runs through OpenAI by default;
  // Claude doesn't need a real provider/model split — the adapter
  // passes modelID through as the CLI's --model alias.
  if (engineId === "claude") {
    return { providerID: "anthropic", modelID: "sonnet" };
  }
  return { ...FALLBACK_MODEL };
}

async function startAdapter(engineId: "opencode" | "claude"): Promise<EngineAdapter> {
  if (engineId === "claude") {
    return ClaudeCodeAdapter.start({
      defaultModel: defaultModelFromSettings("claude"),
    });
  }
  return OpenCodeAdapter.start({
    defaultModel: defaultModelFromSettings("opencode"),
  });
}

export async function getEngine(): Promise<EngineAdapter> {
  const wantId = selectedEngineId();

  // Respawn whenever:
  //   - the cached engine fails health
  //   - the user has flipped settings.engine to a different id
  // The dev workflow (bun --hot, terminal cleanup, crashes) can leave
  // the singleton holding a reference to a dead opencode-serve process,
  // and we want flipping engines in settings to take effect on the next
  // task without a backend restart.
  if (_engine) {
    if (_engineId === wantId && (await _engine.health())) return _engine;
    log.warn("engine.replace", {
      reason: _engineId !== wantId ? "settings.engine_changed" : "health.failed",
      from: _engineId,
      to: wantId,
    });
    try {
      await _engine.shutdown();
    } catch (e) {
      log.warn("engine.shutdown.failed", { error: String(e) });
    }
    _engine = null;
    _engineId = null;
    _starting = null;
  }
  if (_starting) return _starting;
  log.info("engine.start.requested", { engineId: wantId });
  _starting = (async () => {
    const t0 = Date.now();
    try {
      const adapter = await startAdapter(wantId);
      log.info("engine.start.ready", { engineId: wantId, ms: Date.now() - t0 });
      _engine = adapter;
      _engineId = wantId;
      return adapter;
    } catch (err) {
      log.error("engine.start.failed", {
        engineId: wantId,
        ms: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      });
      _starting = null;
      throw err;
    }
  })();
  return _starting;
}

/**
 * Read the cached engine without starting one. Returns null when the
 * engine has never been requested. Used by the /api/health/engine probe
 * so cold = explicitly cold (lazy init not yet triggered) rather than
 * a side-effect of the probe itself.
 */
export function peekEngine(): EngineAdapter | null {
  return _engine;
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
    _engineId = null;
    _starting = null;
  }
}
