# Manifesto

The non-negotiable principles of this project. Features come and go. These do not.

If a future change conflicts with one of these, the change is wrong, not the principle.

## 1. Agent orchestration is spec-driven first.

The human writes the spec. Working with the architecture agent, the human arrives at a plan. From there, agents implement, review, and surface findings. Passive use of the tool is the failure mode to design against — the upfront spec is where the user's thinking lives, and keeping that thinking on top is the top priority.

**Rejected:** running a task without a human-authored spec; agents drafting the spec for the user; auto-pilot modes that bypass the spec entirely.

## 2. Clear states, no friction. Think upfront, interject anytime.

Every agent in a task has a clearly determinable state — running, waiting, idle, errored — visible at a glance. No artificial gates, no disabled buttons, no forced approvals. The discipline lives in the spec; from there the workflow runs forward and the user can step in at any moment to comment, redirect, or stop.

**Rejected:** UI that hides what an agent is doing; friction added for its own sake; required clicks that exist only to slow the user down.

## 3. Keep coding manually.

The product reminds the user to do work without agents on a regular cadence. Skills don't survive being outsourced.

**Rejected:** framing manual coding as a fallback for when agents fail. It is the default state of a working engineer.

## 4. Agent work is bounded.

Configurable caps on parallel tasks and agents-per-task. A separate, conservative queue for background agents (default: 1). Findings, not patches. No PR spam. No untraceable deployment churn.

**Rejected:** unbounded autonomous loops, default concurrency that prioritises throughput over comprehension, background agents that auto-create or auto-merge changes.

## 5. Content over hype.

Paper aesthetic. Near-monochrome. Hairlines, not shadows. The product is for someone who values their own judgment over the polish of the tool.

**Rejected:** gradients, drop shadows, animated typing dots, AI sparkles, glassmorphism, theme switchers, big colourful CTAs that distract from content.

---

Each mandate has detailed elaboration in `docs/`:

- 1, 2 → [`10-spec-driven-workflow.md`](docs/10-spec-driven-workflow.md)
- 3 → "Manual coding nudge" in [`06-v1-scope-and-non-goals.md`](docs/06-v1-scope-and-non-goals.md)
- 4 → [`11-background-agents.md`](docs/11-background-agents.md), "Two job queues" in [`04-architecture.md`](docs/04-architecture.md)
- 5 → [`08-design-system.md`](docs/08-design-system.md)
