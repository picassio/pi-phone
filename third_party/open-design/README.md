# OpenDesign's design systems and skills, for pi-phone

From [nexu-io/open-design](https://github.com/nexu-io/open-design) (Apache-2.0, see `LICENSE`; the repository has no
NOTICE file) at commit `fa19ff40e34dd50a9b01888b0339a1b2e1e68cc7` (2026-10-29). `scripts/sync-open-design.ts` copies
everything here from a clone at that commit; nothing here is edited by hand.

## Design systems (`design-systems/`)

All 152 of upstream's `design-systems/<id>/` packages, but only their `DESIGN.md` (the design prose), `tokens.css`
(the compiled CSS custom properties) and `manifest.json` (id, name, category, provenance): about 2.8 MB. The previews
(`preview/`, `components.html`), the 17 translated `DESIGN-*.md`, `design-tokens.json`, `tailwind-v4.css`,
`USAGE.md` and `source/` are left out (about 37 MB). A manifest may still name those files; pi-phone reads only the
three above.

`design-systems/index.json` is written by the sync script: each system's id, name and category (its manifest's) and a
one-line summary, the first line under its DESIGN.md's title that is not its category or surface. pi-phone's
`design-system` skill (`src/design/skills/design-system/`) lists and searches it, with the person's own systems
(`<data>/design-systems/<id>/`, in the same shape), and the app's Design system setting picks a
default (`src/server/design-systems.ts`).

Upstream calls them "OpenDesign curated" and synced from the `getdesign` npm package. Many are "inspired by" a
company's public site (Stripe, Airbnb, …): they describe a look, and pi-phone uses them as style references only. The
companies' names and marks remain theirs; a design system gives no right to their logos or trademarks.

## Kept skills (`skills/`)

Each folder is upstream's whole, with the skill's own licence file. Chosen in PP-242 from the 69 upstream folders that
ship a licence file. Left out: the 128 skills that only name an `upstream:` source without a licence file; those that
duplicate pi-phone's own (`pptx`, `docx`, `pdf`, `slides`, `frontend-design`, `web-artifacts-builder`, and what
Effective HTML and OfficeCLI cover); those that need fal, Replicate or Venice keys, or the OpenDesign daemon.

| Skill | Upstream folder | Original source | Licence |
|---|---|---|---|
| `html-ppt-zhangzara-signal` | `design-templates/html-ppt-zhangzara-signal` | [zarazhangrui/beautiful-html-templates](https://github.com/zarazhangrui/beautiful-html-templates) `templates/signal` | MIT, © 2026 Zara Zhang |
| `html-ppt-zhangzara-blue-professional` | `design-templates/html-ppt-zhangzara-blue-professional` | same, `templates/blue-professional` | MIT, © 2026 Zara Zhang |
| `html-ppt-zhangzara-monochrome` | `design-templates/html-ppt-zhangzara-monochrome` | same, `templates/monochrome` | MIT, © 2026 Zara Zhang |
| `html-ppt-zhangzara-editorial-tri-tone` | `design-templates/html-ppt-zhangzara-editorial-tri-tone` | same, `templates/editorial-tri-tone` | MIT, © 2026 Zara Zhang |
| `html-ppt-zhangzara-neo-grid-bold` | `design-templates/html-ppt-zhangzara-neo-grid-bold` | same, `templates/neo-grid-bold` | MIT, © 2026 Zara Zhang |
| `gsap-core` | `skills/gsap-core` | [greensock/gsap-skills](https://github.com/greensock/gsap-skills) at `aed9cfd3` | MIT, © 2026 GreenSock |
| `gsap-timeline` | `skills/gsap-timeline` | same | MIT, © 2026 GreenSock |
| `gsap-scrolltrigger` | `skills/gsap-scrolltrigger` | same | MIT, © 2026 GreenSock |
| `gsap-plugins` | `skills/gsap-plugins` | same | MIT, © 2026 GreenSock |
| `gsap-performance` | `skills/gsap-performance` | same | MIT, © 2026 GreenSock |

The deck templates are self-contained HTML decks (`example.html`, Google Fonts only). The GSAP skills cover the
skill text only: the GSAP library itself, loaded from a CDN by the pages Pi makes, has its own licence (GreenSock's
standard "no charge" licence).

pi-phone offers them to Pi in every session on the phone while its Design & video extension is on (the default;
`DESIGN_SKILLS` in `src/server/design-systems.ts`), after the owner's own skills, so a skill of theirs by the same name
comes first.

## pi-phone's change

- Each kept `SKILL.md` gets one note after its front matter, marked `<!-- pi-phone: added ... -->`: publish with the
  `artifact` tool (the decks: instead of upstream's `<artifact>` tags), keep pages self-contained, check them with the
  `screenshot` tool; for GSAP, load it from jsDelivr at a pinned version.
- A deck template's `description` is replaced by one written from its `template.json` (name, tagline, occasions):
  upstream's describes an example deck's subject ("OpenDesign's strategy memo: …"), which would make Pi pick it for
  that subject rather than for its look.

Nothing else is changed. To update: change `COMMIT` in `scripts/sync-open-design.ts`, run it on a clone at that
commit, check that every kept skill still ships its licence, and update this file.

## Not taken

OpenDesign's `skills/brand-extract` (under this repository's Apache-2.0) drives its daemon's browser; a pi-phone
brand-extract (PP-240) waits for Pi's `browser_eval` (PP-244) and would credit its method here. OpenDesign's
`design-md` skill only points to an upstream without a licence file (google-labs-code/skills): nothing is taken from it.
