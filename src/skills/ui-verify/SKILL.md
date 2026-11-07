---
name: ui-verify
description: "Verify a UI with numbers before calling it done: layout check at 390, 1280 and 1920 px, redlines against a spec, pixel compare against a mockup, fix and rerun until the must-fix kinds are zero, then report before/after with the picture. Use for artifacts, HTML pages and pi-phone's own app UI, whenever you made or changed a screen, and before saying any UI work is finished."
---

# UI verify

A picture can look right while the numbers say it is not. Measure, fix, measure again, and show the person the
numbers. Do every step on the real thing: the artifact, the file, or the live app (`http://127.0.0.1:8787/s/<id>`,
`/?sheet=<name>`), not a test page.

## 1. Look, numbers first

- `screenshot` at `widths: [390, 1280, 1920]` (its default: the phone first, then a desktop and a large screen,
  where a layout that only stretches shows its long lines and empty sides). Where the page has both themes and you can show each (a
  `data-theme` you set in your own file, a theme switch in Pi's browser), check both.
- Check every open state the change touches, not only the page as it loads: a menu, a picker, a dialog, a sheet
  opened from another. `screenshot` and `redline` take `steps` that run before each shot, such as
  `steps: [{ click: "[data-part=wiki-capture-model] .choice" }, { wait: ".model-menu" }]`; a sheet opens by link
  (`/?sheet=<name>`, `/?sheet=<module>:<id>`).
- Read each width's **layout check** before the picture: cut text, covered text or controls, tap targets, off-grid
  sizes, contrast, small text, emoji, type, and the tells of an assembled page (broken images, skipped headings, cards
  inside cards, side-tab stripes, glows, pulsing dots, narrow justified text, tight leading, repeated words, corners
  not concentric or poking out of a rounded parent, numbers without tabular figures, gradient surfaces, static CSS tells). Then look at the picture for what numbers cannot say (alignment, balance).
  When they disagree, find out why; never explain a number away.
- A page in Pi's browser (a machine's dev server, a site): `browser_layout_check`, or `browser_screenshot` (its
  answer has the same check).

## 2. Redline against a spec

`redline` (Pi's browser: `browser_redline`) with `spec`, the first of these that exists:
1. The design system's `tokens.css` (the design-system skill: `systems.ts show <id>` names its path).
2. The mockup's numbers, as a list: `padding 16, gap 8/16, radius 24/12/20, font 22/13/12`.
3. The owner's rules for pi-phone and anything without a spec:
   `spacing 0/4/8/12/16/20/24/32, radius 4/8/12/16, font 12/13/14/16/20` (pills pass; no text under 12 px).

On a dense screen, add `selector` for the part you changed (`.composer, .composer button`): auto mode drops numbers
it has no room for. With a sheet or dialog open, auto mode measures only that top layer. Save the picture (`save`)
for the report.

## 3. Compare with a reference

When there is a mockup, or a screenshot you saved once the page was right (`screenshot`'s `save`,
`browser_screenshot`'s `path`), take a new one at the same width and run `image_compare` against it. Screenshots come
as JPEG pictures: use `threshold: 0.15` (0.1 flags JPEG noise), and `resize` only when the sizes differ on purpose. Read the
changed areas, not only the share.

## 4. Fix and rerun

Fix, then run steps 1 to 3 again, until these are zero:
- cut text, unless the cut is intended (a long title with `…` in a list) and you say so;
- elements covering text or controls;
- text under WCAG AA contrast (4.5:1; 3:1 for large text and for muted hints, never lower: the check lists a muted
  hint between 3:1 and 4.5:1 too, which may stay when the report names it);
- text under 12 px;
- emoji or symbol glyphs used as icons (line icons only; in pi-phone `ICONS` in `web/ui.js`);
- tap targets under 40 px at a phone's width;
- broken images, skipped heading levels, and cards inside cards.

Side-tab stripes, glows, pulsing dots, narrow justified text, tight leading, repeated words, corners not concentric or poking out,
numbers without tabular figures, gradient surfaces and static CSS tells: fix them in what you made or changed unless
the design asks for them (a pulse on a live state, a status stripe the owner chose, a fade marked
`data-allow-gradient`), and say which stay and why.

Off-grid sizes and spec misses: fix the ones in what you changed; list the rest instead of rewriting a whole screen.

## 5. Report

Tell the person, with numbers: each kind's count before and after at 390, 1280 and 1920 (for example "contrast 6 → 0, tap
targets 9 → 2: the two chips are 36 px, by design"), what is left and why, and show the redline or diff picture
(embed the saved file). In a pi-phone change, the same counts go in the commit's report and the ticket.
