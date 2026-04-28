/**
 * Shared SSE consumer for the opencode `/event` stream. We open one SSE
 * connection per opencode-server process and demultiplex by sessionID into
 * per-session EventQueues.
 *
 * Event types we observed during the Phase 0 smoke:
 *   server.connected, server.heartbeat, idle, busy
 *   session.{created,updated,status,idle,diff,error}
 *   message.{updated,part.updated}, text
 * All session-scoped events carry sessionID either at properties.sessionID
 * or properties.info.sessionID (the latter for message.updated).
 */

import type { EngineEvent } from "../types";
import type { OpenCodeClient } from "./client";
import { EventQueue } from "../eventQueue";

function extractSessionId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const props = (payload as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;
  const direct = (props as { sessionID?: string }).sessionID;
  if (typeof direct === "string") return direct;
  const info = (props as { info?: unknown }).info;
  if (info && typeof info === "object") {
    const sid = (info as { sessionID?: string }).sessionID;
    if (typeof sid === "string") return sid;
  }
  // Some part-update events nest under part.sessionID
  const part = (props as { part?: unknown }).part;
  if (part && typeof part === "object") {
    const sid = (part as { sessionID?: string }).sessionID;
    if (typeof sid === "string") return sid;
  }
  return null;
}

export class EventBus {
  private queues = new Map<string, EventQueue<EngineEvent>>();
  private connectedPromise: Promise<void> | null = null;
  private aborted = false;
  private reader: { cancel: () => Promise<void> } | null = null;
  /** Last-seen sessionID for events that don't carry one — best-effort. */
  private onError?: (err: unknown) => void;
  /** ms since epoch of the most recent *anything* received on the SSE
   *  stream (event or heartbeat). Drives the stall detector. */
  private lastReceivedAt = 0;
  /** Force-reconnect when the SSE stream goes silent for this long while
   *  at least one queue is subscribed. opencode has been observed to
   *  silently stop pushing without closing the connection — `reader.read()`
   *  then blocks forever and the run wedges. 25s gives normal turns
   *  plenty of room while still recovering before the orchestrator's
   *  60s watchdog kicks in. */
  private static readonly STALL_TIMEOUT_MS = 25_000;
  private stallTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly client: OpenCodeClient, opts: { onError?: (e: unknown) => void } = {}) {
    this.onError = opts.onError;
  }

  /** Returns an EventQueue scoped to one external session id. */
  subscribe(sessionId: string): EventQueue<EngineEvent> {
    let q = this.queues.get(sessionId);
    if (!q) {
      q = new EventQueue();
      this.queues.set(sessionId, q);
    }
    if (!this.connectedPromise) this.connectedPromise = this.run();
    return q;
  }

  unsubscribe(sessionId: string): void {
    const q = this.queues.get(sessionId);
    if (!q) return;
    q.close();
    this.queues.delete(sessionId);
  }

  async shutdown(): Promise<void> {
    this.aborted = true;
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
    try {
      await this.reader?.cancel();
    } catch {
      /* ignore */
    }
    for (const q of this.queues.values()) q.close();
    this.queues.clear();
  }

  /**
   * Cancel the current reader so the run-loop reconnects. Used by the
   * stall detector — opencode sometimes stops streaming without closing
   * the connection, leaving reader.read() blocked forever.
   */
  private async forceReconnect(reason: string): Promise<void> {
    this.onError?.(new Error(`event-bus stall: ${reason}`));
    try {
      await this.reader?.cancel();
    } catch {
      /* the reader is already gone or canceling errored — either is fine */
    }
  }

  private async run(): Promise<void> {
    // Stall detector: if there's at least one active subscription but no
    // bytes have arrived from opencode for STALL_TIMEOUT_MS, cancel the
    // reader so we reconnect. opencode has been observed to silently
    // stop pushing without closing the underlying HTTP connection — in
    // that case reader.read() blocks forever and the entire orchestrator
    // run wedges. We start the timer once and let it run for the bus
    // lifetime; shutdown() clears it.
    if (!this.stallTimer) {
      this.stallTimer = setInterval(() => {
        if (this.aborted) return;
        if (this.queues.size === 0) return; // idle bus, nothing to recover
        const silentMs = Date.now() - this.lastReceivedAt;
        if (silentMs > EventBus.STALL_TIMEOUT_MS) {
          // Reset so we don't fire repeatedly while reconnecting.
          this.lastReceivedAt = Date.now();
          void this.forceReconnect(`silent for ${silentMs}ms`);
        }
      }, 5_000);
    }

    // Reconnect-loop: if the SSE stream drops, wait briefly and reopen.
    // We do NOT close active queues across reconnects — sessions stay alive
    // and start receiving events again on the new connection. Without this,
    // any idle period long enough for opencode (or the network) to drop the
    // SSE would silently close every active session's iterator.
    let attempt = 0;
    while (!this.aborted) {
      try {
        const res = await this.client.openEventStream();
        const reader = res.body!.getReader();
        this.reader = reader;
        this.lastReceivedAt = Date.now(); // fresh connection — reset stall clock
        const decoder = new TextDecoder();
        let buf = "";
        attempt = 0; // reset backoff on a successful connect
        while (!this.aborted) {
          const { value, done } = await reader.read();
          if (done) break; // SSE closed cleanly — will reconnect below
          this.lastReceivedAt = Date.now();
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const json = line.slice(5).trim();
            if (!json) continue;
            let parsed: unknown;
            try {
              parsed = JSON.parse(json);
            } catch (err) {
              this.onError?.(err);
              continue;
            }
            const type = (parsed as { type?: string }).type ?? "unknown";
            const sid = extractSessionId(parsed);
            const event: EngineEvent = {
              type,
              ts: Date.now(),
              sessionId: sid,
              raw: parsed,
            };
            if (sid) {
              const q = this.queues.get(sid);
              if (q) q.push(event);
            }
          }
        }
      } catch (err) {
        if (!this.aborted) this.onError?.(err);
      }
      if (this.aborted) break;
      // Backoff before reconnecting: 250ms, 500ms, 1s, 2s, capped at 5s.
      const delay = Math.min(5000, 250 * 2 ** Math.min(attempt, 5));
      attempt++;
      await new Promise((r) => setTimeout(r, delay));
    }

    // Only on explicit shutdown: close all queues so iterators terminate.
    for (const q of this.queues.values()) q.close();
    this.queues.clear();
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = null;
    }
  }
}
