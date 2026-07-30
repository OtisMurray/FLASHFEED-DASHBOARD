---
name: FlashFeed
description: A dark, monospaced instrument panel for reading market state at a glance.
colors:
  void: "#06101A"
  panel-bg: "#0F172A"
  panel-surface: "#1E293B"
  panel-line: "#334155"
  signal-sky: "#0EA5E9"
  signal-sky-fill: "#0369A1"
  signal-sky-fill-hover: "#075985"
  signal-sky-bright: "#38BDF8"
  signal-sky-text: "#7DD3FC"
  state-pass: "#10B981"
  state-pass-text: "#6EE7B7"
  state-pass-value: "#34D399"
  state-fail: "#EF4444"
  state-fail-text: "#FCA5A5"
  state-fail-value: "#F87171"
  state-caution: "#F59E0B"
  state-caution-text: "#FCD34D"
  instrument-text: "#E2E8F0"
  instrument-text-bright: "#FFFFFF"
  instrument-text-dim: "#94A3B8"
  instrument-text-faint: "#64748B"
typography:
  display:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "normal"
  headline:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  data:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, -apple-system, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: "0.025em"
  micro:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
    fontSize: "9px"
    fontWeight: 400
    lineHeight: 1.2
    letterSpacing: "0.025em"
rounded:
  control: "4px"
  panel: "8px"
  pill: "9999px"
spacing:
  hairline: "2px"
  tight: "4px"
  snug: "6px"
  base: "8px"
  cell: "12px"
  panel: "16px"
  frame: "20px"
components:
  button-primary:
    backgroundColor: "{colors.signal-sky-fill}"
    textColor: "{colors.instrument-text-bright}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.signal-sky-fill-hover}"
    textColor: "{colors.instrument-text-bright}"
  button-secondary:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.instrument-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  button-secondary-hover:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.instrument-text-bright}"
  panel:
    backgroundColor: "{colors.panel-surface}"
    textColor: "{colors.instrument-text}"
    rounded: "{rounded.panel}"
    padding: "16px"
  table-shell:
    backgroundColor: "{colors.panel-surface}"
    rounded: "{rounded.panel}"
    padding: "0"
  table-header-cell:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.instrument-text}"
    typography: "{typography.label}"
    padding: "8px"
  table-cell:
    textColor: "{colors.instrument-text}"
    typography: "{typography.data}"
    padding: "8px"
  chip-pass:
    textColor: "{colors.state-pass-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 6px"
  chip-fail:
    textColor: "{colors.state-fail-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 6px"
  chip-caution:
    textColor: "{colors.state-caution-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 6px"
  chip-info:
    textColor: "{colors.signal-sky-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "2px 6px"
  input-field:
    backgroundColor: "{colors.panel-bg}"
    textColor: "{colors.instrument-text-bright}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
  status-badge-ok:
    textColor: "{colors.state-pass-text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 10px"
  status-badge-down:
    textColor: "{colors.state-fail-text}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "6px 10px"
  nav-item:
    textColor: "{colors.instrument-text}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
  nav-item-active:
    textColor: "{colors.instrument-text-bright}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
---

# Design System: FlashFeed

## Overview

**Creative North Star: "The Instrument Panel"**

FlashFeed is read the way a pilot reads a gauge cluster: at speed, under pressure, with
no tolerance for ambiguity. The system is built almost entirely from monospaced numerals,
tiny uppercase legends, and hairline rules on near-black panels. Nothing is decorative.
Color is not a mood — it is a reading. When something on this screen turns green, that is
a measurement, not a flourish.

The density is deliberate and high. Text runs at 9–12px across most of the interface,
tables carry fifteen columns without apology, and whitespace is rationed. This is correct
for the surface: the operator already knows the vocabulary and is scanning for the few
cells that have changed, not being introduced to the domain. Generosity of spacing would
mean fewer instruments visible at once, and fewer instruments visible at once is a worse
panel.

Depth is tonal, never atmospheric. Three near-black steps — void, page, panel — stack to
create hierarchy, with translucent state washes layered on top. A drop shadow appears only
when something genuinely floats above the document: a modal, a toast, a dropdown. The
system is otherwise flat by conviction, and its restraint is what makes the single
licensed flourish — the fetch-progress rail across the top edge — read as an event rather
than as styling.

