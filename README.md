# Agent Orchestrator

Local-first, human-first multi-agent dashboard for engineering work. Focuses on minimizing context
switches, maximizing parallelism, bundling related tasks, and silently preparing unrelated PR
reviews.

It is based on these core observations:
- Context switches need to be minimized
- Good Reviews need sharp coding skills from agent-free coding.
- Staring at a CLI all day is not rewarding and not efficient.
- Models keep outperforming each other and need to be switchable at all times.
- Visualizations help
- Interrupting the agent and jumping in with the IDE at any time is vital.

Following these observations, this project uses mainly opencode as its server cli engine,
leveraging git worktrees, to orchestrate everyday coding tasks.


## Design Principles

1. **Spec-driven first.** The human authors the spec with the architecture agent; implementation,
   review, and findings flow from there. Passive use is the failure mode.
2. **Minimize context switches. Low cortisol.** Related tasks share one frame. Reviews and other
   long-running output prepare in the background and surface at natural breaks, not the instant
   they land. One UI, utilizing different engines (either OpenCode, or a custom Claude Code
   engine), to hide the model tooling differences so the user never switches tools to switch
   models. The minimal visual design serves the same goal.
3. **Clear states, no friction.** Every agent's state is visible at a glance. No artificial gates
   or forced approvals — the user can interject, redirect, or stop at any moment.
4. **Keep coding manually.** The product nudges the user to work without agents on a regular
   cadence. Skills don't survive being outsourced.
5. **Agent work is bounded.** Configurable caps on parallel tasks and agents-per-task; a
   conservative queue for background agents. Findings, not patches.
6. **Content over hype.** Paper aesthetic, near-monochrome, hairlines over shadows. Built for
   someone who trusts their own judgment over the polish of the tool.

For more info check the [`MANIFESTO.md`](MANIFESTO.md) — it lays out these non-negotiable
principles that shape every design decision in more detail.

## TL;DR

- One coherent app with workspaces for **Review**, **Feature**, **Bugfix**, **Architecture Compare**.
- Multi-agent under the hood: planner → parallel reviewers → lead synthesizer.
- Runs locally. SQLite for persistence. Configurable concurrency to keep token use and context-switching in check.
- v1 picks **Direction C**: **OpenCode** as the engine (one persistent session per agent, bidirectional), custom Bun + Angular shell. Engine layer is abstracted so a different runtime can plug in later.
- Agents are user-editable from the Settings UI — markdown system prompt + Lucide icon. Built-ins seeded from the repo on first run.
- Visual language is documented in `docs/08-design-system.md`: paper aesthetic, near-monochrome, serif/sans typography, hairline rules, no shadows or gradients.
