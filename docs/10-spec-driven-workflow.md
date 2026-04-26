# Spec-Driven Workflow

The human writes the spec. From there, agents work and the user can interject at any moment.

This is the structural defense against passive "auto-accept" agent use — the failure mode where the user clicks through agent output without engaging. The fix is **getting the user's thinking out of the way upfront**, into the spec, so the rest of the workflow can run smoothly without performative engagement at every step.

## The principle, stated bluntly

Discipline lives in the spec. The user authors it. Working in conversation with the architecture agent, the user arrives at a plan. After that, agents implement, review, and synthesize while the user watches the live state of every agent and steps in if needed.

There are no artificial gates between phases. There are no disabled buttons that exist to slow the user down. There are no forced approvals. The workflow runs forward; the user can stop, comment, redirect, or accept at any moment.

This is **not** a softening of "no auto-pilot." Running a task with no spec — no human articulation of intent — is still the rejected mode. With a spec, orchestration runs smoothly because the thinking has already happened.

## Why hard gates would be wrong

Forced approvals fight the principle. They make the user perform engagement at every step, which is both exhausting and ineffective: people learn to click past forced approvals just like they learn to click past EULAs. Real engagement is upfront (the spec) and on-demand (interjection when something looks off), not forced and continuous.

## Workflow shape

For Feature / Bugfix tasks:

```
1. Spec ────► 2. Plan ────► 3. Implement ────► 4. Review ────► 5. Accept
   (user)      (architecture    (impl. agent)    (parallel       (user, when
                agent +                          reviewers +      ready)
                user, in                         synthesizer)
                conversation)
```

Each is a **state**, not a gate. The task progresses through them. The user can interject at any state via the per-agent comment strip or the task-level Interrupt action.

### State 1: Spec — user writes

The spec editor renders these section headers; the user fills them in:

- **Goal** — outcome in one paragraph.
- **Non-goals** — what we are *not* doing.
- **Acceptance criteria** — concrete, checkable.
- **Scope** — files, modules, surfaces likely to change. Best guess; agents may correct.
- **Open questions** — known unknowns.

Empty sections show a soft inline hint ("Acceptance criteria empty — proceed without?") but **do not block** submission. The product trusts the user to know what's worth filling in.

Specs persist as `tasks.input_payload`; revisions go to `spec_revisions`.

Optional: a **"Critique my spec"** action runs a single fast agent that flags gaps in a sidebar. The agent cannot edit the spec; only the user can.

### State 2: Plan — conversational with the architecture agent

The architecture agent reads the spec and proposes a plan, which streams into an editable view next to an open chat pane with the agent itself.

This is a real conversation:
- Read the plan as it streams.
- Edit it directly.
- Ask the architecture agent questions ("why this approach?", "what about X?").
- Tell it to revise.

The plan is "settled" when the user stops editing and stops asking. There is no "Approve" button — the implementer reads the latest plan when the user moves on. A "Lock plan" action exists for users who want an explicit snapshot, but it is optional.

### State 3: Implement — agent executes

Implementer agent works against the latest plan. The user watches the live stream and can comment into the agent's session at any point.

If the implementer wants to deviate from the plan, it surfaces the deviation and waits briefly (default 5 minutes, configurable) for user input, then proceeds with its best judgment. The user can always interrupt.

### State 4: Review — parallel reviewers + synthesizer

Same structure as the Review tab. Reviewers receive spec + plan + implementation diff. Findings are synthesized.

### State 5: Accept — user decides when ready

Synthesis is presented. No countdown, no auto-merge. The user accepts, sends back with a comment, or archives.

## Review tab: optional review-focus field

The Review tab takes a diff or path, not a full spec. The same principle applies in lighter form: an optional **Review focus** field above the input. Empty is fine.

## UI behavior

- A horizontal **state strip** at the top of the task view shows the current state and the trail of completed ones. Each state is clickable to scroll to its content. The strip is informational — it does not gate anything.
- Per-agent panes show live state dots (running / waiting / idle / errored).
- Every running agent has a comment input strip at the bottom of its pane.
- An "Interrupt task" action is always visible in the task header.

No progress bars, no animated arrows between steps, no celebratory toasts.

## Anti-patterns this rejects

- ❌ Running a task without a user-written spec.
- ❌ Agent-drafted spec first drafts.
- ❌ Auto-pilot that runs without a spec.
- ❌ Disabled buttons that exist only to slow the user down.
- ❌ Forced "are you sure?" dialogs and countdowns.
- ❌ Hidden agent state — the user must always be able to see what each agent is doing right now.

## Soft companion: the manual-coding nudge

After every Nth completed task, the UI surfaces a paper-toned banner reminding the user to do the next change manually. Quiet companion to the spec discipline.

## v1 scope

- Spec editor with the section template, soft hints, revisions, and "Critique my spec."
- State strip showing live progress.
- States beyond Spec render placeholders pointing to v2 (full agent execution behind Plan/Implement/Review/Accept is v2).
