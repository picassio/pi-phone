# huashu-design's ideas, adapted for pi-phone's design skills

**Where they come from.** [huashu-design](https://github.com/alchaincyf/huashu-design) by alchaincyf (花叔 · 花生), at
commit `c4cc21943a8026d2d7aa33bd56b72b5be1926923` (2026-11-20, v3.4.2). Copyright 2026 alchaincyf, licensed under the
MIT License since 2026-05-14 (see `LICENSE`, upstream's copy). One exception upstream: the demo stickers in
`assets/style-specimens/xhs/_kit/stickers/` are PolyForm Shield 1.0.0; pi-phone takes none of them.

**What pi-phone took.** The skill is not bundled: its description is broad enough to compete with pi-phone's own design
skills for every request, and most of its scripts need Playwright and Pillow, which the phone has not. Its ideas were
rewritten in English, in pi-phone's words and tools, into skills pi-phone already ships (research PP-540, wiki
`resources/huashu-design-research`; the owner's choices of 2026-11-21, interview ySX6N7Us). No skill description
changed, so the prompt is the same size. No upstream file is copied except `LICENSE`.

| pi-phone file | From upstream | Ticket |
|---|---|---|
| `third_party/effective-html/skills/design-artifact/references/directions.md` | `references/directions.md` (six candidates from three logics, six direction cards, three drafts, show and stop), `references/workflow.md` (the five form questions, assumptions shown early), `references/evolution.md` (the look ledger, kept here as a wiki page) | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/borrowing.md` | `references/directions.md` ("borrow one layer": problem, mechanism, expression; the remake test) | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/colour-type.md` | `references/design-styles.md` (colour derivation: sample, converge in oklch, argue; chroma by area; cultural context), `references/typography.md` (pairing logic, ten pairings, the overused list, CJK notes), `references/content-guidelines.md` | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/materials.md` | `references/materials.md` (hero material first, the honesty test, the order of image sources, procedural materials) | PP-544 |

**pi-phone's changes.** The process runs on pi-phone's tools: `interview` to ask and to choose, `artifact` to show,
`screenshot` (with a URL) and Pi's browser to see a reference, `browser_eval` with brand-extract's `measure.js` to
measure it, `image_generate` and Wikimedia Commons' API for images, the wiki for the look ledger and the person's taste.
Upstream's scripts (`ref_board.py`, `ref_card.py`, `polish.py`, `design_lint.py`, `learn.py`, `fetch_images.py`,
`gen_image.py`, `capabilities.py`) are replaced by those tools or left out. The three directions are optional (a new
editorial brief, or when the person asks for options), not upstream's gate on every design; drafts stop at what a
choice needs. Upstream's gate files (`direction-approved.md`), its version check, its Codex and other harness notes,
and its sibling-skill suggestions are left out. Each pi-phone file ends with a line naming its upstream sources.

**Updating.** There is nothing to sync: to take a later idea, read it in a clone of
[alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design), rewrite it into the file above, and record
the new commit here.
