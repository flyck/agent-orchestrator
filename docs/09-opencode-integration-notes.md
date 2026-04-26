# OpenCode Integration Notes

What we know after verification on the user's machine (Omarchy / Arch, 2026-04-26). This replaces the speculative Phase 0 spike with concrete facts.

## Installed environment

- Binary: `/usr/bin/opencode`, **version 1.1.6**.
- Pacman package `opencode` 1.1.6-1, sourced from `https://github.com/anomalyco/opencode`. This is the fork the user has running today; pin against this until/unless we find a more active upstream.
- Config dir: `~/.local/share/opencode/` (`auth.json`, `opencode.json`, `bun.lock`, `node_modules`, `package.json`). Suggests the runtime is a Bun-based JS process.
- Auth: `auth.json` has 0 credentials, but `GITHUB_TOKEN` is set in the environment, which OpenCode picks up for **GitHub Copilot** and **GitHub Models** providers. Working out of the box for v1.

## Confirmed CLI surface

```
opencode serve [--port N] [--hostname H] [--cors ...]   # headless HTTP server
opencode session list
opencode agent list | create
opencode run [message] [--attach URL] [--session ID] [--format json] [--agent NAME]
opencode acp                                            # Agent Client Protocol server
opencode attach <url>
```

## Chosen integration strategy: HTTP server mode

We spawn one long-lived `opencode serve` per backend process, then drive it over HTTP from the Bun adapter. This replaces the PTY fallback completely — no terminal wrapping needed.