**Key Characteristics:**
- Monospaced numerals everywhere a value can be compared down a column
- 10px uppercase legends with wide tracking as the universal labelling device
- A strict four-tone state palette: pass, fail, caution, informational
- Translucent state washes (10% fill, 40% border) instead of solid colored blocks
- Flat surfaces, hairline borders, shadow reserved exclusively for overlays
- Absence rendered as an em dash, never as zero and never as blank
- Exactly one ornamental element in the entire system

## Colors

The palette is a four-tone state system laid over a cold slate ramp: every color on screen
either reports a state or recedes into the instrument housing. There is no brand color that
exists purely to be the brand color.

### Primary

- **Signal Sky** (`#0EA5E9`): The single accent, and the value behind `--accent`. Carries
  interactive intent as a *line or a mark*, never as a field behind white text — the active
  sort column, ticker symbols that open a detail view, focused input borders, active-state
  washes, the wordmark. Its scarcity is what makes an active state legible in a screen of
  two hundred values.
- **Signal Sky Fill** (`#0369A1`): The solid field behind white text — primary buttons and
  selected toggles. It is deliberately three steps darker than the accent, because white on
  Signal Sky measures 2.77:1 and fails at every size this system sets text. White on Signal
  Sky Fill measures 5.93:1.
- **Signal Sky Fill Hover** (`#075985`): The hovered state of a filled control. Hover moves
  *down* the ramp, not up: white reaches 7.56:1, so contrast improves under the cursor
  rather than collapsing at the moment of the click.
- **Signal Sky Bright** (`#38BDF8`): The lit end of the ramp. Appears in the fetch rail
  gradient, meter-bar fills, and a handful of emphasis borders. It is never a field behind
  white text — that pairing is 2.14:1.
- **Signal Sky Text** (`#7DD3FC`): Signal Sky as foreground on dark. Used for informational
  values, secondary readings, and "moderate" quality tiers — the tone that means *noted*,
  not *good* and not *bad*.

### Secondary

The three state tones. These are semantic and non-negotiable; they are never used
decoratively, and never for a meaning other than the one below.

- **State Pass** (`#10B981`): Bullish direction, threshold passed, healthy service, positive
  change, confirmed signal. As a fill it appears only at 10–20% opacity.
- **State Pass Text** (`#6EE7B7`) / **State Pass Value** (`#34D399`): Pass as foreground.
  The lighter step labels a chip; the deeper step carries a numeric value in a table cell.
- **State Fail** (`#EF4444`): Bearish direction, threshold failed, blocked, unreachable,
  negative change.
- **State Fail Text** (`#FCA5A5`) / **State Fail Value** (`#F87171`): Fail as foreground,
  chip and numeral respectively.
- **State Caution** (`#F59E0B`): Uncertain, pending, degraded, borderline. The tone for a
  reading that has not resolved — a confidence between thresholds, a stale cache, a
  partially populated window. Caution is used far more often than an alarm color would be,
  because in this product the honest answer is frequently *not yet*.
- **State Caution Text** (`#FCD34D`): Caution as foreground.

### Neutral

The instrument housing. Four steps of near-black and four of cool grey.

- **Void** (`#06101A`): Deeper than the page. Reserved for the full-bleed pre-boot screen
  shown before the API answers. Nothing inside the running application uses it.
- **Panel Background** (`#0F172A`): The page field, and the recessed fill inside panels —
  input wells, table header strips, code blocks.
- **Panel Surface** (`#1E293B`): Every card, table shell, modal, dropdown, and toast. The
  one step of elevation the system has.
- **Panel Line** (`#334155`): Every border and divider. One pixel, always. In dense table
  bodies it drops to 30% opacity so rows separate without striping the eye.
- **Instrument Text** (`#E2E8F0`): Default foreground. The workhorse — labels, body copy,
  and any value with no state attached.
- **Instrument Text Bright** (`#FFFFFF`): Reserved for emphasis inside a panel — a heading,
  a hovered table header, an active nav item. It marks focus of attention, not importance
  of content.
- **Instrument Text Dim** (`#94A3B8`): Supporting detail, secondary timestamps.
- **Instrument Text Faint** (`#64748B`): Column sub-legends, placeholder text, and metadata
  the operator reads only when something is wrong.

