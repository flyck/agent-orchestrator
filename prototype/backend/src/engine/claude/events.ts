/**
 * Map Claude Code stream-json events to OpenCode-shaped EngineEvent
 * payloads. The orchestrator and scoring.ts read OpenCode-shape; the
 * Claude adapter pretends to be OpenCode at the event level.
 *
 * Native Claude events we consume:
 *   - system/init           → session.created (capture model)
 *   - stream_event/content_block_delta → message.part.updated (cumulative text)
 *   - assistant             → mid-stream usage snapshot (no event emitted)
 *   - result                → message.updated (finish:'stop', tokens, cost)
 *                            + session.idle | session.error
 *   - rate_limit_event      → ignored (logged only)
 *
 * Cumulative-text quirk: we accumulate `delta.text` chunks into a buffer
 * and emit `message.part.updated` with the full text-so-far each time —
 * matching OpenCode's emit pattern so the orchestrator's existing
 * "keep latest text per part id" logic just works.
 */

import { randomBytes } from "node:crypto";
import type { EngineEvent } from "../types";

export interface NormalizerState {
  /** Accumulated text-so-far for the current assistant turn. */
  textBuffer: string;
  /** Synthetic part id, regenerated each turn so the orchestrator's
   *  per-part-id map sees a fresh entry. */
  partId: string;
  /** Captured from system/init or message_start. */
  modelID: string;
  /** Cumulative token counts for the current turn. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

export function makeState(): NormalizerState {
  return {
    textBuffer: "",
    partId: `prt_${randomBytes(8).toString("hex")}`,
    modelID: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
  };
}

interface RawEvent {
  type?: string;
  subtype?: string;
  session_id?: string;
  model?: string;
  event?: {
    type?: string;
    message?: { model?: string; usage?: Record<string, number> };
    delta?: { type?: string; text?: string };
  };
  message?: {
    model?: string;
    usage?: Record<string, number>;
    content?: Array<{ type?: string; text?: string }>;
  };
  result?: string;
  is_error?: boolean;
  stop_reason?: string | null;
  total_cost_usd?: number;
  usage?: Record<string, number>;
  api_error_status?: string | null;
}

/** Returns 0..N normalized events for one stream-json line. */
export function normalize(
  raw: RawEvent,
  state: NormalizerState,
  sessionId: string,
): EngineEvent[] {
  const out: EngineEvent[] = [];
  const ts = Date.now();

  switch (raw.type) {
    case "system": {
      if (raw.subtype === "init") {
        if (raw.model) state.modelID = raw.model;
        out.push({ type: "session.created", ts, sessionId, raw });
      }
      break;
    }
    case "stream_event": {
      const ev = raw.event;
      if (ev?.type === "message_start" && ev.message?.model) {
        state.modelID = ev.message.model;
      }
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        state.textBuffer += ev.delta.text ?? "";
        out.push({
          type: "message.part.updated",
          ts,
          sessionId,
          raw: {
            properties: {
              part: {
                id: state.partId,
                type: "text",
                text: state.textBuffer,
                sessionID: sessionId,
              },
            },
          },
        });
      }
      break;
    }
    case "assistant": {
      const u = raw.message?.usage;
      if (u) {
        if (typeof u.input_tokens === "number") state.inputTokens = u.input_tokens;
        if (typeof u.output_tokens === "number") state.outputTokens = u.output_tokens;
        if (typeof u.cache_read_input_tokens === "number")
          state.cacheReadTokens = u.cache_read_input_tokens;
        if (typeof u.cache_creation_input_tokens === "number")
          state.cacheCreateTokens = u.cache_creation_input_tokens;
      }
      if (raw.message?.model) state.modelID = raw.message.model;
      // The assistant event also carries the final text under message.content
      // — but the deltas already covered it. Skip emitting here to avoid
      // double-recording; the result event below closes the turn.
      break;
    }
    case "result": {
      const isErr = raw.is_error === true;
      const finalUsage = raw.usage ?? {};
      if (typeof finalUsage.input_tokens === "number")
        state.inputTokens = finalUsage.input_tokens;
      if (typeof finalUsage.output_tokens === "number")
        state.outputTokens = finalUsage.output_tokens;
      if (typeof finalUsage.cache_read_input_tokens === "number")
        state.cacheReadTokens = finalUsage.cache_read_input_tokens;
      if (typeof finalUsage.cache_creation_input_tokens === "number")
        state.cacheCreateTokens = finalUsage.cache_creation_input_tokens;
      const cost = typeof raw.total_cost_usd === "number" ? raw.total_cost_usd : 0;
      // Match opencode's "input" semantics: total tokens the model saw this
      // turn, including cached context. Surfaces as ctx-window usage in the UI.
      const inputTotal = state.inputTokens + state.cacheReadTokens + state.cacheCreateTokens;
      out.push({
        type: "message.updated",
        ts,
        sessionId,
        raw: {
          properties: {
            info: {
              role: "assistant",
              finish: isErr ? undefined : raw.stop_reason ?? "stop",
              error: isErr
                ? { message: raw.api_error_status ?? raw.result ?? "claude error", data: raw }
                : undefined,
              cost,
              tokens: { input: inputTotal, output: state.outputTokens },
              modelID: state.modelID || "claude",
              providerID: "anthropic",
              time: { completed: ts },
              sessionID: sessionId,
            },
          },
        },
      });
      out.push({
        type: isErr ? "session.error" : "session.idle",
        ts,
        sessionId,
        raw,
      });
      // Reset turn-scoped state. The model id stays — same model for the next turn.
      state.textBuffer = "";
      state.partId = `prt_${randomBytes(8).toString("hex")}`;
      state.inputTokens = 0;
      state.outputTokens = 0;
      state.cacheReadTokens = 0;
      state.cacheCreateTokens = 0;
      break;
    }
    default:
      break;
  }

  return out;
}
