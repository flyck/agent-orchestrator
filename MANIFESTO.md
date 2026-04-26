# Manifesto

The non-negotiable principles of this project. Features come and go. These do not.

If a future change conflicts with one of these, the change is wrong, not the principle.

## 1. The human authors the work.

Specs are written by humans. Plans are approved by humans. Findings are acted on by humans. Agents critique, refine, implement, and surface — they never draft, never auto-advance, never auto-merge.

**Rejected:** auto-pilot modes, run-to-completion buttons, agent-drafted spec templates, pre-filled placeholders, "skip this gate" toggles, countdowns to auto-approval.

## 2. Workflow gates are a feature, not a tax.

Submit buttons stay disabled until the work is done. Gates require deliberate clicks. Friction is the point — without it, attention degrades into rubber-stamping.

**Rejected:** anything whose purpose is to make a gate go faster. The gate exists to slow you down.

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
