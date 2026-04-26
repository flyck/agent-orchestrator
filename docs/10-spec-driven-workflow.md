# Spec-Driven Workflow

A core product principle: **the user writes the spec before any agent runs**. This is the structural defense against "auto-accept" passivity — the habit of clicking through agent output without engaging your own judgment.

## The principle, stated bluntly

Agents do not produce specs. They critique, refine, and execute against specs. The first draft is human work, every time, for Feature and Bugfix tabs. There is no "draft this for me" button. There is no run-to-completion button.

This is not a process tax. It is the product. The orchestrator exists to be a serious tool for someone who wants to keep thinking — not a faster way to ship code you didn't reason about.

## Why this matters

The failure mode of agent tooling is a slide into passive review: agent generates plan, user skims it, agent generates code, user skims that, agent self-reviews, user clicks merge. After enough cycles the user has stopped meaningfully engaging — they're a rubber stamp wearing a developer's clothes. The user has explicitly named this as something to design against.

The fix is structural, not motivational. We do not put up a banner saying "please think carefully." We make the workflow refuse to advance until the user has done the thinking and stated it.

## Workflow shape

Every Feature / Bugfix task moves through gates the user must actively pass:

```
┌──────────────┐    ┌────────────────┐    ┌──────────────┐    ┌────────────┐    ┌─────────────┐
│ 1. Spec      │ ─► │ 2. Plan        │ ─► │ 3. Implement │ ─► │ 4. Review  │ ─► │ 5. Accept   │
│   (user)     │    │   (planner +   │    │   (impl.     │    │   (parallel│    │   (user)    │
│              │    │    user        │    │    agent)    │    │    review +│    │             │
│              │    │    approval)   │    │              │    │    synth)  │    │             │
└──────────────┘    └────────────────┘    └──────────────┘    └────────────┘    └─────────────┘
       ▲                    ▲                                       │                   │
       │                    │                                       │                   │
       └─ user comments     └─ user must explicitly                 └─ user can         └─ accept |
          mid-flow into        click "Approve plan."                   send back, or        send back |
          any agent             Plan is editable in place.             accept synthesis.    archive
                               No silent advance.
```

### Gate 1: Spec — user writes

Required sections. The UI shows them as headers in an empty markdown editor. Templates are *blank*; agents do not pre-fill.

- **Goal** — one paragraph. What outcome are we after?
- **Non-goals** — what we are *not* doing. Bullets.
- **Acceptance criteria** — concrete, checkable. "When X happens, Y." Bullets.
- **Scope** — files, modules, surfaces likely to change. Best-guess; agents may correct.
- **Open questions** — anything the user knows they don't know. Bullets.

Until every section has at least one non-whitespace line, the **Submit spec** button is disabled. (Yes, this is heavy-handed. That's the point.)

Optional: a **Critique my spec** action that runs a single fast agent (small model) to flag obvious gaps — missing acceptance criteria, contradictions between Goal and Non-goals, vague language. Output is shown inline as a sidebar; the user can choose to revise. This is the only agent allowed to touch the spec, and it can only suggest, not edit.

The spec is persisted (`tasks.input_payload` carries the markdown) and locked once the user advances. Revisions require explicit "Edit spec" → unlock, which writes a new revision row.

### Gate 2: Plan — planner proposes, user approves

The planner agent reads the locked spec and produces an implementation plan with structured sections (steps, files touched, risk areas, test strategy). The plan renders in an editable markdown view.

Two buttons: **Approve plan** and **Send back with comment**. There is no "approve and continue automatically." There is no countdown timer. The user clicks Approve.

If the user edits the plan before approving, the edits are persisted as overrides; the implementer reads the final approved plan, not the planner's original.

### Gate 3: Implement — agent executes

Implementer agent works against the approved plan. User can comment into the agent's session mid-run (per the existing interactive-session design). The implementer is constrained to the approved plan; if it wants to deviate, it must surface the deviation as a question and wait.

### Gate 4: Review — parallel reviewers + synthesizer

Same structure as the Review tab today. The reviewers receive the spec, the approved plan, and the implementation diff.

### Gate 5: Accept — user decides

The synthesizer's findings are presented. Buttons: **Accept**, **Send back to implementer with comment**, **Archive**. No auto-merge.

## Review tab: optional review-focus field

The Review tab takes a diff or path, not a full spec — but the same principle applies in lighter form. Above the input is an optional **Review focus** field:

> What should reviewers prioritize? *(Optional. If left blank, reviewers cover the diff broadly.)*

Filling it in is cheap and dramatically improves output quality. The UI nudges (placeholder text, micro-hint) but does not require it.

## What this looks like in the UI

Per the paper design system: gates are visualized as a horizontal row of section markers above the working area, like chapter dividers in a printed report. The active gate is filled; completed gates show a small filled circle; future gates show a hollow ring. Clicking a completed gate scrolls to its content (read-only unless explicitly unlocked).

There are no progress bars, no animated arrows between steps, no celebratory toasts. The advance is a button click and a quiet state change.

## Anti-patterns this flow rejects

- ❌ "Auto-pilot" mode that runs all gates back-to-back.
- ❌ "Run to completion" with checkpoints.
- ❌ Pre-filled spec templates with placeholder content the user just edits past.
- ❌ Agent-drafted specs offered as a "starting point."
- ❌ Auto-approve-after-N-seconds.
- ❌ Default settings that bypass any gate.
- ❌ "Skip spec for small changes" toggle.

A future user request to add any of these should be pushed back on directly. The workflow's value is in its refusal to be skipped.

## Soft companion: the manual-coding nudge

Already in scope. After every Nth completed orchestrator task, the UI surfaces a paper-toned banner reminding the user to do the next change manually with no agents at all. This complements the spec gates — gates keep agent-assisted work honest; the nudge keeps non-agent muscles working.

## Implementation impact on v1

This adds a Spec gate UI for Feature and Bugfix tabs. It does **not** require the full agent execution behind those tabs to ship in v1.

Concretely, the v1 deliverable for Feature/Bugfix becomes:

- Spec-writing UI **fully works** (template, validation, persistence, "Critique my spec" action).
- Plan and downstream gates render placeholders explaining the v2 flow.

This is a small addition to v1 scope and protects the core principle even before the full pipeline ships.
