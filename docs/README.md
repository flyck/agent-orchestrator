# Agent Orchestrator — Docs Index

Working notes for a local-first, review-first multi-agent dashboard.

Start with [`../MANIFESTO.md`](../MANIFESTO.md) — the principles every doc here is downstream of.

## Reading order

1. [01-product-brief.md](01-product-brief.md) — what we're building and why
2. [02-research-findings.md](02-research-findings.md) — what's already out there (PR-Agent, Claude Code agent teams, OpenCode, web wrappers)
3. [03-directions-and-decision.md](03-directions-and-decision.md) — three candidate bases (A/B/C), tradeoffs, picked direction
4. [04-architecture.md](04-architecture.md) — system design for the picked direction
5. [05-implementation-plan.md](05-implementation-plan.md) — step-by-step build plan for the v1 prototype
6. [06-v1-scope-and-non-goals.md](06-v1-scope-and-non-goals.md) — MVP boundaries
7. [07-multi-agent-review-flow.md](07-multi-agent-review-flow.md) — how to keep the review pipeline useful, not agent theater
8. [08-design-system.md](08-design-system.md) — paper aesthetic: type, color, components, anti-patterns
9. [09-opencode-integration-notes.md](09-opencode-integration-notes.md) — verified HTTP API surface, chosen integration strategy, revised Phase 0
10. [10-spec-driven-workflow.md](10-spec-driven-workflow.md) — the user writes the spec; from there agents work and the user can interject at any moment
11. [11-background-agents.md](11-background-agents.md) — separate workspace, separate queue, conservative defaults
12. [12-git-worktrees.md](12-git-worktrees.md) — every task that may modify code runs in its own worktree
13. [13-model-access-setup.md](13-model-access-setup.md) — first-run onboarding for provider auth
14. [14-skills-and-repo-context.md](14-skills-and-repo-context.md) — skills library + auto-read repo README/backlog
15. [15-integrations-and-suggested-next.md](15-integrations-and-suggested-next.md) — GitHub integration + suggested follow-ups
16. [16-model-performance-metrics.md](16-model-performance-metrics.md) — difficulty scoring + historic model performance view (v2)

## TL;DR

- **Goal**: a local desktop/web app that treats code review as a first-class workflow with specialized agents (planner, implementer, security/performance/architecture reviewers, lead synthesizer) coordinated under one UI, with bidirectional interaction so the user can comment into any agent mid-flow.
- **Stack**: Bun backend + Angular frontend, single workspace at `prototype/`.
- **Engine**: **OpenCode** — one persistent session per agent role, driven via the engine adapter. WebSocket carries events out and user messages in.
- **Agents**: editable from the Settings UI; each has a markdown system prompt and a Lucide icon. Built-ins seeded from `agents/builtin/*.md` on first run.
- **Design**: paper aesthetic — near-monochrome, serif headings, hairline rules, no shadows or gradients. See `08-design-system.md`.
- **Spec-driven**: Feature/Bugfix tabs require a user-authored spec. From there the workflow runs forward with visible agent states; the user can interject at any moment. No artificial gates. See `10-spec-driven-workflow.md`.
- **v1 scope**: Review tab end-to-end. Feature/Bugfix tabs ship the Spec gate UI; downstream agent execution is v2. Architecture Compare scaffolded only.
