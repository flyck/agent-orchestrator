/**
 * Claude Code engine adapter. No long-lived server process — each
 * session is its own subprocess driving `claude -p` in stream-json mode.
 * Subscription auth lives in the user's local Claude install
 * (~/.claude/.credentials.json or CLAUDE_CODE_OAUTH_TOKEN env).
 */

import type {
  EngineAdapter,
  EngineSession,
  ModelRef,
  OpenSessionSpec,
} from "../types";
import { probeClaudeBinary, type ClaudeBinaryInfo } from "./binary";
import { createClaudeSession } from "./session";
import { readTranscript } from "./transcript";

export interface ClaudeCodeAdapterOptions {
  defaultModel: ModelRef;
  /** Override the binary path. Defaults to env CLAUDE_BIN or "claude" on PATH. */
  bin?: string;
}

export class ClaudeCodeAdapter implements EngineAdapter {
  readonly engineId = "claude" as const;

  private constructor(
    private readonly binary: ClaudeBinaryInfo,
    private readonly defaultModel: ModelRef,
  ) {}

  static async start(opts: ClaudeCodeAdapterOptions): Promise<ClaudeCodeAdapter> {
    const binary = probeClaudeBinary(opts.bin);
    return new ClaudeCodeAdapter(binary, opts.defaultModel);
  }

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    const cwd = spec.cwd ?? process.cwd();
    return createClaudeSession({
      title: spec.title,
      defaultSystem: "",
      defaultModel: spec.model ?? this.defaultModel,
      cwd,
      bin: this.binary.bin,
    });
  }

  async health(): Promise<boolean> {
    // The binary probe ran at start(); if it succeeded we trust the install.
    // No long-lived server to ping.
    return Boolean(this.binary.version);
  }

  async getTranscript(sessionId: string, limit = 50): Promise<unknown[]> {
    return readTranscript(sessionId, limit);
  }

  async shutdown(): Promise<void> {
    // No shared state to tear down — each session manages its own subprocess.
  }
}
