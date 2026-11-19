---
name: Orbyt
description: Open-source CRM, cold email, inbox and automation, set as Swiss railway station signage and a printed timetable.
colors:
  signal: "oklch(0.55 0.22 27)"
  ink: "oklch(0.19 0.012 255)"
  ink-2: "oklch(0.27 0.014 255)"
  board-amber: "oklch(0.84 0.17 85)"
  board-green: "oklch(0.8 0.16 150)"
  cool-paper: "oklch(0.972 0.004 250)"
  card-white: "oklch(1 0 0)"
  muted-paper: "oklch(0.953 0.005 250)"
  secondary-paper: "oklch(0.94 0.006 250)"
  hairline: "oklch(0.88 0.006 250)"
  field-stroke: "oklch(0.78 0.008 250)"
  muted-ink: "oklch(0.45 0.012 255)"
  sidebar-rule: "oklch(0.32 0.014 255)"
  state-ok: "oklch(0.48 0.13 155)"
  state-warn: "oklch(0.52 0.12 70)"
  state-destructive: "oklch(0.5 0.2 27)"
typography:
  display:
    fontFamily: "Archivo, sans-serif"
    fontSize: "clamp(2.75rem, 9vw, 6rem)"
    fontWeight: 800
    lineHeight: 0.94
    letterSpacing: "-0.012em"
    fontVariation: "wdth condensed"
  headline:
    fontFamily: "Archivo, sans-serif"
    fontSize: "3rem"
    fontWeight: 800
    lineHeight: 1
    letterSpacing: "-0.02em"
    fontVariation: "wdth condensed"
  title:
    fontFamily: "Archivo, sans-serif"
    fontSize: "1.25rem"
    fontWeight: 800
    lineHeight: 1.25
    letterSpacing: "-0.01em"
    fontVariation: "wdth condensed"
  body:
    fontFamily: "Archivo, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Archivo, sans-serif"
    fontSize: "0.72rem"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "0.06em"
    fontVariation: "wdth semi-condensed, uppercase"
  clock:
    fontFamily: "Archivo, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 700
    lineHeight: 1.2
    fontFeature: "tnum"
  mono:
    fontFamily: "Geist Mono, monospace"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.6
rounded:
  sm: "2.4px"
  md: "3.2px"
  lg: "4px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
  section: "96px"
components:
  button-signal:
    backgroundColor: "{colors.signal}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 14px"
  button-default:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.cool-paper}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 14px"
  button-outline:
    backgroundColor: "{colors.cool-paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "0 14px"
  input:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    height: "36px"
    padding: "4px 12px"
  card:
    backgroundColor: "{colors.card-white}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "20px"
  badge-ok:
    textColor: "{colors.state-ok}"
    rounded: "{rounded.sm}"
    height: "20px"
    padding: "2px 6px"
  departure-board:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    rounded: "{rounded.lg}"
    padding: "12px 24px"
---

# Design System: Orbyt

## Overview

**Creative North Star: "The Timetable"**

Orbyt is set as Swiss railway station signage and printed timetables. A cool white paper ground carries ink-black sign fields (the app rail, the departure board, the landing station bar and footer). Everything the product does is a dated row on one board, running on schedule. Headings are condensed Archivo, every time and count is a tabular numeral, and structure comes from hairline rules with one heavy rule under table heads rather than from boxes and shadows.

Density is calm and tabular: the signed-in app is tables and rows, not cards in a grid. The landing page is the same world at poster scale: one large condensed headline, then the board. Colour carries jobs, never decoration: ink is the shell and live boards, signal red is the marker, and amber is the live numeral on ink.

The system rejects the category template: gradient hero, rows of icon cards, dark neon (confirmed in the direction contract).

**Key Characteristics:**
- Ink sign fields on cool paper; signal red reserved for the marker, the single primary action and selection.
- Condensed Archivo 800 headings, regular-width Archivo for UI text, tabular numerals for all times and counts.
- Hairline rules throughout; one 2px ink rule under table heads and under board headers.
- Near-square corners (4px at most); square state tiles that always carry a text label.
- Signature: the departure board, a live 24h clock with rows that flip in once.