**Known deferred gap — the Faint tier.** Instrument Text Faint measures **3.07:1** against
Panel Surface, below the 4.5:1 AA threshold for the sizes it is set at. This is recorded,
not fixed. Raising it to `#94A3B8` would clear the threshold but would flatten the
distinction between Faint and Instrument Text Dim, which the dense surfaces rely on to keep
three levels of de-emphasis legible in one cell. The tier is used widely enough that
changing it is a system decision, not a defect fix. New work should not extend Faint to any
content the operator must read to make a decision; anything decision-bearing belongs at Dim
or above. Revisit as its own pass.

### Named Rules

**The Four Tones Rule.** Every colored pixel is Pass, Fail, Caution, Informational, or
neutral housing. There is no sixth tone. A new signal that needs to be distinguished gets a
label, a position, or a glyph — not a new hue. Adding violet to mean "experimental" breaks
the panel, because the operator has learned that color means state.

**The Absent Is Not Zero Rule.** A value that was never ingested renders as an em dash
(`—`), styled in Instrument Text. It is never `0`, never `N/A`, never an empty cell, and
never hidden. Zero is a measurement and gets a numeral; absence is a different fact and gets
a dash. This is the most-repeated convention in the codebase and the one most worth
protecting.

**The Accent Is A Line, Not A Field Rule.** `--accent` (`#0EA5E9`) is for borders, text,
marks, and translucent washes. The moment it becomes a solid field with white text on it,
it must step down the ramp to Signal Sky Fill (`#0369A1`). The accent stays one value for
every other purpose; only the filled variant darkens. A button is the one place in this
system where the brand color is not the brand color.

**The Wash, Not The Block Rule.** State color as a background is always a translucent wash —
10% fill behind a 40% border, with the text at the light step. Solid state fills are for
1.5px dots, 4px meter bars, and progress rails only. A solid emerald block the size of a
card reads as an alert; a wash reads as a reading.

## Typography

**Display / Data Font:** `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace`
**Body / Label Font:** `system-ui, -apple-system, sans-serif`

**Character:** Two voices with a hard division of labor. The monospace voice speaks
measurements — prices, percentages, scores, counts, tickers, latencies. The system sans
speaks *about* measurements — column legends, prose, headings, button text. An operator
should be able to tell at a glance whether they are looking at data or at chrome, and the
letterforms alone should tell them.

### Hierarchy

- **Display** (mono, 700, 24px, 1.0): The FlashFeed wordmark on the pre-boot screen. Appears
  once.
- **Headline** (sans, 600, 18px, 1.4): Panel titles and page-level headings. Rare — most
  panels are labelled by a legend, not a headline.
- **Title** (sans, 600, 14px, 1.4): Card headings, modal titles, group labels within a
  settings panel.
- **Body** (sans, 400, 12px, 1.5): Prose, button text, form values, empty-state copy. The
  default reading size. This system's "body" is smaller than the web's; that is intentional.
- **Data** (mono, 400, 12px, 1.4): Every numeric value in a table cell. Directional values
  take a state color; everything else is Instrument Text.
- **Label** (sans, 500, 10px, 1.2, +0.025em, uppercase): The universal legend. Table column
  headers, field labels, section markers, chip text.
- **Micro** (mono, 400, 9px, 1.2): Sub-values under a primary reading — a score beneath a
  direction arrow, a horizon beneath a prediction, a count beneath a badge.

### Named Rules

**The Mono Numeral Rule.** Any number a user might compare against the number above it is
set in the monospace face. Digits must align vertically down a column without exception —
this is the entire reason the face exists in the system. A price, a percentage, a score, a
count, a latency, a ticker symbol: monospace. A sentence containing a number: not.

**The Legend Rule.** Anything that names a value rather than being one is 10px, uppercase,
+0.025em tracking, weight 500, in Instrument Text. This single treatment covers table
headers, form labels, and section markers, and it is why the interface stays legible at
fifteen columns: legends are visually identical everywhere, so the eye stops parsing them
and goes straight to the data.

**The Two Voices Rule.** Never set a measurement in the sans face, and never set prose in
mono. Mixing them costs the reader the one instant cue that tells them what kind of thing
they are looking at.

## Layout

The application is a **fixed frame, not a scrolling document.** The shell is exactly one
viewport tall (`100vh`), the header is fixed at the top, and scrolling happens inside
individual regions — a news column, a table body, a side rail — never on the page as a
whole. Overview enforces this explicitly above 900px with a flex column whose last grid row
absorbs remaining height. The operator's mental model is a panel with several live windows
in it, and a page that scrolls away underneath them would break that model.

