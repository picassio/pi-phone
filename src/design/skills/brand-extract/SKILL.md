---
name: brand-extract
description: "Make a design system from a website: Pi opens the brand's site in Pi's browser, measures its colours, fonts, type scale, spacing, radii and shadows with browser_eval, and writes DESIGN.md, tokens.css and manifest.json into the person's own design systems, ready for the design-system skill. Use when the person gives a site's address and asks for its design system, brand colours and fonts, or to design in that site's style."
---

# Brand extract

From a site's address, write a design system of the person's own: the same three files as the bundled ones
(OpenDesign's DESIGN.md format and token schema), measured from the site itself, never guessed. The design-system
skill then lists, applies and checks it like any other.

## 1. Measure

1. `browser_open` the address the person gave, then `browser_size` desktop: a brand's site shows its full type scale
   and containers at desktop width. Close a cookie banner if it covers the page (its "reject" or "necessary only").
2. Read `measure.js` (next to this file) with `read`, and give its whole text as `browser_eval`'s `expression`. It
   answers JSON: the page's background and text, headings h1 to h4, a paragraph, a link, the main buttons, colours by
   how much of the page uses them (text by characters, backgrounds and borders by area), font stacks and sizes,
   the faces the page loaded, spacing, radii, shadows, the content's width, and the `:root` custom properties.
3. `browser_screenshot` the top of the page, and once more after `browser_scroll` down a screen or two: the picture
   tells the atmosphere (dense or airy, flat or layered, photo-led or type-led) that numbers do not.
4. A home page that is mostly a hero photo says little about components: measure one more page that has them (pricing,
   a product or docs page), the same way, and use both.

When browser_eval says it is turned off, say so and stop: the person turns it on in Settings › Pi's browser ›
Scripts, or you ask with `setting_change` (`browser.eval`, `on`). Do not fall back to guessing values from a picture.

## 2. Decide the tokens

`systems.ts` below is the design-system skill's, in `../design-system/` from this skill's folder (use its absolute
path). Run `node <it> show stripe` and read that `tokens.css`: it binds every token
of the schema, with a note on each. Bind the same names, every one of them, from what you measured:

- `--bg`: the page background. `--surface`: cards and panels (a background used on bounded boxes, often the same as
  `--bg`). `--surface-warm`: a third tier only if the site has one, else `var(--surface)`.
- `--fg`: headings' colour. `--fg-2`: body text when it differs, else `var(--fg)`. `--muted`: the greyer text
  (captions, secondary). `--meta`: `var(--muted)` unless there is a fourth tier. `--border`, `--border-soft`.
- `--accent`: the brand colour, the fill of the main buttons (`buttonFills`) or, when buttons are neutral, the link
  colour. `--accent-on`: the text on that button. `--accent-hover`, `--accent-active`: the page cannot show hover
  states, so `color-mix(in oklab, var(--accent), black 8%)` and `16%`, and say so in DESIGN.md.
- `--success`, `--warn`, `--danger`: the site's own when a page shows them; otherwise a green, amber and red that sit
  with the palette, said as chosen, not measured.
- `--font-display`, `--font-body`, `--font-mono`: the measured stacks as they are. A face that is the brand's own
  (not on Google Fonts) will not load elsewhere: keep it first, and name a Google Fonts stand-in of the same kind in
  DESIGN.md section 3.
- `--text-xs` to `--text-4xl`: from the measured sizes and headings (h1 is `--text-4xl` or `--text-3xl`; the body is
  `--text-base`). `--leading-body`, `--leading-tight`, `--tracking-display` from the paragraph and h1.
- `--space-1` to `--space-12`: find the base unit the common paddings and gaps share (4 or 8 px, sometimes 5 or 6) and
  build the ladder from it. Section rhythm from the large margins.
- `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill` from the radii (buttons and inputs small, cards larger).
- `--elev-flat`, `--elev-ring`, `--elev-raised` from the shadows; a flat site binds `none` and a ring.
- `--focus-ring`, `--motion-*`, `--ease-standard`, `--container-*`: the content width as `--container-max`; the rest
  from the schema's defaults, said as defaults.

Where the site's own `:root` custom properties name these values, prefer them: they are the brand's own names for
its palette.

## 3. Write the files

1. `node <systems.ts> list` names the folder of the person's own ("yours in …"). Choose an id from the
   brand's name (lowercase letters, digits, hyphens; add `-site` if a bundled system has that id already) and make
   the folder `<that folder>/<id>/`.
2. `tokens.css`: a short header comment (the site, the date measured), then one `:root { … }` block with every token,
   a comment on each value saying where it came from (measured, or chosen and why).
3. `DESIGN.md`: the bundled ones' nine sections, in order: 1 Visual Theme & Atmosphere, 2 Color Palette & Roles,
   3 Typography Rules (with the hierarchy as a table), 4 Component Stylings (buttons, cards, inputs, navigation as
   measured), 5 Layout Principles, 6 Depth & Elevation, 7 Do's and Don'ts, 8 Responsive Behavior, 9 Agent Prompt
   Guide. Title it "Design System Inspired by <Brand>", and say at the top it was measured from <address> on <date>.
   Write only what the measurements and pictures show; mark what you chose.
4. `manifest.json`: `schemaVersion` `od-design-system-project/v1`, `id`, `name` (the brand), `category` (one of the
   bundled categories `list` shows), `description` (one line: the look), `source`
   `{ "type": "extracted", "origin": "<address>" }`, and `files` `{ "design": "DESIGN.md", "tokens": "tokens.css" }`.
5. `node <systems.ts> check <id>` must say Complete; fix what it names.

## 4. Show it

Make a small HTML page with the new `tokens.css` block (a heading, a paragraph, a primary and a secondary button, a
card, an input), look at it with `screenshot` at 390 and 1280 px next to the site's screenshot, and fix a token that
looks off. Tell the person the id, the folder, and which values were chosen rather than measured; offer it as the
default design system (`setting_change`, `design.default`, the id).

## Rules

- Values only. Never copy the brand's logo, images, illustrations or text into the system or what it makes; DESIGN.md
  describes a public look, and work in it is not the brand's.
- One site per system. A second address of the same brand adds to that system; another brand is another system.
- The format and the idea of extracting a brand's system from its site are OpenDesign's
  (https://github.com/nexu-io/open-design, Apache-2.0).