## Colors

A restrained cool-neutral paper and ink palette with one hot signal red and one amber for live numerals. Values are oklch, the source of truth in globals.css.

### Primary
- **Signal Red** (signal): The marker. The orbit-mark dot, the one primary button per screen (`signal` variant), text selection, focus ring, the active-nav dot, the first stop on the landing line, and the closing call-to-action band.

### Secondary
- **Board Amber** (board-amber): Live numerals on ink only: the clock, row times, "in 12 min" countdowns, event stamps on Today's recent-departures board.
- **Board Green** (board-green): Success state tile text on the ink board only.

### Neutral
- **Station Ink** (ink): App rail, landing bar, footer, departure boards, heavy table-head rule, default button, body text. Lifted ink (ink-2) is the rail hover and active surface and the select fill.
- **Cool Paper** (cool-paper): Page ground. Card White (card-white) is cards, inputs, empty states. Muted and Secondary Paper (muted-paper, secondary-paper) are row hover, secondary buttons, footer wash.
- **Hairline** (hairline): Row rules and card edges. Field Stroke (field-stroke) is the input and outline-button border. Sidebar Rule (sidebar-rule) is rule lines on ink.
- **Muted Ink** (muted-ink): Secondary text, table heads, descriptions.
- **State Green / Amber / Red** (state-ok, state-warn, state-destructive): State tiles on paper at 10-15% tint with the same colour as text, always paired with the status word.

### Named Rules
**The One Marker Rule.** Signal red marks one thing at a time: the screen's single primary action, the current selection, or the mark itself. If two red buttons share a screen, one is wrong.
**The Colour With Words Rule.** State is colour plus the word ("Running", "Needs attention"), never colour alone.
**The Amber Is Live Rule.** Amber numerals appear only on ink and only for live or time values.

## Typography

**Display Font:** Archivo (wdth axis, condensed for headings), sans-serif fallback
**Body Font:** Archivo at normal width
**Label/Mono Font:** Archivo semi-condensed uppercase for labels; Geist Mono for code blocks only

**Character:** One family, two widths: the width axis gives signage-style condensed headings and ordinary UI text without a second typeface. Headings are heavy (800) and tightly leaded; body is plain.

### Hierarchy
- **Display** (800, clamp(2.75rem, 9vw, 6rem), 0.94): Landing h1, condensed, balanced wrapping.
- **Headline** (800, 2.25rem to 3rem, 1): Landing section h2s, condensed.
- **Title** (800, 1.25rem, tight): Landing h3s, Today section h2s, empty-state titles. Card titles are 1.05rem 700 semi-condensed. App page h1 is 2rem 800 condensed (set by the shell for all pages).
- **Body** (400, 1rem, normal; 0.875rem in the app): Muted-ink for supporting copy; lead paragraph 1.125 to 1.25rem. Keep prose near 65ch.
- **Label** (700, 0.72rem, 0.06 to 0.08em, uppercase, semi-condensed): Table column heads and board column heads only.
- **Clock** (700, 1.5 to 1.875rem, tabular): The board clock and row times.

### Named Rules
**The Tabular Rule.** Every time, count and money value uses tabular numerals (`tabular` class; tables get it globally).
**The Condensed Heads Rule.** Headings and table heads use the condensed widths; body text never does.

## Layout

Landing: a centred column (max 6xl, 72rem) with 16px side padding rising to 24px at sm, sections separated by 96px bottom padding, an ink band for self-hosting and a signal band for the closing CTA. Services and the first board are table-like grids with a heavy ink rule under the column heads and hairlines between rows. The "line" section is a literal route line with stop dots.

App: a 15rem sticky ink rail (collapses to a horizontally scrolling strip on phones, with sign-out beside the logo) and a main area padded 16px, 40px from md. Navigation is grouped like boards (Grow, Reach, Automate). Content is tables and ink boards stacked with 40px gaps. Spacing runs on a 4px base, with 20px card padding (12px small).

## Elevation & Depth