Content sits in a single full-width region with `16px` padding, rising to `20px` at the
`md` breakpoint. There is no max-width container and no centered measure: horizontal space
is instrument real estate and is used to the edge. The one exception is genuinely narrow
prose — an empty state, the pre-boot screen — which caps at `32rem` and centers.

Panels are composed on a 12-column grid at desktop widths, collapsing to a single column
below `900px`. Multi-panel pages give the primary region roughly two thirds and the side
rail one third.

The spacing rhythm is tight and built on a 2px base: `2px` and `4px` inside chips and
badges, `6–8px` in table cells and controls, `8px` between sibling elements, `12–16px` for
panel padding, `20px` for the outer frame. Gaps between adjacent controls are `6px`;
between panels, `16px`.

Column sizing in tables is content-driven with `whitespace-nowrap` on headers — columns
never wrap their legend. Wide tables scroll horizontally inside their own panel shell
rather than forcing the frame to scroll.

### Named Rules

**The Fixed Frame Rule.** The page never scrolls. Regions scroll. If a new surface makes the
document taller than the viewport, the surface is wrong, not the frame.

**The Edge-to-Edge Rule.** No max-width container on data surfaces. A reading pane may
constrain its measure; a panel of instruments may not.

## Elevation & Depth

**This system is flat by conviction.** Depth is expressed tonally through three near-black
steps — Void (`#06101A`) beneath the application, Panel Background (`#0F172A`) as the page
field, Panel Surface (`#1E293B`) as every card and table — reinforced by one-pixel Panel
Line borders. A panel is distinguished from the page by being one step lighter and having an
edge, never by casting a shadow. Recessed elements (input wells, table header strips) invert
the move and drop back to Panel Background.

Shadows exist only to say *this floats above the document*. There are three of them and they
appear exclusively on transient overlays.

### Shadow Vocabulary

- **Overlay** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.25)`): Toasts and dropdown menus
  that leave the layout flow.
- **Overlay Deep** (`box-shadow: 0 25px 50px -12px rgb(0 0 0 / 0.4)`): The navigation
  overflow menu, which floats over dense table content and needs a harder edge.
- **Rail Glow** (`box-shadow: 0 0 12px rgba(56, 189, 248, 0.65)`): Not elevation. A single
  licensed emission from the fetch-progress rail. Documented here so it is not mistaken for
  a reusable glow token.

### Named Rules

**The Overlay-Only Shadow Rule.** A shadow means the element is not in the document flow.
Cards, panels, tables, chips, buttons, and inputs are flat at rest and flat on hover. If a
surface needs to feel more prominent, it gets a border or a tonal step — never a shadow.

## Shapes

The form language is rectilinear and tight. Two radii do almost all the work, and the
difference between them carries meaning: **4px marks a control, 8px marks a container.**

- **Control radius** (`4px`): Buttons, inputs, selects, chips, tags, table-embedded badges,
  code blocks. Anything the operator acts on or that sits inside a panel.
- **Panel radius** (`8px`): Cards, table shells, modals, dropdowns, toasts, alert
  containers. Anything that holds other things.
- **Pill** (`9999px`): Reserved for two shapes only — status badges with a leading indicator
  dot, and the dots and meter bars themselves. A pill signals *live state*, which is why
  it is not available for ordinary buttons.
- **12px** appears on a small number of feature containers and should be treated as a rare
  exception rather than a step in the scale.

Borders are always exactly `1px`, always Panel Line or a state color at 25–50% opacity.
The system has no 2px borders and no dashed borders. Table shells clip their contents
(`overflow: hidden`) so the header strip and rows share the panel's rounded corners cleanly.

The only non-rectilinear form in the system is the progress rail, whose right end is capped
with a half-pill so the filling edge reads as motion.

### Named Rules

**The Two Radii Rule.** 4px if you act on it, 8px if it contains things, full-round only if
it reports live state. There is no other radius decision to make.

## Components

### Buttons

Terse and mechanical: a button changes color and does nothing else. No lift, no scale, no
shadow, no easing flourish. `transition-colors` is the entire motion budget, and it is the
only transition in the system used more than once.

- **Shape:** Control radius (4px). Never pill, never square.
- **Primary:** Solid **Signal Sky Fill** (`#0369A1`) — not the accent — with white text at
  weight 500 and `8px 16px` padding at body size. On dense toolbars it compresses to
  `6px 10px` at 11px. The same fill marks a selected toggle in a segmented control.
