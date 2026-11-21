# huashu-design's ideas, adapted for pi-phone's design skills

**Where they come from.** [huashu-design](https://github.com/alchaincyf/huashu-design) by alchaincyf (花叔 · 花生), at
commit `c4cc21943a8026d2d7aa33bd56b72b5be1926923` (2026-11-20, v3.4.2). Copyright 2026 alchaincyf, licensed under the
MIT License since 2026-05-14 (see `LICENSE`, upstream's copy). One exception upstream: the demo stickers in
`assets/style-specimens/xhs/_kit/stickers/` are PolyForm Shield 1.0.0; pi-phone takes none of them.

**What pi-phone took.** The skill is not bundled: its description is broad enough to compete with pi-phone's own design
skills for every request, and most of its scripts need Playwright and Pillow, which the phone has not. Its ideas were
rewritten in English, in pi-phone's words and tools, into skills pi-phone already ships (research PP-540, wiki
`resources/huashu-design-research`; the owner's choices of 2026-11-21, interview ySX6N7Us). No skill description
changed, so the prompt is the same size. No upstream file is copied except `LICENSE` and the overview sheets; two of
its test pages are adapted as fixtures (both below).

| pi-phone file | From upstream | Ticket |
|---|---|---|
| `third_party/effective-html/skills/design-artifact/references/directions.md` | `references/directions.md` (six candidates from three logics, six direction cards, three drafts, show and stop), `references/workflow.md` (the five form questions, assumptions shown early), `references/evolution.md` (the look ledger, kept here as a wiki page) | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/borrowing.md` | `references/directions.md` ("borrow one layer": problem, mechanism, expression; the remake test) | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/colour-type.md` | `references/design-styles.md` (colour derivation: sample, converge in oklch, argue; chroma by area; cultural context), `references/typography.md` (pairing logic, ten pairings, the overused list, CJK notes), `references/content-guidelines.md` | PP-544 |
| `third_party/effective-html/skills/design-artifact/references/materials.md` | `references/materials.md` (hero material first, the honesty test, the order of image sources, procedural materials) | PP-544 |
| `src/server/layout-check.ts` (kinds `decoration`, `ui-display`, `relative-image`; the report's `logged` and `look`; `skeletonMatch`, `LookMemory`) | `scripts/design_lint.py`: `judge` (the yellow lights: " · " connectors, trailing arrows, small monospace labels, one accent word, 01/02/03, a UI face as display, relative pictures; console errors as a red light), `families` (warm paper with a serif or clay `#D97757`, dark with one accent, hairline newspaper, a card kit), `fingerprint` and `bg_class` (ground, faces), `layout_vector`, `corr` and `similar` (the 32 × 20 skeleton and its correlation) | PP-545 |
| `src/server/file-pages.ts` (`PAGE_SHIM`: `__piFilePage`, `__piConsoleErrors`) | `scripts/design_lint.py`: `collect` (what a page logs as errors, whether it is a single file) | PP-545 |
| `src/server/extensions/screenshot.ts` (a draft reskinned from another shot in the conversation) | `scripts/design_lint.py`: `cmd_compare` (are three directions one layout reskinned) | PP-545 |
| `test/fixtures/layout/huashu-slop.html`, `test/fixtures/layout/huashu-clean.html` | `scripts/tests/fixtures/lint_slop.html`, `lint_reskin.html` (as `?reskin`), `lint_clean.html`; adapted, words in English | PP-545 |
| `src/skills/ui-verify/SKILL.md` (the Look line, the reskin note, decoration as advisory) | `scripts/design_lint.py`'s docstring (red lights to fix, yellow lights cheap to drop, families no fault alone) | PP-545 |

**pi-phone's changes.** The process runs on pi-phone's tools: `interview` to ask and to choose, `artifact` to show,
`screenshot` (with a URL) and Pi's browser to see a reference, `browser_eval` with brand-extract's `measure.js` to
measure it, `image_generate` and Wikimedia Commons' API for images, the wiki for the look ledger and the person's taste.
Upstream's scripts (`ref_board.py`, `ref_card.py`, `polish.py`, `learn.py`, `fetch_images.py`, `gen_image.py`,
`capabilities.py`) are replaced by those tools or left out. `design_lint.py`'s facts run in the layout check every
`screenshot` and `browser_layout_check` already runs, in the page itself, not in Playwright: the skeleton is built from
the DOM's boxes, pictures, controls and words rather than edges in a screenshot, so its reskin threshold is 0.8 (huashu
slop and reskin 0.96, real drafts 0.12 to 0.32, unrelated sites up to 0.56) instead of upstream's 0.55; palette
distance, the em-dash label and the JSONL ledger are left out (the ledger is the wiki page `areas/design-look-ledger`);
its red lights for broken images, small text and contrast were already the check's own. The three directions are optional (a new
editorial brief, or when the person asks for options), not upstream's gate on every design; drafts stop at what a
choice needs. Upstream's gate files (`direction-approved.md`), its version check, its Codex and other harness notes,
and its sibling-skill suggestions are left out. Each pi-phone file ends with a line naming its upstream sources.

**Updating.** There is nothing to sync: to take a later idea, read it in a clone of
[alchaincyf/huashu-design](https://github.com/alchaincyf/huashu-design), rewrite it into the file above, and record
the new commit here.

**The style catalogue (PP-546).** `third_party/effective-html/skills/design-artifact/references/styles.md` rewrites
upstream's `references/design-styles.md` (92 styles: web 20, slides 20, infographics 20, app 12, East Asian 12, carousel
8; its colour protocol is in `colour-type.md` already) in English, numbered as upstream's sheets, with the
`design-system` skill's matching systems named. `.../design-artifact/assets/sheets/` holds the seven overview sheets,
1,231,809 bytes, the only upstream pictures pi-phone ships:

| pi-phone file | From upstream | Licence |
|---|---|---|
| `web.jpg`, `ppt.jpg`, `info.jpg`, `app.jpg`, `east.jpg` | `assets/style-specimens/sheet-<same>.jpg`, as they are | MIT: renders of upstream's own HTML specimens, which load no picture (only Google Fonts and LXGW WenKai, SIL OFL) |
| `paradigm.jpg` | `assets/style-specimens/sheet-paradigm.jpg`, as it is | MIT: two of its tiles show `paradigm/img/balcony.jpg` and `box.jpg`, added with upstream's image generator in `686ee9f` (v3.4.0) with no source of their own and no metadata, so under the repository's MIT like the rest |
| `xhs.jpg` | `sheet-xhs.jpg`, rendered again (`scripts/build_specimens.py xhs`, Chrome) after every bird sticker in `xhs/_kit/stickers/` was replaced by a flat silhouette of the same size in its muted average colour | MIT. The stickers are PolyForm Shield 1.0.0 (huashu-bird-sticker): not one of their pixels ships |

The 92 per-style specimens (`<section>/NN-name.{html,jpg}`, about 12 MB) are left out.
