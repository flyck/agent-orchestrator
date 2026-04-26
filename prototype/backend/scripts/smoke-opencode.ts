/**
 * Manual smoke test for the OpenCode adapter scaffolding.
 *
 * Boots `opencode serve` on a random port, hits /global/health, then
 * shuts down cleanly. Does NOT make a model call — that requires
 * `opencode auth login` to have set up provider credentials.
 *
 * Run: `bun scripts/smoke-opencode.ts`
 */

import { startOpenCodeServer } from "../src/engine/opencode";

const t0 = Date.now();
console.log("starting opencode serve…");
const handle = await startOpenCodeServer();
console.log(
  `up in ${Date.now() - t0}ms — pid ${handle.pid} listening on ${handle.baseUrl}`,
);

const h = await handle.client.health();
console.log(`health: ${JSON.stringify(h)}`);

console.log("opening /event briefly to confirm SSE path…");
const res = await handle.client.openEventStream();
const reader = res.body!.getReader();
const decoder = new TextDecoder();
const { value } = await reader.read();
const firstChunk = decoder.decode(value);
console.log("first SSE bytes:", firstChunk.replace(/\n/g, "\\n").slice(0, 120));
await reader.cancel();

await handle.shutdown();
console.log(`shutdown ok — total ${Date.now() - t0}ms`);
