/**
 * End-to-end smoke for the OpenCode adapter.
 *
 * Starts opencode serve, opens one session, sends a tiny "say hi" message,
 * streams events until session.idle, prints the reply + tokens + cost, then
 * shuts down cleanly.
 *
 * Run: `bun scripts/smoke-opencode.ts`
 *
 * Requires: `opencode auth login` already configured. Defaults to
 * openai/gpt-5-nano (cheapest tier). Override with SMOKE_MODEL.
 */

import { OpenCodeAdapter } from "../src/engine/opencode";

const modelStr = process.env.SMOKE_MODEL ?? "openai/gpt-5-nano";
const slash = modelStr.indexOf("/");
if (slash < 0) {
  console.error(`SMOKE_MODEL must be 'provider/model', got '${modelStr}'`);
  process.exit(1);
}
const defaultModel = {
  providerID: modelStr.slice(0, slash),
  modelID: modelStr.slice(slash + 1),
};

const t0 = Date.now();
console.log(`starting opencode serve…`);
const adapter = await OpenCodeAdapter.start({ defaultModel });
console.log(`up in ${Date.now() - t0}ms · ${defaultModel.providerID}/${defaultModel.modelID}`);

console.log("opening session…");
const session = await adapter.openSession({ title: "smoke-test" });
console.log(`session ${session.id}`);

console.log("sending: 'say hi'");
const sent = Date.now();
await session.send("say hi", { system: "Reply with exactly: hi" });

const seenTypes = new Map<string, number>();
let assistantText = "";
let cost = 0;
let inputTokens = 0;
let outputTokens = 0;
let assistantMessageId: string | null = null;
let didError = false;

for await (const ev of session.events) {
  seenTypes.set(ev.type, (seenTypes.get(ev.type) ?? 0) + 1);

  if (ev.type === "message.updated") {
    const info = (ev.raw as {
      properties?: {
        info?: {
          id?: string;
          role?: string;
          cost?: number;
          tokens?: { input?: number; output?: number };
          error?: unknown;
        };
      };
    }).properties?.info;
    if (info?.role === "assistant") {
      if (info.id) assistantMessageId = info.id;
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
      properties?: {
        part?: { type?: string; text?: string; messageID?: string };
      };
    }).properties?.part;
    if (
      part?.type === "text" &&
      typeof part.text === "string" &&
      assistantMessageId &&
      part.messageID === assistantMessageId
    ) {
      assistantText = part.text; // opencode emits the full part content per update, not deltas
    }
  }

  if (ev.type === "session.idle" || ev.type === "session.error") break;
}

const totalMs = Date.now() - sent;
console.log("");
console.log(`events: ${[...seenTypes].map(([t, n]) => `${t}=${n}`).join(", ")}`);
console.log(`assistant: ${JSON.stringify(assistantText)}`);
console.log(`tokens in/out: ${inputTokens}/${outputTokens}   cost: $${cost.toFixed(6)}   first reply→idle: ${totalMs}ms`);

await session.close();
await adapter.shutdown();
console.log(`shutdown ok — total ${Date.now() - t0}ms`);

if (didError) process.exit(1);