Flat. Depth comes from tone (ink fields against paper) and rules, not shadow. Cards use a 1px foreground-at-15% ring instead of a border plus shadow. The single shadow in the build is a soft, long, low-offset ink shadow under the landing departure board (`0 24px 48px -24px` ink at 50%), which lifts it as the hero object. Interaction states use tone shifts; buttons press down 1px.

### Named Rules
**The Flat Rule.** Surfaces are flat. Only the landing departure board carries a shadow, and it is soft.

## Shapes

Near-square, like painted sign plates: base radius 0.25rem (4px) for cards and boards, 3.2px for buttons and inputs, 2.4px for badges, which read as square state tiles. No pills, no large rounding. The one round form is the orbit mark's ring and dot and the line-section stop dots, which echo a station clock.

## Components

### Buttons
- **Shape:** Near-square (3.2px), 36px tall default, 32px small, 44px large, semibold 14px.
- **Signal:** Red fill, white text, 90% on hover. Used for the page's one primary action.
- **Default:** Ink fill, paper text. **Outline:** Field-stroke border, paper fill, muted hover. **Secondary, ghost, link, destructive (10% red tint):** supporting roles.
- **Focus:** 2px signal outline offset 2px globally; the button also shows a 3px ring at 50%. Active presses 1px down. On ink, outline buttons go transparent with a rail-rule border.

### Badges (state tiles)
- **Style:** 20px tall, 2.4px corners, 0.72rem semibold with tracking. ok, warn and destructive are 10-15% tints with full-colour text; default ink; secondary paper. Always carry the status word.

### Cards / Containers
- **Corner Style:** 4px. White on paper, 1px ring at 15% ink, 20px padding, footer on a muted wash with a top rule. Titles condensed 700.
- Empty states: dashed field-stroke border, white fill, a condensed title, one sentence of purpose and the first action.

### Inputs / Fields
- **Style:** 36px, white fill, field-stroke border, 3.2px corners.
- **Focus:** border and 3px ring in signal at 50%. **Error:** destructive border and 20% ring. **Disabled:** 50% opacity.

### Tables
- Timetable rows: 12px cell padding, hairline row rules, muted hover wash, no outer box. Head row is 40px, uppercase semi-condensed muted, with the one heavy 2px ink rule beneath it.

### Navigation
- Ink rail, 14px medium. Default text at 75% paper; hover on ink-2. Active is a paper-filled item with ink text and a small signal square at the end. Group labels are tiny uppercase at 55%. Landing bar: 56px ink with the wordmark left and links plus a signal Create account button right.

### Departure Board (signature)
Ink panel, 4px corners, header with condensed title, an outlined amber "Sample data" tag and the live amber 24h clock. Column heads in 55% white, rows split by 12% white hairlines. Times: amber if past, white if upcoming (with an amber "in N min"). Status is a square tile in green, amber or neutral tint with its word. Rows flip in once (620ms, staggered 110ms after 250ms), disabled under reduced motion. The Today page reuses the board without clock or flip for recent activity.

### Orbit Mark
A 3.2-stroke ring (currentColor) with a signal-red dot riding it at upper right, from favicon to hero scale; wordmark is Archivo 800 semi-condensed.

## Do's and Don'ts

### Do:
- **Do** use ink for sign fields and signal red only for the one primary action, selection or the mark.
- **Do** pair every state colour with its word.
- **Do** use condensed 800 for headings and tabular numerals for every time and count.
- **Do** separate rows with hairlines and put one 2px ink rule under table and board heads.
- **Do** label illustrative data as sample data.

### Don't:
- **Don't** use gradients, rows of icon cards or neon-on-dark; the category template is refused.
- **Don't** use round pills or radii above 4px; tiles stay square.
- **Don't** use amber outside ink fields, or red for decoration.
- **Don't** add shadows beyond the soft landing-board shadow.

## Not Recorded

- The dark theme exists as tokens only (`.dark` in globals.css) and was not visually inspected; treat it as unverified.
- The build carries small uppercase labels (the sidebar "Workspace" label and group heads) and 12% hairline opacities that are only evidenced in the shell; they follow the table-head label and are not extended to new decorative uses.
