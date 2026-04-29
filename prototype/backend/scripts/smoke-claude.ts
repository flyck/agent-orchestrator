/**
 * End-to-end smoke for the Claude Code adapter.
 *
 * Spawns one `claude -p` subprocess, sends a tiny prompt, streams
 * normalized events until session.idle, prints the reply + tokens + cost,
 * then closes cleanly.
 *
 * Run: `bun scripts/smoke-claude.ts`
 *
 * Requires: `claude` on PATH (or CLAUDE_BIN set) AND a logged-in
 * subscription (`claude auth status` should show signed in). Default model
 * is "haiku" (cheapest); override with SMOKE_MODEL=opus|sonnet|haiku.
 */

import { ClaudeCodeAdapter } from "../src/engine/claude";

const modelID = process.env.SMOKE_MODEL ?? "haiku";

const t0 = Date.now();
console.log(`probing claude binary…`);
const adapter = await ClaudeCodeAdapter.start({
  defaultModel: { providerID: "anthropic", modelID },
});
console.log(`ok · model=${modelID}`);

console.log("opening session…");
const session = await adapter.openSession({ title: "smoke-test" });
console.log(`session ${session.id}`);

console.log("sending: 'reply with exactly: hi'");
const sent = Date.now();
await session.send("Reply with exactly: hi");

const seenTypes = new Map<string, number>();
let assistantText = "";
let cost = 0;
let inputTokens = 0;
let outputTokens = 0;
let didError = false;

for await (const ev of session.events) {
  seenTypes.set(ev.type, (seenTypes.get(ev.type) ?? 0) + 1);

  if (ev.type === "message.updated") {
    const info = (ev.raw as {
      properties?: {
        info?: {
          role?: string;
          cost?: number;
          tokens?: { input?: number; output?: number };
          error?: unknown;
        };
      };
    }).properties?.info;
    if (info?.role === "assistant") {
      if (typeof info.cost === "number") cost = info.cost;
      if (info.tokens) {
        inputTokens = info.tokens.input ?? inputTokens;
        outputTokens = info.tokens.output ?? outputTokens;
      }
      if (info.error) {
        didError = true;
        console.error("assistant error:", JSON.stringify(info.error).slice(0, 600));
      }
    }
  }

  if (ev.type === "message.part.updated") {
    const part = (ev.raw as {
      properties?: { part?: { type?: string; text?: string } };
    }).properties?.part;
    if (part?.type === "text" && typeof part.text === "string") {
      assistantText = part.text; // adapter emits cumulative text-so-far per part
    }
  }

  if (ev.type === "session.idle" || ev.type === "session.error") break;
}

const totalMs = Date.now() - sent;
console.log("");
console.log(`events: ${[...seenTypes].map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log(`assistant: ${JSON.stringify(assistantText)}`);
console.log(
  `tokens in/out: ${inputTokens}/${outputTokens}   cost: $${cost.toFixed(6)}   first reply→idle: ${totalMs}ms`,
);

await session.close();
await adapter.shutdown();
console.log(`shutdown ok — total ${Date.now() - t0}ms`);

if (didError) process.exit(1);
