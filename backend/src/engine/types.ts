/**
 * Engine adapter contract — agnostic of which agent runtime is behind it.
 *
 * Two adapters live under here today: `opencode/` (HTTP server + SSE) and
 * `claude/` (per-session subprocess driving `claude -p` in stream-json
 * mode). The orchestrator holds an `EngineAdapter` reference and knows
 * nothing about the underlying transport.
 *
 * Event-shape note: the contract is "OpenCode-shaped events". Adapters
 * MUST emit `message.part.updated`, `message.updated`, `session.idle`,
 * and `session.error` with the same `properties` payload OpenCode does
 * (`info.role`, `info.finish`, `info.tokens`, `info.cost`, etc). The
 * Claude adapter assembles these from its native NDJSON stream. This is
 * load-bearing for `orchestrator/index.ts` and `orchestrator/scoring.ts`
 * — see `docs/18-claude-code-engine.md` for the migration plan.
 */

export type EngineEventType =
  | "session.created"
  | "session.updated"
  | "session.status"
  | "session.idle"
  | "session.diff"
  | "session.error"
  | "message.updated"
  | "message.part.updated"
  | "text"
  | "busy"
  | "idle"
  | "server.connected"
  | "server.heartbeat"
  | "unknown";

export interface EngineEvent {
  /** Event type, normalized to the union above (passed through unmodified for unknown). */
  type: EngineEventType | string;
  /** Wall-clock time the adapter saw the event. */
  ts: number;
  /** External (engine) session id this event belongs to, when applicable. */
  sessionId: string | null;
  /** Raw payload as received from the engine — for replay and debug. */
  raw: unknown;
}

/**
 * Per-engine model identifier. Semantics differ:
 *   - opencode: `providerID` = "openai" / "anthropic" / "github-copilot",
 *               `modelID`   = the provider's model id (e.g. "gpt-5-mini").
 *   - claude:   `providerID` = "anthropic" (informational; not sent to CLI),
 *               `modelID`   = either an alias ("opus" / "sonnet" / "haiku")
 *                             or a full id ("claude-opus-4-7").
 * The adapter is responsible for translating to its underlying call.
 */
export interface ModelRef {
  providerID: string;
  modelID: string;
}

export interface OpenSessionSpec {
  /** Title shown in the engine's session list (and useful for debug). */
  title?: string;
  /** Working directory for the session — typically a worktree path. */
  cwd?: string;
  /** Model to use. If omitted, the engine's default. */
  model?: ModelRef;
  /** Optional restricted tool set (engine-specific names). */
  tools?: string[];
}

export interface SendMessageOptions {
  /** Override the system prompt for this turn. Engine-specific semantics. */
  system?: string;
  /** Override the model for this turn. */
  model?: ModelRef;
  /** True if this message came from the user (vs the orchestrator). Persisted in `messages.sender`. */
  fromUser?: boolean;
}

export interface EngineSession {
  /** External (engine) session id. */
  id: string;
  /** Send a text message into the session; resolves when accepted (not when reply is complete). */
  send(text: string, opts?: SendMessageOptions): Promise<void>;
  /** Async iterable of events scoped to THIS session. Iteration ends on close(). */
  events: AsyncIterable<EngineEvent>;
  /** Stop the agent's current turn. Idempotent.
   *  OpenCode: graceful — preserves partial output.
   *  Claude:   non-graceful — SIGTERM/SIGKILL the subprocess. */
  cancel(): Promise<void>;
  /** End the session, free resources, and stop event delivery. Idempotent. */
  close(): Promise<void>;
  /**
   * Respond to a permission gate raised mid-turn. Engines that don't
   * negotiate per-tool gates (Claude — runs with bypassPermissions for
   * orchestrator sessions) leave this undefined; the orchestrator uses
   * optional chaining when it sees a `permission.asked` event.
   */
  respondToPermission?(
    permissionId: string,
    response: "once" | "always" | "reject",
  ): Promise<void>;
}

export interface EngineAdapter {
  /** Stable identifier used for logging and per-task routing. */
  readonly engineId: "opencode" | "claude";
  /** Open a new session against the engine. */
  openSession(spec: OpenSessionSpec): Promise<EngineSession>;
  /** Engine-level health probe — returns true if the engine is reachable. */
  health(): Promise<boolean>;
  /**
   * Backfill: persisted messages for a session (live or completed).
   * Used by GET /api/tasks/:id/transcript and the watchdog's
   * terminal-state recovery probe. Returns engine-native message records;
   * the consumer treats the shape as `{info:{role,finish,error,cost,tokens,…}, parts}[]`
   * (OpenCode-shape — Claude adapter constructs equivalents from JSONL).
   */
  getTranscript(sessionId: string, limit?: number): Promise<unknown[]>;
  /** Shut down the adapter (and the engine process if it manages one). */
  shutdown(): Promise<void>;
}
