# Candidate Directions & Decision

Three reasonable bases for the prototype. We commit to **Direction C (OpenCode)** for v1 because the user wants real bidirectional interaction with running reviews and the ability to inject comments into the flow.

## Direction A — Extend PR-Agent into a review workstation

Use PR-Agent as the review core. Build a richer desktop/web UI around it. Add orchestration behind it for planner / implementer / specialist reviewers / architecture analyst.

**Pros**
- Strongest review-first DNA from day one.
- Mature, battle-tested PR analysis.

**Cons**
- Heavy GitHub/GitLab/PR coupling — awkward for local-only diffs and paths.
- Multi-agent orchestration would have to be added on top; not native.
- Architecture visualization and counter-architecture features are net-new either way.
- Not built around persistent interactive sessions.

## Direction B — Claude Code as engine, custom Bun/Angular shell

Treat Claude Code headless mode as the orchestration runtime.

**Pros**
- Native multi-agent orchestration (subagents).
- Headless `--output-format stream-json` is built for spawning.
- Already runs locally.

**Cons**
- **Headless = one-shot.** No interactive sessions; the user can't talk back to a running review or steer mid-flow. Adding interactivity means going around the official surface.
- Closed-source runtime.

**Why we passed**: the user explicitly wants to interact with reviews and inject comments mid-flight. Headless doesn't give us that without ugly workarounds.

## Direction C — Build on OpenCode ✅ picked

OpenCode as the underlying agent runtime. Each agent role runs as its own OpenCode session. Sessions are long-lived, stateful, and accept new messages — which is exactly the bidirectional channel we need.

**Pros**
- **Open source** end to end.
- Interactive sessions: user can comment into any agent pane mid-run.
- Plan/Build mode split aligns with planner/implementer roles.
- Provider-flexible (Claude, OpenAI, local models).
- Agent role = a markdown system prompt + tool set; perfect fit for user-editable agent definitions.

**Cons / risks**
- Multi-agent coordination (parallel reviewers + synthesizer) is **our job**, not the engine's. We pay the orchestration cost.
- Upstream maintenance status needs verification before committing — Phase 0 of the implementation plan is a spike to confirm the active repo and the session API surface.
- Less mature than Claude Code's native subagent pattern.

**Mitigation**: `EngineAdapter` interface in the backend abstracts the engine. If OpenCode upstream stalls, we can swap in another open agent runtime (aider, sst/opencode fork, etc.) without touching orchestrator or UI.

## Decision: C for v1

**Why C over B**: interactivity is a hard requirement. Headless can't deliver it cleanly.

**Why C over A**: local-first prototype shouldn't carry GitHub coupling.

**Implication for orchestration**: we build the parallel-reviewer + synthesizer coordination ourselves, on top of N independent OpenCode sessions managed by the Bun backend.

## One folder, not three

Single workspace at `prototype/`. The `EngineAdapter` is the only place the engine choice leaks into the code, so a future swap is local — no second prototype.