- **Hover:** Fill moves *down* to Signal Sky Fill Hover (`#075985`). Nothing else moves.
- **Secondary:** Transparent-to-Panel-Background fill with a Panel Line border and
  Instrument Text label. On hover the text goes bright white and the border goes Signal Sky
   — the border shift is the affordance.
- **Disabled:** `opacity: 0.5`, no color change. The button stays where it was and simply
  dims.
- **Destructive:** No dedicated variant exists. Destructive intent is carried by a State
  Fail wash on a secondary button.

### Chips

The workhorse of the data surface — the way a cell says something categorical.

- **Style:** Inline-flex, control radius, `2px 6px` padding, 10px label type, a 1px state
  border at 40% opacity over a 10% state wash, with text at the state's light step.
- **State:** Four semantic variants only — pass, fail, caution, info. A chip is never
  interactive; a chip the operator can click is a button styled as a chip, and should not
  be.
- **Micro variant:** 9px uppercase at `2px 6px` for chips that sit inside an already-dense
  cell, such as blocked-reason tags.

### Cards / Containers

- **Corner Style:** Panel radius (8px).
- **Background:** Panel Surface. Recessed sub-regions drop to Panel Background at 40–70%
  opacity.
- **Shadow Strategy:** None. See The Overlay-Only Shadow Rule.
- **Border:** 1px Panel Line on all sides.
- **Internal Padding:** `12px` for dense panels, `16px` for prose and settings panels.

### Inputs / Fields

- **Style:** Panel Background well inside a 1px Panel Line border at control radius.
  `8px 12px` padding for standalone fields, `4px 8px` for inline filter controls. Values
  are set in Instrument Text Bright; numeric inputs take the mono face.
- **Label:** Always a 10px uppercase legend above the field, never a placeholder acting as
  a label.
- **Focus:** The border goes Signal Sky. **The default outline must not be removed without
  a visible replacement** — a `focus-visible` ring of 2px Signal Sky at 60% opacity, offset
  1px, is the required treatment on any control that suppresses the browser default.
- **Placeholder:** Instrument Text Faint.
- **Disabled:** `opacity: 0.5`.

### Tables

The primary instrument. Almost every surface in this product is ultimately a table.

- **Shell:** Panel Surface, panel radius, 1px Panel Line, `overflow: hidden`, with the
  table itself scrolling horizontally inside it.
- **Header:** Panel Background at 50% opacity, a Panel Line bottom border, and legend-typed
  column names — 10px uppercase, `+0.025em`, weight 500, no wrap, `8px` cell padding.
  Sortable headers brighten to white on hover; the active sort column turns Signal Sky and
  appends a `↑` / `↓` glyph, so sort state survives a screenshot and does not rely on color
  alone.
- **Body:** 12px, rows separated by `divide-y` in Panel Line at 30% opacity — a whisper of
  a rule, enough to track across fifteen columns without banding.
- **Cells:** `8px` padding. Values mono; directional values state-colored; absent values an
  em dash.
- **Loading:** A skeleton of the real table — the actual column set, twelve rows, `12px`
  Panel Line bars at varying widths. The skeleton has the same shape as the answer, so the
  layout never jumps.
- **Empty:** Never a bare "no results". See the signature component below.

### Navigation

A single horizontal top bar over Panel Surface with a Panel Line bottom edge, holding the
wordmark at the left, route links in the middle, and controls right-aligned. Links are 12px
body type at control radius with `6px 8px` padding; the active route takes a Signal Sky
wash at 15% with white text, and inactive routes go from Instrument Text to white on hover
with a Panel Background fill. Overflow routes collapse into a `14rem` dropdown panel using
the same item treatment.

The wordmark is mono, weight 700, Signal Sky, with a 10px uppercase "Financial Intelligence"
legend beneath it — the one place the product names itself.

### Status Badge

Pill-shaped, `6px 10px`, 12px weight-500 text, with a 6px leading dot. Healthy: 20% Pass
wash, 50% Pass border, Pass Text label, and the dot pulses. Down: the same construction in
Fail, with the dot static. **The pulse is meaningful** — motion indicates a live connection,
so a static dot on a healthy badge would misreport.

### Toasts

Panel Surface at panel radius with a **3px left border in the state color** — the one place
a state color appears as a solid edge rather than a wash. `12px 8px` padding, an icon glyph
(`✓ ✗ ⚡ ⚠`), a white weight-500 title, optional Instrument Text detail, and an optional
mono latency chip that self-colors by threshold (under 500ms pass, under 2s caution, above
fail). Dismisses on click or after 4 seconds, entering from the right.

