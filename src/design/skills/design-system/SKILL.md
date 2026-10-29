---
name: design-system
description: "Find and apply a design system (a brand's or a style's colours, fonts, spacing and component rules: 152 bundled from OpenDesign, such as Stripe, Airbnb, Linear, editorial or brutalist, plus the person's own) to HTML pages, artifacts, and Office decks, documents and sheets. Use when the person names a brand or style to design in, asks which design systems there are, or has a default design system in the prompt."
---

# Design systems

A design system is a folder with `DESIGN.md` (the prose: atmosphere, colour roles, type rules, components, layout,
do's and don'ts, an agent prompt guide), `tokens.css` (the same values as CSS custom properties in one `:root` block)
and `manifest.json` (id, name, category, description). pi-phone bundles OpenDesign's (Apache-2.0); the person's own
live in the app's data folder and come first.

## Find one

Run the command next to this file (`systems.ts`, in this skill's folder) with `node`:

```bash
node <this folder>/systems.ts search coral travel     # best matches first (id, name, category, summary)
node <this folder>/systems.ts list                    # all, by category; the person's under "Yours"
node <this folder>/systems.ts list fintech            # one category
node <this folder>/systems.ts show stripe             # its DESIGN.md and tokens.css paths
node <this folder>/systems.ts tokens stripe           # every token's value, var() resolved
```

- The person names a brand or a look: search for it, and pick the best match; when two fit, say which you took.
- They ask what there is: answer with a short list (search, or one category), not all 152.
- The prompt names a default design system (Menu › Design system, the `design.default` setting): use it unless they ask
  for another look or for none. Change the default only when they ask, with `setting_change` (`design.default`, an id
  or `none`).
- Names like "Stripe" describe a public look: use the colours and type, never a company's logo or name as if the work
  were theirs.

## Apply it

Read the system's `DESIGN.md` first (sections 2 to 5 and 7: colours and roles, typography, components, layout, do's
and don'ts; 9 is a prompt guide), then its `tokens.css`.

**HTML pages and artifacts** (with the `html` and `design-artifact` skills, or a deck template):

1. Paste the whole `:root { … }` block of `tokens.css` into the page's first `<style>`, as it is.
2. Style everything through the tokens: `var(--bg)`, `var(--surface)`, `var(--fg)`, `var(--muted)`, `var(--border)`,
   `var(--accent)` (with `--accent-on` for text on it, `--accent-hover`), `var(--font-display)`, `var(--font-body)`,
   `var(--font-mono)`, `var(--text-*)`, `var(--space-*)`, `var(--radius-*)`. No colour or font literal outside the
   block.
3. Keep DESIGN.md's rules: how often the accent appears, which weights the type uses, corner radii, shadows or none.
4. Proprietary faces (Söhne, Cereal, SF Pro) will not load in the artifact; the stacks fall back to system fonts. When
   DESIGN.md names a Google Font stand-in, load it with a `<link>` to fonts.googleapis.com.
5. Check the result with `screenshot` at 390 and 1280 px.

**Office files** (officecli, with its `officecli-pptx`, `officecli-docx` or `officecli-xlsx` skill):

1. `node <this folder>/systems.ts tokens <id>` gives plain values. Office takes colours as hex without `#`
   (`--accent: #533afd` → `color=533AFD`). A value that is not a plain hex (`color-mix(…)`, `rgba(…)`) is mixed by
   you: work out the hex.
2. Slide or page background `--bg` (or `--surface` for panels and cards), body text `--fg`, secondary text `--muted`,
   rules and table borders `--border`, titles and highlights `--accent` (sparingly, as DESIGN.md says), charts from
   `--accent` then the system's other named colours in DESIGN.md section 2.
3. Fonts: the first family of `--font-display` for titles and of `--font-body` for text, set on every shape. When it
   is proprietary, use DESIGN.md's stand-in, or a common face of the same kind (a geometric sans, a serif), and say so.
4. Sizes: keep the type scale's ratios (`--text-4xl` / `--text-base`) at Office sizes, and the spacing rhythm.
5. Check the file with `screenshot` (path to the .pptx/.docx/.xlsx).

## The person's own

They live in the folder `list` names ("yours in …"), one folder per system, named by its id (lowercase letters,
digits, hyphens). When the person asks for one of their own (their brand's colours and fonts, from what they give
you), write the same three files there, modelled on a bundled one (`show` gives its paths): a `manifest.json` with
`schemaVersion` `od-design-system-project/v1`, `id` (the folder's name), `name`, `category`, `description` (one line:
the look), `source` and `files`; a `tokens.css` whose `:root` binds every token the bundled ones do; and a DESIGN.md
with the same sections. Never invent a brand's values: use what the person gives, and say what you chose to fit.

`node <this folder>/systems.ts check <id>` says whether one is complete. A folder there that is not a design system
is listed under "Not a design system" with what it lacks: tell the person, or fix it if you wrote it.
