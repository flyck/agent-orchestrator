# Claude Code as a Second Engine

Adds Claude Code (the CLI) as a selectable engine alongside OpenCode. Motivation: the user already pays for a Claude Pro subscription — driving the CLI in `--print` stream-json mode burns subscription quota instead of API credits. As a secondary benefit, the existing `EngineAdapter` interface gets exercised against a second backend, surfacing where it leaks today.

## Goals

- Per-task choice between `opencode` and `claude` (and whatever comes next).
- Use Claude Code's local subscription auth — no API key burning, no proxy.
- Reuse all orchestrator pipelines (plan / code / review / pr-review) unchanged.
- Surface engine-specific capabilities where they exist (skills, agents, plan mode), but degrade gracefully when running the same pipeline on either engine.

## Non-goals

- Migrating off OpenCode. The two engines coexist.
- Wrapping the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`). It requires `ANTHROPIC_API_KEY`, which defeats the auth motivation.
- An OpenAI-compatible proxy layer or third-party CLI wrapper.
- Network-served Claude Code (Pro auth is local; running this on a server isn't supported by Anthropic's ToS as of 2026).

## Approach

Two phases.

### Phase 17a — Boundary tightening (no behavior change)

Today's `EngineAdapter` interface is the right shape, but the orchestrator and a couple of API endpoints reach past it into OpenCode-specific types. Six leak points to fix before adding a second adapter:

1. `engine/singleton.ts:31` — `getEngine()` returns concrete `OpenCodeAdapter`. Tighten to `EngineAdapter`. The OpenCode-specific helpers (`getSessionMessages`) move behind a generic `getTranscript(sessionId, limit)` method on the interface.
2. `orchestrator/index.ts:19,487` — `instanceof OpenCodeSession` check for `permission.asked`. Replace with adapter-internal handling (orchestrator-driven sessions always auto-allow, so this collapses to the adapter's responsibility).
3. `orchestrator/index.ts:537–585` — parses opencode's `info.providerID`/`info.modelID` from raw events. Normalize: adapter emits a `session.usage` event with `{model, inputTokens, outputTokens, cacheRead, cacheWrite, costUSD}`. Orchestrator stops looking at `raw`.
4. `orchestrator/index.ts:469`, `scoring.ts:130` — handle "opencode emits cumulative text per part-update" quirk. Move the cumulative→delta normalization into the OpenCode adapter so consumers always see deltas.
5. `api/tasks.ts:561` — calls `OpenCodeAdapter.getSessionMessages()` directly. Lift to `EngineAdapter.getTranscript()`.
6. `engine/types.ts:36` — `ModelRef = {providerID, modelID}` is opencode's shape. Generalize to a discriminated union or a per-engine free-form `model: string` (Claude takes `"opus"` or `"claude-opus-4-7"`; OpenCode wants the split). Keep both representable, document the engine-side parsing.

Phase 17a ships with the OpenCode adapter still being the only one wired — proof that the refactor didn't change behavior.

### Phase 17b — `ClaudeCodeAdapter`

Per-session subprocess driving `claude -p --input-format=stream-json --output-format=stream-json --include-partial-messages --verbose`.

- **Spawn**: `Bun.spawn(['claude', '-p', '--input-format=stream-json', ...flags], { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })` per session.
- **Send**: write `{"type":"user","message":{"role":"user","content":"..."}}` + `\n` to child stdin.
- **Events**: line-buffered NDJSON reader on stdout. Map to `EngineEvent`:
  - `system/init` → `session.created` (capture `session_id`, available tools, model)
  - `stream_event/content_block_delta` → `text` (delta, no cumulative trick)
  - `assistant` → `message.updated` (final text per assistant turn)
  - `rate_limit_event` → log only
  - `result` → `session.idle` (carries `total_cost_usd`, `usage`, `terminal_reason`)
- **Cwd**: process cwd is the worktree path. No `--add-dir` needed (and we don't want to grant Claude access beyond the worktree).
- **Auth**: rely on the user's logged-in session (`apiKeySource: "none"` confirms subscription mode). No flag needed. As a fallback for daemon contexts, support `CLAUDE_CODE_OAUTH_TOKEN` env var (generated via `claude setup-token`) to avoid keychain races under concurrent spawns.
- **Permission**: `--permission-mode bypassPermissions` for orchestrator-driven sessions, mirroring the OpenCode auto-allow. User-facing interactive sessions (future) would relax this.
- **Tool restriction**: `--allowedTools` per phase if we want to lock reviewers down to read-only.
- **Cancel**: SIGTERM → SIGKILL after 2s. Not graceful — see "Known gaps" below.
- **Close**: close stdin → child exits naturally after flushing the `result` event.
- **Transcript backfill**: read `~/.claude/projects/<encoded-cwd>/sessions/<session_id>.jsonl`. The JSONL format is the same line-by-line as the live stream, so the parser is shared.
- **Health**: `claude --version` exits 0 if the binary is on PATH. No long-lived server to ping.

Concurrency: cap at 3 simultaneous Claude sessions per machine. Anthropic's CLI has open issues around `~/.claude/.claude.json` and `~/.claude/.credentials.json` corruption under concurrent writes ([#15608](https://github.com/anthropics/claude-code/issues/15608), [#28829](https://github.com/anthropics/claude-code/issues/28829), [#25609](https://github.com/anthropics/claude-code/issues/25609)). Until those land, a hard ceiling is the safest mitigation. The existing per-task semaphore handles this — extend with a per-engine cap.

### Phase 17c — Engine selection

- `tasks.engine` column (existing `settings.engine` is global; we want per-task).
- `POST /api/tasks` accepts `engine: "opencode" | "claude"`, defaulting to `settings.engine`.
- Create-task UI gets a small picker; default = user's setting.
- Topbar engine-health pill shows the engine for the selected task.

## Engine capability matrix

What each engine can/can't do, and what we do about gaps.

| Capability | OpenCode | Claude Code | Resolution |
|---|---|---|---|
| Subscription auth (no API charges) | ❌ (provider keys) | ✅ (Pro/Max account) | Per-task choice — pick Claude when cost matters. |
| Multiple model providers (OpenAI, Google, …) | ✅ | ❌ (Claude-only) | Pick OpenCode if you need a non-Claude model. |
| Native model aliases (`opus`/`sonnet`) | ❌ | ✅ | `ModelRef` is now per-engine free-form; aliases pass through. |
| Mid-turn graceful abort | ✅ (`POST /abort`) | ❌ ([#3455](https://github.com/anthropics/claude-code/issues/3455)) | **Documented gap.** Claude cancellation = SIGKILL; partial output is lost. |
| Per-tool permission gates mid-turn | ✅ (`permission.asked`) | ❌ (interactive only; we run with `bypassPermissions`) | Both run auto-allow for orchestrator sessions; gap only matters for future interactive UX. |
| Native skills (`/review`, `/security-review`) | ❌ | ✅ | Optional — orchestrator pipelines work without them; expose as opt-in flag in Claude phase config. |
| Inline subagent definitions | partial (`--agent`) | ✅ (`--agents '{json}'`) | Both supported via adapter-specific spawn args. |
| MCP servers | ✅ (config) | ✅ (`--mcp-config`) | Pass-through. |
| Hard per-session cost cap | ❌ (only daily budget setting) | ✅ (`--max-budget-usd`) | Surface as `OpenSessionSpec.budgetUSD?`; OpenCode adapter logs it but cannot enforce. |
| Plan mode (read-only "what would you do") | partial (per-agent permissions) | ✅ (`--permission-mode plan`) | Add `OpenSessionSpec.mode?: "plan" | "execute"`; OpenCode plan-mode = no-write tools allowed list. |
| Structured output validation | ❌ | ✅ (`--json-schema`) | Adapter-specific extension. Reviewers' decision-JSON parsing could move to `--json-schema` on Claude for reliability. |
| Session resume | ✅ (session id stays valid) | ✅ (`-r <uuid>`) | Adapter-internal, no interface change. |
| Concurrency ceiling | ~10+ in one server | **3** (file-corruption bugs) | Per-engine cap in queue; documented in settings. |
| Transcript backfill | HTTP `GET /session/:id/message` | local JSONL read | Both implement `EngineAdapter.getTranscript()`. |
| Hook lifecycle events | ❌ | ✅ (`--include-hook-events`) | Adapter-specific; not consumed by orchestrator today. |
| Versioned API surface | ✅ (OpenAPI 3.1) | ❌ (stream-json schema unversioned) | Pin to a tested Claude Code version range; defensive parsing. |

## Risks

- **Claude Code stream-json schema is unversioned.** A CLI upgrade can break the parser. Mitigation: pin a version range, add a startup probe that runs `claude --version` and warns if the major changed since the last tested version.
- **Concurrency bugs.** Already capped to 3; if it bites, drop to 1 and serialize. Default `settings.max_parallel_tasks` is conservative anyway.
- **OAuth token refresh race under load** ([#25609](https://github.com/anthropics/claude-code/issues/25609)). Use `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` (1-year token) for daemon-mode setups.
- **Anthropic ToS — subscription OAuth in third-party apps.** A 2026 policy restricts redistributing/proxying subscription auth. Driving the user's own CLI on the user's own machine is not a third-party app and is fine; running this on a server fronting other users is not. Documented as deployment guidance.
- **Cancellation gap is real.** "Stop" in the UI for a Claude task means "kill the process now"; the partial-text-so-far is what you see. OpenCode tasks behave better here.

## Implementation checklist

Phase 17a (refactor):
- [ ] `engine/types.ts`: extend `EngineAdapter` with `getTranscript(sessionId, limit)`. Keep `ModelRef` but document per-engine semantics.
- [ ] `engine/singleton.ts`: return `EngineAdapter` interface; rename to `getEngine()` parameterized by engine id.
- [ ] `engine/opencode/adapter.ts`: implement `getTranscript`. Move cumulative→delta normalization into the adapter. Emit `session.usage` synthetic events when token info appears.
- [ ] `orchestrator/index.ts`: drop `instanceof OpenCodeSession`; consume normalized events only. Drop the cumulative-text reset logic (now adapter-side).
- [ ] `api/tasks.ts`: `transcript` endpoint goes through `getTranscript`.

Phase 17b (Claude adapter):
- [ ] `engine/claude/server.ts`: binary discovery + version probe.
- [ ] `engine/claude/session.ts`: per-session subprocess with NDJSON reader/writer.
- [ ] `engine/claude/eventNormalizer.ts`: stream-json events → `EngineEvent`.
- [ ] `engine/claude/transcript.ts`: read `~/.claude/projects/<slug>/sessions/<uuid>.jsonl`.
- [ ] `engine/claude/adapter.ts`: implements `EngineAdapter`. No long-lived server; spawn-per-session.
- [ ] `engine/claude/index.ts` barrel.

Phase 17c (selection):
- [ ] DB migration: `tasks.engine` column.
- [ ] `POST /api/tasks` accepts `engine`.
- [ ] Frontend create-task picker.
- [ ] Per-engine concurrency cap in `queue/`.

## Definition of done

- A task created with `engine: "claude"` runs the same pipeline as one with `engine: "opencode"`, end-to-end.
- Topbar engine pill reflects the per-task engine.
- Cost tracking works for both (Claude cost comes from `result.total_cost_usd`).
- Transcript tab populates for both.
- Cancel works for both (knowing Claude is non-graceful — UI flags this).
- Plan, code, review, finalize all pass on at least one task per engine.
