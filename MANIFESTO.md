# Manifesto

The non-negotiable principles of this project. Features come and go. These do not.

If a future change conflicts with one of these, the change is wrong, not the principle.

The product is a local-first, human-first multi-agent dashboard for engineering work. It focuses on minimizing context switches, maximizing parallelism, bundling related tasks, and silently preparing unrelated PR reviews.

## 1. Agent orchestration is spec-driven first.

The human writes the spec. Working with the architecture agent, the human arrives at a plan. From there, agents implement, review, and surface findings. Passive use of the tool is the failure mode to design against — the upfront spec is where the user's thinking lives, and keeping that thinking on top is the top priority.

**Rejected:** running a task without a human-authored spec; agents drafting the spec for the user; auto-pilot modes that bypass the spec entirely.

## 2. Clear states, no friction. Think upfront, interject anytime.

Every agent in a task has a clearly determinable state — running, waiting, idle, errored — visible at a glance. No artificial gates, no disabled buttons, no forced approvals. The discipline lives in the spec; from there the workflow runs forward and the user can step in at any moment to comment, redirect, stop, or drop into the IDE directly. Interrupting an agent and taking over in the IDE is a first-class action, not an exception.

**Rejected:** UI that hides what an agent is doing; friction added for its own sake; required clicks that exist only to slow the user down; treating IDE handoff as a failure mode.

## 3. Minimize context switches. Low cortisol.

Related tasks live in one frame, not scattered across windows. Long-running agent output — reviews especially — is prepared in the background and surfaced at natural break points, not the instant it lands. One UI for everything; one engine layer (OpenCode, or a custom Claude Code engine) hides the differences between models so the user never has to switch tools to switch models. Models keep outperforming each other; the engine layer exists so swapping the best one of the week costs nothing. Staring at a CLI all day is not rewarding and not efficient — visualizations help, and the minimal visual design is part of the same intent: keep the attention tax low so the user can think.

**Rejected:** scattering related work across separate apps or panes; interrupting the user the moment an agent finishes a review; per-model UIs that force the user to relearn each engine; CLI-only workflows where a visualization would carry the same information faster; visual noise that raises rather than lowers attention cost.

## 4. Keep coding manually.

The product reminds the user to do work without agents on a regular cadence. Skills don't survive being outsourced.

**Rejected:** framing manual coding as a fallback for when agents fail. It is the default state of a working engineer.

## 5. Agent work is bounded.

Configurable caps on parallel tasks and agents-per-task. A separate, conservative queue for background agents (default: 1). Findings, not patches. No PR spam. No untraceable deployment churn.

**Rejected:** unbounded autonomous loops, default concurrency that prioritises throughput over comprehension, background agents that auto-create or auto-merge changes.

## 6. Content over hype.

Paper aesthetic. Near-monochrome. Hairlines, not shadows. The product is for someone who values their own judgment over the polish of the tool.

**Rejected:** gradients, drop shadows, animated typing dots, AI sparkles, glassmorphism, theme switchers, big colourful CTAs that distract from content.

---

Each mandate has detailed elaboration in `docs/`:

- 1, 2 → [`10-spec-driven-workflow.md`](docs/10-spec-driven-workflow.md)
- 3 → "Engine layer" in [`04-architecture.md`](docs/04-architecture.md), [`11-background-agents.md`](docs/11-background-agents.md), [`18-claude-code-engine.md`](docs/18-claude-code-engine.md)
- 4 → "Manual coding nudge" in [`06-v1-scope-and-non-goals.md`](docs/06-v1-scope-and-non-goals.md)
- 5 → [`11-background-agents.md`](docs/11-background-agents.md), "Two job queues" in [`04-architecture.md`](docs/04-architecture.md)
- 6 → [`08-design-system.md`](docs/08-design-system.md)
