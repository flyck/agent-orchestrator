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

For more info check the [`MANIFESTO.md`](MANIFESTO.md) — it lays out these non-negotiable
principles that shape every design decision in more detail.
