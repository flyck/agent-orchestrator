# Model Access & First-Run Setup

The orchestrator is useless without a working model provider. New users land in a state where nothing has been configured — that has to be visible, not silent, and the path to fix it has to be specific, not "go read the docs."

## What "no model access" looks like

Three failure modes the system should treat the same:

1. **No providers configured at all.** `opencode auth list` shows zero credentials and no known env vars are set.
2. **Provider configured but invalid.** A token is present but rejected (e.g. PAT instead of OAuth for GitHub Copilot — exactly what the smoke test hit).
3. **Provider configured for paid endpoint, no payment method.** Less common; treat as "not working" via a probe.

In all three cases the user sees the same sticky banner on every page, the same Settings entry point, and the same setup guidance.

## Detection

Backend has `GET /api/providers/status` returning:

```json
{
  "any_working": false,
  "providers": [
    { "id": "github-copilot", "configured": false, "last_error": null },
    { "id": "anthropic",      "configured": false, "last_error": null },
    { "id": "openai",         "configured": false, "last_error": null },
    { "id": "opencode",       "configured": false, "last_error": null }
  ],
  "checked_at": "2026-04-26T13:00:00Z"
}
```

How `configured` is determined:
- For each provider, check `opencode auth list` output (parsed) and known env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, etc.).
- For `github-copilot`, "configured" means the token is **not a PAT** (we can heuristically detect — the OAuth token doesn't start with `ghp_`, but PATs do; or check `~/.local/share/opencode/auth.json` for a `github-copilot` entry).
- "Working" requires a tiny probe — see below.

Optional probe (`GET /api/providers/status?probe=true`):
- For each `configured` provider, send a 1-token "ping" message to a small/free model.
- Cache result for 5 minutes.
- Cheap providers always probed; expensive providers probed only when user clicks "Test connection."

`any_working = true` iff at least one provider passed its probe (or, if `probe=false`, has the right shape of credentials).

## The banner

Sticky, top of every page, paper-toned (no red backgrounds — this is informational, not an error). One line of body, two actions:

```
┌──────────────────────────────────────────────────────────────────────┐
│  No model provider is set up yet — the orchestrator can't run        │
│  agents until you connect one.                                       │
│                                       [ Set up models ]   [ Hide ]   │
└──────────────────────────────────────────────────────────────────────┘
```

- "Set up models" → Settings → Model Access.
- "Hide" dismisses for the session only (banner returns on next reload until `any_working` flips to true).
- The banner is shown when `any_working === false`. When it flips to true, the banner disappears and a one-shot success toast confirms the connection.

The banner does not appear if `any_working === true`, even if other providers are misconfigured. (Misconfigured providers are surfaced inside Settings, not on the main UI — they're noise once one provider works.)

## Settings → Model Access section

Layout (paper-style list, one row per provider):

```
┌─ Model Access ──────────────────────────────────────────────────────┐
│                                                                      │
│ ◐ GitHub Copilot     not configured                                  │
│   Provides Claude, GPT, and Gemini models via your GitHub account.   │
│   Setup: run `opencode auth login` in a terminal and select          │
│          "GitHub Copilot." Complete the device-code flow.            │
│   [ Copy command ]   [ opencode docs ↗ ]   [ Test connection ]       │
│                                                                      │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│ ◐ OpenCode (free models)     not configured                          │
│   Provides free models hosted by opencode.ai (rate-limited).         │
│   Setup: run `opencode auth login` and choose "OpenCode."            │
│   [ Copy command ]   [ Test connection ]                             │
│                                                                      │
│ ─────────────────────────────────────────────────────────────────── │
│                                                                      │
│ ◐ Anthropic (direct)     not configured                              │
│   Bring your own ANTHROPIC_API_KEY. Higher quality, paid usage.      │
│   Setup: set `ANTHROPIC_API_KEY` in your shell profile and restart   │
│          the backend. Or run `opencode auth login` and choose        │
│          "Anthropic" to store the key in opencode's auth file.       │
│   [ Copy command ]   [ Get API key ↗ ]   [ Test connection ]         │
│                                                                      │
│   …(other providers in collapsed list)…                              │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

Each row's status dot uses the system's standard glyphs:
- `◯` not configured (faint)
- `◐` configured but unverified (muted)
- `●` configured + verified working (ink)
- `●` ink-red filled = configured but failing (with `last_error` shown below)

"Test connection" hits `/api/providers/status?probe=true` for that single provider and updates the row. The button is disabled while in flight.

## Why the CLI, not an in-app login button (for v1)

OpenCode's `auth login` is an interactive device-code flow: it prints a URL + code, the user approves in a browser, and the CLI receives the token. Reproducing that flow in our web UI requires either:

1. Wrapping the OpenCode binary in a PTY and parroting its prompts to the browser — fragile, error-prone.
2. Implementing the OAuth device flow ourselves per-provider — duplicative, drifts as providers change.
3. Driving OpenCode's HTTP `/provider/auth` endpoint (visible in OpenAPI; not yet inspected in detail) — possibly viable in v2 once we know its shape.

For v1, the practical choice is: **show the CLI command with a copy button, link to docs, and run "Test connection" from the UI to confirm.** This is honest about what's involved (a one-time terminal action) and doesn't trap the user in a half-finished GUI for credential setup.

## v2 path: drive auth from the UI

The OpenCode HTTP API exposes `/provider/auth` endpoints (and a `/provider` listing). Once we explore them — likely in v2 — we can:
- Show the device-code URL and code inline in the Settings UI.
- Poll for completion and update the provider row live.
- Skip the "go to terminal" step entirely.

Until then, the CLI path is documented and discoverable.

## Bypass / dev mode

For local development of the orchestrator itself, an env var `ORCHESTRATOR_SKIP_PROVIDER_CHECK=1` suppresses the banner and lets the app run with no providers configured (so we can iterate UI without auth). Off by default in production builds. Documented in `prototype/backend/README.md`.

## Implementation outline

1. Backend endpoint: `GET /api/providers/status`. Implementation calls `opencode` (likely via `Bun.spawn`) to dump auth state, parses, optionally probes.
2. Frontend: `ProviderStatusService` polls on app load and after relevant Settings changes; exposes `anyWorking$` observable.
3. Banner component subscribes to `anyWorking$`; renders only when false.
4. Settings → Model Access component renders a list driven by the same status data, with per-row "Test connection" wired to the same endpoint with `?probe=true&provider=<id>`.
5. Provider catalogue (id, display name, description, setup instructions, docs URL) lives in a static file (`prototype/backend/src/providers/catalogue.ts`), keyed by provider id. Easy to extend.

## v1 scope

In:
- `/api/providers/status` endpoint (detection only; basic probe via `opencode run` with a 1-token ping).
- Sticky banner on `any_working === false`.
- Settings → Model Access section with copyable commands, doc links, per-row "Test connection."
- Catalogue covering: github-copilot, opencode, anthropic, openai (plus a "Other" expandable section for the rest).

Out:
- In-app device-code OAuth flow.
- Per-task provider override UI (the engine config in Settings still has the global default; v1 doesn't expose per-task picking beyond what's already in the agent definition).
