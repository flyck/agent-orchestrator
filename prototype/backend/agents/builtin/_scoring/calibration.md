# Difficulty calibration anchors

The scoring agent reads this file every time it scores a task. Edit it
to reflect what easy / medium / hard mean in *your* codebase. Keep each
anchor to one line.

The score is an integer 1–10. The agent maps the task you describe onto
these anchors and picks the closest level. Adjust over time as you
notice scores drifting from your gut feel.

1 — Rename a single local variable in one file.
2 — Tweak a string constant or copy change in the UI.
3 — Add a new field to an existing form, including the API change.
4 — Add a small handler to an existing endpoint, no schema change.
5 — Add a new HTTP endpoint with handler, tests, and documentation update.
6 — Add a feature that touches two services and adds a database column.
7 — Refactor a module to extract a shared abstraction without behaviour change.
8 — Replace a third-party dependency with another, including all callsites.
9 — Redesign a subsystem (e.g. authentication) with a multi-step migration plan.
10 — Cross-cutting architectural change touching most of the codebase.