### Signature: The Fetch Rail

**This is the system's one licensed flourish, and it is licensed exactly once.**

A 4px bar pinned to the top edge of the header, spanning the full frame width. While a fetch
runs, it fills left to right with a `sky-400 → emerald-400 → yellow-300` gradient, capped
with a half-pill right edge, emitting the Rail Glow, and swept by a white translucent glint
that travels the bar on a 1.15s linear loop. Width transitions over 200ms with linear
easing, so progress reads as mechanical rather than eased.

It earns its ornament because it is the only one. The gradient, the glow, and the glint
appear here and nowhere else in the product.

### Signature: The Diagnostic Empty State

When a screener returns nothing, the table does not say "no results" and stop. It reports
why: a 11px Panel Background block, control radius, carrying `backend_count`,
`frontend_received_count`, `frontend_visible_count`, `model_mode`, the fallback parameters
used, the active filters, and the cache status with its snapshot timestamp.

This is the visual expression of the product's most important truth — that an empty result
is frequently correct, and the operator needs to know whether they are looking at thin
ingest coverage or a filter they forgot they set. **Any new surface that can return zero
rows owes the user this same accounting.**

## Do's and Don'ts

### Do:

- **Do** set every comparable number in the monospace face so digits align down a column.
- **Do** render an absent value as an em dash (`—`). Zero is a measurement; absence is not.
- **Do** label with the legend treatment — 10px, uppercase, `+0.025em`, weight 500 — for
  every column header, field label, and section marker.
- **Do** build state containers as a wash: 10% state fill, 40% state border, light-step
  state text.
- **Do** keep depth tonal — `#0F172A` page, `#1E293B` panel, 1px `#334155` edge.
- **Do** pair color-coded state with a glyph, a word, or a position. Sort direction carries
  an arrow; prediction direction carries `↑`/`↓` and the words `up`/`down`. Assume the
  reader cannot separate the green from the red.
- **Do** give loading states the shape of the real answer, so layout never jumps.
- **Do** tell the user *why* a surface is empty, with counts and parameters.
- **Do** set the default body foreground to Instrument Text (`#E2E8F0`). The current
  `body { color: var(--surface) }` in `app/src/index.css` sets it to `#1E293B` on a
  `#0F172A` field — invisible, and masked only because every component overrides it.
- **Do** provide a visible `focus-visible` ring — 2px Signal Sky at 60%, 1px offset — on any
  control that sets `outline: none`. A 1px border shift alone is not a sufficient focus
  indicator.
- **Do** fill primary buttons and selected toggles with Signal Sky Fill (`#0369A1`), hovering
  down to `#075985`. White on the raw accent is 2.77:1 and fails at every size this system
  sets text at.

### Don't:

- **Don't** introduce a fifth semantic color. Four tones plus neutral is the whole system;
  a new distinction gets a label or a position, not a new hue.
- **Don't** use green or red decoratively. Both are load-bearing directional signals.
- **Don't** put white text on `bg-accent` (`#0EA5E9`, 2.77:1) or on Signal Sky Bright
  (`#38BDF8`, 2.14:1). Solid accent fields carrying text step down to `#0369A1`.
- **Don't** lighten a filled button on hover. Hover moves down the ramp so contrast rises
  going into the click, not the other way.
- **Don't** add a shadow to a card, panel, table, chip, button, or input. Shadows mean
  "floating above the document" and are reserved for modals, toasts, and dropdowns.
- **Don't** reuse the gradient, the glow, or the glint. The fetch rail is the only
  ornamental element in the system and its power is entirely in being singular.
- **Don't** add motion beyond `transition-colors`. The two exceptions — the status badge
  pulse and the rail glint — both encode live state, not polish.
- **Don't** let the page scroll. The frame is `100vh`; regions scroll inside it.
- **Don't** wrap data surfaces in a max-width container or center them.
- **Don't** relax the density to "breathe". Fewer instruments visible at once is a worse
  panel, and this operator is scanning, not reading.
- **Don't** set prose in the mono face or measurements in the sans face.
- **Don't** use a pill radius for an ordinary button. Full-round means live state.
- **Don't** substitute a spinner for a skeleton on a table. The skeleton carries the real
  column set.
