# Research Findings

Existing projects evaluated as candidate bases for the orchestrator.

## 1. PR-Agent (qodo-ai)

Open-source AI PR reviewer with `/review`, `/describe`, `/improve`, `/ask`. Built around automated PR analysis rather than generic agent chat.

**Strengths**
- Review-first orientation out of the box.
- Git/PR-oriented workflow.
- Mature, practical base.
- Open source.

**Limitations**
- Not a desktop/web review workstation with tabbed flows.
- No native planner → implementer → multi-reviewer orchestration UX.
- No architecture visualization or counter-architecture comparison.
- Tightly coupled to GitHub/GitLab/Bitbucket PR contexts; weaker for local diff/path review.

**Links**
- https://github.com/qodo-ai/pr-agent

## 2. Claude Code agent teams

Anthropic's documented multi-agent pattern: parallel reviewers for security, performance, test coverage, with synthesis. Maps closely to the desired specialist-reviewer model.

**Strengths**
- Native multi-agent orchestration (subagents via Task tool).
- Parallel reviewer pattern is documented and idiomatic.
- Synthesis of multiple reviewer outputs is a first-class concept.
- Headless mode (`claude -p --output-format stream-json`) makes it scriptable.

**Limitations**
- Closed-source runtime.
- Default UX is terminal/session-oriented, not workbench-oriented.
- Best treated as an **engine**, not a complete product shell.

**Links**
- https://code.claude.com/docs/en/agent-teams
- https://www.endlessgalaxy.dev/blog/claude-code-agent-teams-lessons

## 3. OpenCode

Open-source, terminal-first, provider-flexible coding agent with a Plan / Build mode split that maps well to "plan before implement."

**Strengths**
- Open source.
- Plan / Build split aligns with the desired workflow.
- Provider-flexible (not locked to one model vendor).
- Suitable for wrapping with a custom frontend.

**Caveats**
- Need to verify upstream maintenance status — there were mixed signals around repositories and continuity.
- Multi-agent / parallel-reviewer story is less mature than Claude Code's.

**Links**
- https://opencode.ai/docs/
- https://github.com/opencode-ai/opencode
- https://www.glukhov.org/ai-devtools/opencode/

## 4. Web wrappers around terminal agent clients

Existing examples wrap Claude Code / Codex / OpenCode in a browser UI while preserving normal interactive behavior. This validates the architecture pattern of:

- Keep the terminal client as the runtime engine.
- Spawn / manage it through a backend process layer.
- Stream interaction to a browser UI.
- Allow direct interactive fall-through when needed.

**Implication**: we can build a review-focused shell on top of an existing engine instead of reimplementing the agent runtime from scratch.

**Links**
- https://github.com/vultuk/claude-code-web
- https://github.com/siteboon/claudecodeui
- https://github.com/chris-tse/opencode-web
