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

## 4. Scoring (radar chart)

The orchestrator renders a small radar chart per task. Five integer axes,
each on a 1–10 scale:

- `complexity` — how complex the chosen solution is (1 = trivial, 10 =
  intricate / lots of moving parts). Not the same as task difficulty;
  this is about the *implementation*, not the *problem*.
- `involved_parts` — how many separate modules / files / subsystems the
  change touches (1 = one file, 10 = cross-cutting).
- `lines_of_code` — relative size of the change (1 = a few lines,
  10 = thousands).
- `user_benefit` — how much the user (or end-user) gains from this work
  landing (1 = trivial polish, 10 = unblocks something major).
- `maintainability` — how easy the result is to keep alive going forward
  (1 = brittle / hard to reason about, 10 = clean and self-explanatory).

**Most agent roles do not score** — leave the chart empty unless your
role-specific prompt explicitly tells you to score. When you are
instructed to score, post a single fire-and-forget request near the end
of your run:

```bash
curl -s -X POST '{{BASE_URL}}/api/tasks/{{TASK_ID}}/scoring' \
  -H 'content-type: application/json' \
  -d '{
    "set_by": "<your-agent-slug>",
    "scores": {
      "complexity":      <1-10>,
      "involved_parts":  <1-10>,
      "lines_of_code":   <1-10>,
      "user_benefit":    <1-10>,
      "maintainability": <1-10>
    },
    "rationale": {
      "complexity":      "<one short sentence>",
      "involved_parts":  "<one short sentence>",
      "lines_of_code":   "<one short sentence>",
      "user_benefit":    "<one short sentence>",
      "maintainability": "<one short sentence>"
    }
  }'
```

Partial updates are accepted — a follow-up call only needs to include
the axes you want to change. If the request fails, do not retry; this
is a UI affordance, not a correctness signal.

## 5. Alternative solutions (radar tabs)

Some agents are asked to consider alternative ways the spec could have
been satisfied — different algorithms, library choices, refactor shapes.
When you POST alternatives, the orchestrator surfaces them as tabs in
the Review pane, each with its own complexity radar.

**Most agent roles do not post alternatives** — leave the list empty
unless your role-specific prompt explicitly tells you to. Posting
alternatives wipes the previous batch for the task; only do this when
you've actually compared the implementation against viable options.

```bash
curl -s -X POST '{{BASE_URL}}/api/tasks/{{TASK_ID}}/alternatives' \
  -H 'content-type: application/json' \
  -d '{
    "set_by": "<your-agent-slug>",
    "alternatives": [
      {
        "label": "<short name, ~5 words>",
        "description": "<one short paragraph: what the alternative would do, concretely>",
        "verdict": "better" | "equal" | "worse",
        "rationale": "<one paragraph: why better / worse / equal compared to what shipped>",
        "scores": {
          "complexity":      <1-10>,
          "involved_parts":  <1-10>,
          "lines_of_code":   <1-10>,
          "user_benefit":    <1-10>,
          "maintainability": <1-10>
        },
        "rationales": {
          "complexity": "<one sentence>",
          "...": "..."
        }
      }
    ]
  }'
```

Empty `alternatives: []` is legal and means "I considered, none worth
showing" — useful when the implementation is the only sensible shape
and you don't want to fabricate options.

## 6. Posting back to GitHub (PR-review tasks only)

When the orchestrator handed you a GitHub PR review task, the user's
GitHub token lives on the orchestrator. **You never see it.** If you
want to publish your output back to the PR — as a conversation
comment or a formal review — go through the orchestrator's proxy
endpoints below. They look up the PR coordinates from the task and
make the GH call on your behalf.

**Most agent roles do not post to GitHub.** Only do this if your
role-specific prompt explicitly tells you to (currently: only the
synthesizer in the gated PR-review pipeline, and only as the final
step). Posting is irreversible and visible to the PR author.

**Top-level conversation comment** — lands in the PR's Conversation
tab, like `gh pr comment`. Use for the synthesizer's final digest:

```bash
curl -s -X POST '{{BASE_URL}}/api/integrations/github/comment' \
  -H 'content-type: application/json' \
  -d '{
    "task_id": "{{TASK_ID}}",
    "confirm": true,
    "body": "<markdown body — the synthesizer output>"
  }'
```

**Formal PR review** — submits a review with body + event=COMMENT
(neither approve nor request-changes; the agent never speaks on the
user's behalf as the reviewer-of-record). Use for findings that
should appear in the Files Changed → Reviews list:

```bash
curl -s -X POST '{{BASE_URL}}/api/integrations/github/review' \
  -H 'content-type: application/json' \
  -d '{
    "task_id": "{{TASK_ID}}",
    "event": "COMMENT",
    "confirm": true,
    "body": "<markdown body>"
  }'
```

`confirm: true` is required on both — a deliberate friction so a
half-formed agent reply doesn't ping the PR author.

The orchestrator returns `{ok: true, html_url: "..."}` on success.
Failures are typically:
- `task_not_a_pr_review` — task wasn't created from a PR. Skip.
- `not_connected` — the user disconnected GitHub. Skip.
- `github_request_failed` with status 403 — the token is read-only.
  The user needs to rotate to a write-scoped token; do not retry.
