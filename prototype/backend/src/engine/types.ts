/**
 * Engine adapter contract — agnostic of which agent runtime is behind it.
 *
 * v1 has only OpenCodeAdapter. The interfaces stay narrow so a second
 * adapter (aider, opencode-fork, etc.) can be added without changing the
 * orchestrator or the API layer.
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
  /** Stop the agent's current turn. Idempotent. */
  cancel(): Promise<void>;
  /** End the session, free resources, and stop event delivery. Idempotent. */
  close(): Promise<void>;
}

export interface EngineAdapter {
  /** Open a new session against the engine. */
  openSession(spec: OpenSessionSpec): Promise<EngineSession>;
  /** Engine-level health probe — returns true if the engine is reachable. */
  health(): Promise<boolean>;
  /** Shut down the adapter (and the engine process if it manages one). */
  shutdown(): Promise<void>;
}
