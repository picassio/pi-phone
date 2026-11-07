# jakubkrehel/skills' checks, adapted for pi-phone's layout check

**Where they come from.** [jakubkrehel/skills](https://github.com/jakubkrehel/skills) by Jakub Krehel
([jakub.kr](https://jakub.kr), [Interfaces](https://interfaces.dev)), at commit
`60bf140e43c98b248e6594487384ec967e89d98a` (2026-11-01): the "Before you finish" checks of `better-ui` and
`better-typography`. Copyright 2026 Jakub Krehel, licensed under the MIT License (see `LICENSE`, upstream's copy).

**How they came.** The owner's Auton UI library (auton-ui, `scripts/doctor-responsive.mjs`, CHECK items 7 and 8, and
`scripts/doctor-selftest.mjs` on the owner's devbox) turned them into page checks, together with the stripe and gradient
signs of [heydamir/unslop](https://github.com/heydamir/unslop) (`references/signs.md`, CC BY 4.0, Damir Sokolovsky; its
skill is in `third_party/heydamir-unslop/`) and Impeccable's (`third_party/impeccable/`), and proved them on 17
fixtures. PP-430 reimplemented them in `src/server/layout-check.ts`, the page script the `screenshot` tool and Pi's
browser run, and ported the 17 fixtures into `test/layout-check.test.ts` (9 found, 8 passed). No file of
jakubkrehel/skills, unslop or auton-ui is copied.

| pi-phone kind | Source | What it finds |
|---|---|---|
| `concentric` | better-ui, "Outer radius equals inner radius plus padding" | a painted surface in a painted surface with an even gap of 1 to 12 px whose corner radii are not outer = inner + gap + border (within 2 px), radii as drawn |
| `tabular` | better-typography, tabular-nums on changing values and numeric columns | digits in cells, timers, progress, meters, outputs and live regions without `font-variant-numeric: tabular-nums` (monospace passes) |
| `gradient` | unslop's signs, Impeccable | a gradient of two colours or more on a surface of 1600 px² or more (`data-allow-gradient` opts out) |
| `side-tab` (extended) | unslop's signs | also an inset shadow along the top or bottom, and a `::before`/`::after` bar 4 px or thinner along half the box |
| `css-tell` | better-ui, better-typography, better-accessibility | `transition: all`; line height 1 on wrapping text; a text field under 16 px on a phone (iOS zooms in); a scrolling dialog without `overscroll-behavior: contain`; a viewport that blocks zoom; `font-feature-settings: "tnum"` instead of `tabular-nums` |

**pi-phone's changes.** auton-ui's 12 px cutoff for the concentric gap is kept (better-ui judges 24 px by eye). The
glow's blur floor is auton-ui's 6 px; Impeccable's other glow limits stay. What a computed style cannot show is left
out: line height set in px, `100vw` and `100vh`, `outline: none` without a `:focus-visible` replacement, `active:scale`
and bounce easing.

**Updating.** There is nothing to sync: to take a later check, read it in a clone of
[jakubkrehel/skills](https://github.com/jakubkrehel/skills) (`skills/better-*/SKILL.md`), change `layout-check.ts` and its
test, and record the new commit here.
