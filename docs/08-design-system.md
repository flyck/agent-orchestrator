# Design System — Paper

The product is for someone who values content over chrome. Visual language: editorial, near-monochrome, hairline, generous whitespace. Think a serious newspaper or a quality printed report — not a SaaS dashboard.

## Principles

1. **Content is the chrome.** The streaming agent output, the findings, the diff — those are the visual focus. UI elements should fade.
2. **Greyscale by default.** Color is a tool, not decoration. The single chromatic accent (ink-red) is reserved for high-severity findings and destructive actions.
3. **Hairlines, not boxes.** A 1px rule separates regions. Cards have hairline borders, not shadows or fills.
4. **Type does the work.** Hierarchy comes from a serif/sans contrast and size, not from color or weight contests.
5. **No motion theater.** Streaming text *is* the animation. No spinners that pulse for show, no shimmer skeletons. A simple status dot suffices.
6. **No gradients, no shadows, no glows.** Ever.
7. **Respect density preferences.** Default to comfortable; offer a compact toggle.
8. **Clear states, easy interjection.** Every agent's state is visible at a glance. The user can comment, redirect, or stop at any moment from any view. No artificial blocks between workflow phases — discipline lives in the upfront spec, not in mid-flow gates. See [`10-spec-driven-workflow.md`](10-spec-driven-workflow.md).

## Color tokens

```css
:root {
  --paper:       #FAFAF7;   /* page background, slight warm cream */
  --paper-soft:  #F0EEE8;   /* panels, hovered list rows */
  --ink:         #1A1A18;   /* primary text */
  --ink-muted:   #6E6E69;   /* secondary text, metadata */
  --ink-faint:   #A3A19A;   /* tertiary, placeholders, disabled */
  --rule:        #D8D6CF;   /* hairline borders, dividers */
  --rule-strong: #BAB7AE;   /* emphasized rules, focus borders */

  /* Single accent — used sparingly */
  --ink-red:     #8B1E1E;   /* high-severity, destructive */
  --ink-red-bg:  #F5E9E7;   /* tinted background for high-severity rows */
}
```

Dark mode is **not** in v1. (Adding it later is straightforward — invert ink/paper, keep the principle of low-saturation accents.)

## Typography

| Use | Family | Notes |
|---|---|---|
| Headings (H1–H3) | **Source Serif 4** (or EB Garamond fallback) | Editorial weight; H1 ~28px, H2 ~22px, H3 ~17px |
| Body | **Inter** | 14–15px body, line-height 1.55 |
| Metadata / labels | **Inter**, uppercase, tracked +0.06em | 11px |
| Code, agent stream, file paths | **IBM Plex Mono** | 13px, line-height 1.55 |

Web fonts loaded from a self-hosted directory under `prototype/frontend/src/assets/fonts/` to keep the app offline-capable.

## Iconography

- **Lucide** (`lucide-angular`), stroke style only.
- 1.5px stroke, 16–18px size in UI, 14px inline.
- Color: `var(--ink)` or `var(--ink-muted)`. No filled icons. No two-tone.
- Curated agent icon set (≈40) shown in the icon picker. Suggested starting list:
  - `shield`, `shield-check`, `shield-alert` — security
  - `gauge`, `zap`, `activity` — performance
  - `compass`, `map`, `network`, `git-branch` — architecture
  - `eye`, `glasses`, `microscope` — review/inspection
  - `pencil`, `feather`, `pen-tool` — implementation/writing
  - `flag`, `bookmark`, `tag` — planner/marker
  - `scale`, `gavel`, `book-open` — synthesis/judgment
  - `bug`, `wrench`, `tool` — bugfix
  - `accessibility`, `globe`, `users` — UX/a11y/usability
  - `sparkles`, `lightbulb` — ideation (use sparingly)

The picker is a paper-style dialog: a grid of icons in `var(--ink-muted)`, hover lifts to `var(--ink)`, selection has a 1px ring in `var(--rule-strong)`.

## Layout

- Page max width: 1200px, centered, with 32px gutters.
- Tab bar: 48px tall, hairline rule below, no background fill.
- Per-agent panes in the Review tab arranged in a 3-column row (responsive: stacks under 1024px). Each pane has a 1px border (`var(--rule)`) and 16px internal padding.
- Synthesis pane spans full width below the row, with a heavier top rule (`var(--rule-strong)`).
- Whitespace is generous. When in doubt, add space.

## Components

### Status dot

A 6px filled circle. No text label adjacent unless the agent is `errored` or `waiting_for_user`.

| Status | Color | Notes |
|---|---|---|
| pending | `var(--ink-faint)` | hollow ring |
| running | `var(--ink)` | filled |
| waiting_for_user | `var(--ink-red)` | filled + tiny "input?" label |
| done | `var(--ink-muted)` | filled |
| errored | `var(--ink-red)` | filled + error label |

### Severity marker (findings list)

Inline before the finding title.

| Severity | Glyph |
|---|---|
| info | small open circle, `var(--ink-faint)` |
| low | open circle, `var(--ink-muted)` |
| medium | half-filled circle, `var(--ink)` |
| high | filled circle, `var(--ink-red)` |

No badges. No colored pill backgrounds.

### Buttons

- **Primary**: ink fill, paper text. 1px solid, no rounded radius beyond 2px.
- **Secondary**: paper fill, ink text, 1px solid `var(--rule-strong)`.
- **Tertiary / link**: text only, underline on hover.
- **Destructive**: text in `var(--ink-red)`, 1px solid `var(--ink-red)`.
- No icon-only buttons without a tooltip.

### Inputs

- 1px solid `var(--rule)`, paper fill.
- Focus: `var(--rule-strong)` border, no glow.
- 36px height for single-line; multi-line grows.

### Cards (agent settings)

- 1px solid `var(--rule)`, paper fill, no shadow.
- 16px padding. Title row: agent icon + name (serif) + small tags (uppercase metadata).
- Hover: background fades to `var(--paper-soft)`.

### Markdown rendering (agent output, prompt preview)

- Headings use the serif family.
- Inline code in mono, slightly smaller, no background fill — just `var(--ink)` against `var(--paper-soft)` only when a full code block.
- Code blocks: `var(--paper-soft)` background, 1px rule, mono.

## Anti-patterns

Visual:
- ❌ Drop shadows.
- ❌ Gradients of any kind.
- ❌ Multi-color status badges.
- ❌ Animated typing dots.
- ❌ Round avatars with bright accent rings.
- ❌ "AI" sparkle iconography on every button.
- ❌ Glassmorphism.
- ❌ Big colored CTA buttons that distract from content.

Workflow / interaction:
- ❌ Running a task with no user-written spec ("auto-pilot").
- ❌ Pre-filled spec templates with placeholder content.
- ❌ Agent-drafted first drafts the user just edits past.
- ❌ Disabled buttons that exist only to slow the user down.
- ❌ Forced "are you sure?" dialogs and countdowns.
- ❌ Hidden agent state — the user must always be able to see what each agent is doing.

A future request to add any of these should be pushed back on, not silently honored.

## Reference vibes

Editorial / paper layouts: NYT longform, Atlas Obscura article pages, robinrendle.com, jasonsantamaria.com, are.na, paper-tag style portfolios. Linear's restraint is close in spirit but their accent palette is too saturated for what we want.
