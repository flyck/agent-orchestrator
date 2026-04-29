/**
 * One Claude Code session = one `claude -p --input-format=stream-json
 * --output-format=stream-json` subprocess. Stdin stays open across turns
 * so the orchestrator can send follow-ups (review send-backs, multi-phase
 * pipelines that share a session id, etc).
 *
 * Cancel = SIGTERM then SIGKILL. Claude Code has no graceful in-flight
 * abort (anthropics/claude-code#3455) so partial output is lost.
 */

import { randomUUID } from "node:crypto";
import type {
  EngineEvent,
  EngineSession,
  ModelRef,
  SendMessageOptions,
} from "../types";
import { EventQueue } from "../eventQueue";
import { makeState, normalize, type NormalizerState } from "./events";

export interface ClaudeSessionInternal {
  id: string;
  defaultSystem: string;
  defaultModel: ModelRef;
  cwd: string;
  bin: string;
}

type Proc = ReturnType<typeof Bun.spawn>;

export class ClaudeSession implements EngineSession {
  private readonly queue = new EventQueue<EngineEvent>();
  private readonly state: NormalizerState = makeState();
  private proc: Proc | null = null;
  private stdoutBuf = "";
  private closed = false;
  private readonly encoder = new TextEncoder();

  constructor(private readonly internal: ClaudeSessionInternal) {}

  get id(): string {
    return this.internal.id;
  }

  get events(): AsyncIterable<EngineEvent> {
    return this.queue;
  }

  /** Spawn the subprocess and start the stdout reader. Idempotent. */
  start(): void {
    if (this.proc) return;
    const args = [
      "-p",
      "--input-format=stream-json",
      "--output-format=stream-json",
      "--include-partial-messages",
      "--verbose",
      "--session-id",
      this.internal.id,
      "--permission-mode",
      "bypassPermissions",
      "--model",
      this.internal.defaultModel.modelID,
    ];
    if (this.internal.defaultSystem) {
      args.push("--append-system-prompt", this.internal.defaultSystem);
    }
    this.proc = Bun.spawn({
      cmd: [this.internal.bin, ...args],
      cwd: this.internal.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        // CLAUDE_CODE_OAUTH_TOKEN is honored if the user generated a
        // long-lived token via `claude setup-token` — recommended for
        // daemon-mode setups to avoid keychain-refresh races under load
        // (anthropics/claude-code#25609).
      },
    });
    void this.pumpStdout();
    void this.pumpStderr();
    void this.watchExit();
  }

  async send(text: string, _opts: SendMessageOptions = {}): Promise<void> {
    if (this.closed) throw new Error("session is closed");
    if (!this.proc) this.start();
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    });
    const sink = this.proc!.stdin;
    if (!sink || typeof sink === "number") {
      throw new Error("claude stdin not writable");
    }
    sink.write(this.encoder.encode(line + "\n"));
    sink.flush();
  }

  async cancel(): Promise<void> {
    if (this.closed || !this.proc) return;
    // SIGTERM first; if the child doesn't exit in 2s, SIGKILL. Claude has
    // no graceful abort — partial output is whatever already streamed.
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* may already be exiting */
    }
    const start = Date.now();
    while (this.proc.exitCode === null && Date.now() - start < 2_000) {
      await Bun.sleep(50);
    }
    if (this.proc.exitCode === null) {
      try {
        this.proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      const sink = this.proc?.stdin;
      if (sink && typeof sink !== "number") sink.end();
    } catch {
      /* idempotent */
    }
    // Give the process a beat to flush its final result event before we
    // tear down. If it doesn't exit on stdin-close (it should), kill.
    if (this.proc) {
      const start = Date.now();
      while (this.proc.exitCode === null && Date.now() - start < 1_000) {
        await Bun.sleep(50);
      }
      if (this.proc.exitCode === null) {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
    }
    this.queue.close();
  }

  private async pumpStdout(): Promise<void> {
    if (!this.proc) return;
    const stream = this.proc.stdout;
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        this.stdoutBuf += decoder.decode(value, { stream: true });
        const lines = this.stdoutBuf.split("\n");
        this.stdoutBuf = lines.pop() ?? "";
        for (const ln of lines) {
          if (!ln.trim()) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(ln);
          } catch {
            // The CLI sometimes prefixes with non-JSON warnings on first
            // boot; ignore lines we can't parse.
            continue;
          }
          for (const ev of normalize(
            parsed as Parameters<typeof normalize>[0],
            this.state,
            this.internal.id,
          )) {
            this.queue.push(ev);
          }
        }
      }
    } catch {
      /* reader cancelled or process gone */
    }
  }

  private async pumpStderr(): Promise<void> {
    if (!this.proc) return;
    const stream = this.proc.stderr;
    if (!stream || typeof stream === "number") return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const ln of lines) {
          if (ln.trim()) console.warn(`[claude:${this.internal.id.slice(0, 8)}] ${ln}`);
        }
      }
    } catch {
      /* ignore */
    }
  }

  private async watchExit(): Promise<void> {
    if (!this.proc) return;
    const code = await this.proc.exited;
    if (!this.closed) {
      // Process died on its own. If we haven't surfaced a session.idle or
      // session.error already, push a synthetic error so the orchestrator's
      // pump unblocks.
      this.queue.push({
        type: "session.error",
        ts: Date.now(),
        sessionId: this.internal.id,
        raw: { reason: "subprocess_exited", code },
      });
      this.queue.close();
    }
  }
}

export interface CreateClaudeSessionSpec {
  title?: string;
  defaultSystem: string;
  defaultModel: ModelRef;
  cwd: string;
  bin: string;
}

export function createClaudeSession(spec: CreateClaudeSessionSpec): ClaudeSession {
  const id = randomUUID();
  const session = new ClaudeSession({
    id,
    defaultSystem: spec.defaultSystem,
    defaultModel: spec.defaultModel,
    cwd: spec.cwd,
    bin: spec.bin,
  });
  // Lazy-start: subprocess is spawned on first send(). Saves the cost of
  // spawning processes for sessions that get opened then immediately
  // closed (e.g. health probes, mistakes).
  return session;
}
