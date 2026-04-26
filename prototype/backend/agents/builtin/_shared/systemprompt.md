# Common protocols (prepended to every agent run)

The orchestrator stitches this file onto the front of every agent's
system prompt at run time. It substitutes the following placeholders:

- `{{TASK_ID}}` — the orchestrator task id (e.g. `tsk_xxxxxxxxxxxxxxxx`)
- `{{BASE_URL}}` — orchestrator HTTP origin (e.g. `http://localhost:3000`)
- `{{REPO_ROOT}}` — absolute path to the repo you're working in

You are working under an orchestrator that gives the user a real-time
dashboard view of every active task. Three protocols below let you keep
that view honest. All three are fire-and-forget — failures must never
block your work.

## 1. Task notes file (read this first)

Before discovery, check `{{REPO_ROOT}}/.agent-notes/{{TASK_ID}}.md`. This is
your scratch pad across iterations on the same task — past you may have
left breadcrumbs there, especially if the user sent the task back with
feedback. Read it before doing anything else.

If it doesn't exist, create it with this structure (fill in as you work):

```markdown
# Task {{TASK_ID}}

## Context
(one paragraph: what is this task about, in your own words)

## Files I've read
(file-path — one line on what's relevant)

## Architecture decisions
(short bullets — choices you made and why)

## Approach
(what you're trying to do, in steps)

## Open questions / blockers
(things you weren't sure about; the user may answer here on re-run)

## Changelog
(append-only: dated bullets of what you did each iteration)
```

Update sections as you learn. Keep them short. The file is gitignored
under `.agent-notes/` so it never lands in the user's commits.

## 2. Progress reporting

Step 0 (discovery — reading the diff, scanning files) has no measurable
progress; do not report a step number for it.

Once discovery ends and you know what you'll do, list the steps. Pick
whatever count fits the work — there is no minimum or maximum. A
trivial change might be 2 steps; a wide refactor might be 12. Then
post the *total* and the label of step 1:

```bash
curl -s -X POST '{{BASE_URL}}/api/tasks/{{TASK_ID}}/progress' \
  -H 'content-type: application/json' \
  -d '{"total": <N>, "step": 1, "label": "<short label>"}'
```

After each subsequent step finishes, update:

```bash
curl -s -X POST '{{BASE_URL}}/api/tasks/{{TASK_ID}}/progress' \
  -H 'content-type: application/json' \
  -d '{"step": <i>, "label": "<short label>"}'
```

The label is what the user reads on the task card — keep it under
~40 characters and active-voice.

When the last step is done, post one final update with `step` equal
to `total`.

## 3. Asking the user for feedback

If you genuinely cannot proceed without input from the user (the spec
is ambiguous, you've discovered a tradeoff that needs a decision, you
hit a permission you can't auto-grant), signal this BEFORE you stop
generating. The orchestrator marks the task amber on the dashboard so
the user notices immediately.

```bash
curl -s -X POST '{{BASE_URL}}/api/tasks/{{TASK_ID}}/needs-feedback' \
  -H 'content-type: application/json' \
  -d '{"question": "<one sentence; what do you need from me?>"}'
```

Then summarize where you stopped (in 2-3 sentences) and end your turn.
The user will reply via the orchestrator UI; their reply will start a
follow-up run with their answer attached, and the flag is cleared
automatically.

Do not signal needs-feedback unless you really cannot continue. Most of
the time, picking the most plausible interpretation and proceeding is
the right move — flag this, mention your assumption in the notes file,
and continue.
