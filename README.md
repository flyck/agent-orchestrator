# Agent Orchestrator

Local-first, review-first multi-agent dashboard for engineering work.

**Read [`MANIFESTO.md`](MANIFESTO.md) first** — the non-negotiable principles that shape every design decision in this repo.

## Repo layout

```
.
├── docs/         design notes, research, decisions, implementation plan
└── prototype/    the v1 prototype workspace (Bun backend + Angular frontend)
```

Start with [`docs/README.md`](docs/README.md) for the index.

## TL;DR

- One coherent app with workspaces for **Review**, **Feature**, **Bugfix**, **Architecture Compare**.
- Multi-agent under the hood: planner → parallel reviewers → lead synthesizer.
- Runs locally. SQLite for persistence. Configurable concurrency to keep token use and context-switching in check.
- v1 picks **Direction C**: **OpenCode** as the engine (one persistent session per agent, bidirectional), custom Bun + Angular shell. Engine layer is abstracted so a different runtime can plug in later.
- Agents are user-editable from the Settings UI — markdown system prompt + Lucide icon. Built-ins seeded from the repo on first run.
- Visual language is documented in `docs/08-design-system.md`: paper aesthetic, near-monochrome, serif/sans typography, hairline rules, no shadows or gradients.
