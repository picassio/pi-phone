# heydamir's unslop skill, for pi-phone

**The skill.** `unslop` by Damir Sokolovsky ([@heydamir](https://x.com/heydamir), who started the Unslopping series on
X; [heydamir.design/unslop](https://heydamir.design/unslop)), from [heydamir/unslop](https://github.com/heydamir/unslop)
`skills/unslop/` at commit `1d13095e4bef6ad6c74f1dd828d84c4ba309a4dc` (2026-11-01). Licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) (see `LICENSE`, upstream's copy of the licence).

It turns AI-looking UI into a designed one: render and look, audit against `references/signs.md` (sign → fix), decide
heavy slop, light slop (polish mode) or none, a five-line direction that waits for the person's answer, then nine
passes (spacing, color, icons, copy, type, layout, details, visuals, motion), a re-render and a report, and optionally
a short story video. The folder is copied whole: `SKILL.md`, `agents/openai.yaml`, `references/` (signs, tokens,
visuals, effects, refs and its five webp reference screens) and `scripts/` (`snapshot.mjs`, `story.mjs`, both Playwright).
Upstream's `examples/` (dashboard.html, hero.html), README and CITATION.cff are not copied.

`scripts/sync-unslop.ts` copies it from a clone at that commit (it refuses another commit or local changes).

## Where pi-phone offers it

The **Design & video** built-in extension (`extensions/design.ts`, on by default) owns it: phone and server sessions
list the skill while the extension is on (`DESIGN_SKILLS`), and none do while it is off. Effective HTML's
`design-artifact` points to its `references/signs.md` before a UI or artifact is called done.

## pi-phone's changes

Modified by pi-phone: one marked note. `SKILL.md` gets one note after its front matter, marked
`<!-- pi-phone: added ... -->`: look with the `screenshot` tool (or Pi's browser on a machine) and never run
`snapshot.mjs` on the phone; ask the direction question with `interview` and show mockups as an `artifact`; the
project's own icons (pi-phone's `ICONS`), never emoji, and pi-phone's tokyo-night palette or a chosen design system as
the brand (polish mode only); images with `image_generate`, asked first; the story video only on a machine, checked
with the `media` tool, keeping its "unslop by @heydamir" credit; and its step 6 (Check) follows pi-phone's `ui-verify`
skill (`src/skills/ui-verify/`, PP-405).

Nothing else is changed: the credit lines in `SKILL.md` and each reference's footer stay as upstream wrote them. To
update: change `COMMIT` in `scripts/sync-unslop.ts`, run it, read the new `SKILL.md` against the note, run
`test/unslop.test.ts`, and update the commit above.