Bootstrap (in the backend's startup):

```
OPENCODE_SERVER_PASSWORD=<random> opencode serve --port 0 --hostname 127.0.0.1
# port 0 = OS-assigned; we read stdout to learn the bound port
```

Then every adapter call hits the HTTP API.

## HTTP API we'll use

Source of truth: `GET /doc` on the running server returns OpenAPI 3.1.

| Endpoint | Use |
|---|---|
| `GET /global/health` | Backend startup readiness probe |
| `GET /event` | SSE stream of all bus events (per-session events filtered client-side) |
| `POST /session` (`{parentID?, title?}`) | Create a session per agent run |
| `GET /session` | Debug / reconcile after restart |
| `GET /session/:id` | Inspect |
| `DELETE /session/:id` | Cleanup when our `agent_run` ends |
| `PATCH /session/:id` | Set/update title (we set it to `<task title> · <agent name>`) |
| `POST /session/:id/prompt_async` | Send a message; returns `204` and we read the response off `GET /event` |
| `POST /session/:id/message` | Synchronous send (used only for short orchestrator pings) |
| `GET /session/:id/message` | Backfill on reconnect |
| `POST /session/:id/abort` | "Cancel this agent's current turn" from the UI |
| `POST /session/:id/command` | Reserved for slash commands (v2) |

The message body supports `system`, `agent`, `model`, `tools`, `parts`. **Critical for our editable-agents feature**: passing `system` per message means our SQLite `agents.system_prompt_md` is sent verbatim — we do **not** need to mirror our agent definitions into OpenCode's own `agent create` registry. Our DB stays the single source of truth.

```
POST /session/:taskAgentSession/prompt_async
{
  "system": "<contents of agents.system_prompt_md from our DB>",
  "model": "github-copilot/claude-sonnet-4-6",
  "parts": [{ "type": "text", "text": "<user input or planner output>" }]
}
```

## Event stream

`GET /event` is a single SSE stream for all sessions. First event is `server.connected`. Subsequent events carry a `sessionID` we use to fan out to the right `agent_run` in our hub.

Adapter responsibilities:
- Maintain one persistent SSE connection.
- Auto-reconnect with exponential backoff; on reconnect, replay missed messages by `GET /session/:id/message` since the last seen `messageID` per session.
- Translate OpenCode events to our internal `EngineEvent` shape (`text_delta`, `tool_use`, `usage`, `done`, `error`).

## Auth

Set `OPENCODE_SERVER_PASSWORD` (random per backend process) and pass HTTP Basic auth on every request. Default username is `opencode`. The password is generated at backend startup and never written to disk.

## What we get for free that we feared we'd build

- Session persistence and resumption — `GET /session/:id/message` replays the transcript.
- Tool-call streaming — already in the event stream.
- Cancel — `POST /session/:id/abort`.
- Provider flexibility — model is a per-message field, so different agents in one task can use different models if we want (e.g. a cheaper model for the architecture analyst).

## What still needs care

- **Permissions**: OpenCode has per-agent permission rules (`doom_loop`, `external_directory`, `read`, etc.) configured via `opencode.json`. For v1 we let it use defaults; we may need to scope reviewers more tightly in v2 (e.g. read-only).
- **Concurrency inside one OpenCode server**: confirm via the spike that N parallel sessions actually run in parallel and don't serialize. If they serialize, our `max_agents_per_task` setting becomes mostly cosmetic and we'd need multiple OpenCode servers — one per slot.
- **System prompt per-message vs per-session**: docs show `system` as a message field. Verify whether sending it on every message is correct, or whether it's session-sticky after the first send. If session-sticky, we send only on the first message of a session.

## Smoke test results (2026-04-26)

Wire protocol — **all passes**:

- `GET /global/health` → `{"healthy":true,"version":"1.1.6"}`
- `GET /doc` returns OpenAPI 3.1.1 JSON (not HTML — better; we can codegen the adapter types).
- `GET /event` SSE works; first event is `data: {"type":"server.connected","properties":{}}`.
- `POST /session` with `{title}` returns `{id: "ses_..."}`.
- `POST /session/:id/prompt_async` returns `204` and the response streams over the existing `/event` connection.
- All session-scoped events carry `properties.sessionID` (or `properties.info.sessionID` for message events) — demultiplexing works as designed.

Observed event types (full set the `OpenCodeAdapter` will switch on):

```
server.connected         server.heartbeat        idle
session.created          session.updated         session.status
session.idle             session.diff            session.error
message.updated          message.part.updated    text
busy
```

Cost / token accounting lives in `message.updated.properties.info.tokens` (`{input, output, reasoning, cache:{read,write}}`) and `.cost`. Error info lives in `message.updated.properties.info.error.data` with `{message, statusCode, isRetryable, responseHeaders, responseBody}`. End-of-turn signal: `session.status.status.type === "idle"` followed by `session.idle`.

## Schema corrections from the smoke test

These differ from the docs page we fetched earlier:

- **Event stream path is `/event`** (per-instance), not `/event` *and* `/global/event`. The latter is for cross-instance global events; we want `/event`.
- **`model` is an object**, not a string: `{ providerID: string, modelID: string }`. The full model id `"github-copilot/claude-haiku-4.5"` splits into `providerID: "github-copilot"`, `modelID: "claude-haiku-4.5"`.
- `prompt_async` body required field is `parts` only; `system`, `model`, `agent`, `noReply`, `variant` are all optional.
- `parts` items: `TextPartInput` requires `{type:"text", text}`; also `FilePartInput`, `AgentPartInput`, `SubtaskPartInput` available.
- `session` IDs prefix with `ses_`; messages with `msg_`; parts with `prt_` — useful for log filtering.

## Provider auth caveat (action item for the user)

`GITHUB_TOKEN` set in environment is picked up by the server, but **GitHub's Copilot/Models endpoint rejects Personal Access Tokens** with HTTP 400: `"Personal Access Tokens are not supported for this endpoint"`. To make Copilot models actually work, run once:

```sh
opencode auth login
# choose github-copilot, complete the device-code flow in the browser
```

This stores the proper OAuth token in `~/.local/share/opencode/auth.json`. After that, `model: { providerID: "github-copilot", modelID: "claude-haiku-4.5" }` will work.

Other free model paths (`opencode/glm-4.7-free`, `opencode/minimax-m2.1-free`, `opencode/gpt-5-nano`) require an `opencode.ai` account login (`opencode auth login` → opencode provider), not a GitHub token.

## Conclusion

Architecture validated. Phase 1 (backend skeleton) is unblocked. The provider auth step is a one-time setup the user runs separately; it is not a code issue.
