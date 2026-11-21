# Three directions: three good designs, not three skins

An optional process for choosing a direction by building three real drafts and letting the person pick. Adapted for
pi-phone from huashu-design (see the footer).

## When to run it

- A **new brief in the editorial register** (a landing page, a site, an app, a deck or a poster someone will keep or
  pass along), or
- the person **asks for options** ("show me a few directions", "give me versions").

Not for workmanlike work (plans, reports, a fix to an existing page), not when the project already has a design system
or a pinned look to follow, and not when the person says one version is enough. Three drafts cost three builds: on the
phone, keep each draft to what a choice needs (the first screen and one more section; two representative slides for a
deck; two screens for an app).

## Why it works this way

Three lessons from blind tests of this process:

1. **Three skins of one skeleton.** Three versions that only change colours and weights are one design. The
   difference has to be in the layout's structure.
2. **Forced metaphors lose.** Making every version one big metaphor (a filing cabinet, a library card, a subway map)
   lost three of four blind picks.
3. **Bans make things bland.** Banning familiar looks pushed all three towards the same pale, tidy grid. A look family
   (warm paper and a serif, dark with one accent, hairline newspaper) is not a flaw on its own: it is one only when two
   drafts share it, or when it repeats what was delivered recently. Add options; don't add bans.

## 1. Ask once

One `interview`, at most three questions (audience, the one message, the mood, the output format and size), and in
the same form every reference at once: the project's name, logo, brand colours, fonts, a site or a screenshot with
"that feeling". "Your call" is a fine answer. With no answer, go on and write what you assumed (see section 6).

A named brand or product (one with a site that has a logo) brings its real assets into all three drafts: the drafts
differ in interpretation, not in assets. A plain subject (coffee, history, running) is not a brand: don't hunt for its
logo.

## 2. Restate, then fix the spec

Say in your own words what is really needed: the audience, where it is seen, the mood, what the person expects without
saying it. End with "I'll build three real versions to choose from", never with "which direction do you want?": a
choice made before seeing anything is not a choice.

Then write a short spec, the shared input of all three drafts: what it is, for whom, the points to make, the mood, the
**output format and size (the same for all three, or they can't be compared)**, constraints, the images it needs. The
spec says what to say, never what it looks like: that is the direction cards' job.

## 3. Materials first

Get the images the content needs and the logos of named products before any draft, shared by all three
(`references/materials.md`). One draft with real pictures and two with colour blocks is not a comparison of designs.

## 4. Six candidates, six cards, three picks

First read what to avoid: the look ledger (below) and any taste notes the person left.

**Three logics, two candidates each:**

- **The best designer for this brief, twice.** With no budget limit, which studio or designer in the world fits this
  person and this subject best? Pick two of different temperament (one bold, one restrained; or one Western, one East
  Asian), and design with their thinking, never a copy of one of their works. Reach past the usual three names: beside
  Pentagram, Kenya Hara and Vignelli there are Lü Jingren, Kohei Sugiura, Ikko Tanaka, Kazunari Hattori, Irma Boom,
  Experimental Jetset, Collins, Studio Dumbar, and more.
- **A real reference in the same medium, twice.** Two real works you are sure are excellent, **in the same medium** as
  the brief: an app for an app (Apple Design Awards, App Store Awards finalists), a site for a site (Awwwards of the
  year, a brand's own site), publications and proposals for a deck, newspaper graphics (SND, Malofiej winners) for an
  infographic. Cross-medium references (a deck made into a book cover) came out either overdone or dull. Check it exists
  with `web_search`, then **look at it**: `screenshot` with its `url`, or Pi's browser and `browser_screenshot`. Measure
  instead of describing: the grid's columns, the headline-to-body size ratio, the main colour's share of the area, how
  images and text sit together (in Pi's browser, the `brand-extract` skill's `measure.js`, given whole as `browser_eval`'s expression, answers a
  page's colours, type and spacing with how much of the page uses each).
  When it can't be seen (blocked, a WebGL page that renders black), use a press page of the same work or ask the person
  for a screenshot; failing that, write "not seen" on the card. Never pretend.
- **A random pick, twice.** Take the clock's seconds S (`date +%S`) and pick entry `S % N + 1` from the section of
  `references/styles.md` for the medium you deliver (N entries: 20 for Web, Slides and Infographics, 12 for App, 8 for
  Carousel), and a second the same way from its East Asian section (12). Open the section's overview sheet
  (`assets/sheets/<section>.jpg`, with `read`) and see the pick done well before writing its card; the `design-system`
  skill's tokens fit where the entry names a system. A pick in the same look family as one of the last three
  deliveries moves to the next entry. The point of the random pick is to take you somewhere you would not go by
  yourself.

Every candidate with a source borrows one layer, not the whole: read `references/borrowing.md` before writing cards.

**A named style or brand.** The six candidates are six interpretations inside it; colours may all come from the brand,
and the drafts differ in skeleton. The random pick draws only from styles that fit. "Apple style" is a context, not a
design.

**Six direction cards**, one short paragraph each, in your working notes (not shown as a page):

| Field | What to write |
|---|---|
| Logic and source | Which designer, which work (with the address and your screenshot), or which pick |
| Borrowed | The one mechanism taken, in a sentence with none of the source's looks, with the numbers you measured |
| Not borrowed | What of the source's expression is left out (its colours, type, shapes), and where this design's colours, type and shapes come from in the subject |
| Hero material | What the eye lands on: a real photo, a generated image, a procedural texture, data as an image, huge type |
| Skeleton | The layout's structure in one sentence |
| Where the daring goes | The one boldest thing; everything else serves the content |
| Form from content | One sentence: what in this design only this subject could have |

No thumbnail page: a card too vague for its reader to picture the first screen means the candidate is not thought
through. Rewrite it from another source.

**Pick three to build**, by these tests in order:

1. **Good on its own.** A card that cannot name its hero and skeleton will not become a good draft.
2. **Different from each other.** Different skeletons, different temperatures, not two in one look family.
3. **Not what was delivered recently** (the look ledger).
4. **Not overdone.** Making the whole page a prop or a replica, a universal metaphor (subway map, terminal, newspaper
   front page, dashboard), everything at full saturation and size: at most one of three, and only when the content
   needs it. Test: take the device away. If the information gets clearer, it was too much.
5. **The remake test**, after building (in `references/borrowing.md`).

The three need not be one per logic: two designers and one random pick is fine. Keep the other three cards for the
presentation.

An example (a three-generation soy sauce brewery's site):

- Designer, Kenya Hara. Borrowed: wide empty space, the material itself as the hero, very few words. Hero: real photos
  of the clay vats and the drying yard. Skeleton: one image and one sentence per screen, a slow vertical pace. Daring: a
  full first screen of salt-crust close-up. Form: the sauce ages 180 days, so the pace slows.
- Real reference, an award-winning site of an old Japanese food house (screenshot attached). Borrowed: a vertical title
  column beside horizontal text (the title column 18 % of the width), two colours only, the second under a tenth.
  Not borrowed: its vermilion, its washi ground, its Mincho face; this time the colours come from the vats' glaze and
  the salt, the type is a Song serif. Hero: bottle photography and the vertical title. Skeleton: vertical title left,
  three columns right. Daring: only two colours. Form: the feel of an old house's recipe.
- Random pick, media brutalism. Borrowed: extreme type-size contrast and a modular grid. Hero: one huge character for
  "sauce" cut by the first screen's edge. Skeleton: a modular grid, image and text alternating. Daring: the size
  contrast. Form: one character tells a whole brewery.

## 5. Build, then one round each

Build each draft from the spec and its own card only, never looking at the other drafts (a subagent each when you have
them; otherwise one after another, reading only the spec and that card before each).

- The person's real content, the same in all three; only the design changes. No lorem ipsum.
- Legibility floor: web body 14 px or more, labels 12 px or more; deck body 24 px, labels 16 px; a 1080-wide image
  read on a phone, body 36 px, labels 28 px; body text contrast 4.5:1 or more. Empty space is composition, not
  missing content.
- Self-contained single-file HTML, images embedded or from full URLs.
- A multi-screen app draft is a presentation board, not a row of phones.

Then one polish round per draft before anyone sees it: `screenshot` at 390 and 1280 px, look screen by screen, write
the worst three problems, fix those three. A first screen that doesn't stand, a missing hero, and the same cards all
the way down are fixed before showing. Then the layout check's must-fix kinds go to zero (the `ui-verify` skill).
If two drafts turn out alike, swap one for a spare card or change its skeleton, not its colours.

## 6. Show, then stop

Publish each draft with the `artifact` tool, and ask with one `interview`: for each draft an `info` question with its
screenshot (`media` image) and its card in brief (logic and source, borrowed, hero, form from content), then one
`single` question to choose, with "mix: say which parts" possible through Other. Mention the three cards not built in a
sentence: "these are spares; say if one should become a draft". Then stop and wait, also in a session nobody watches.

**When the person picks:**

- Record what was shown and their words in the look ledger, and any remark about taste ("too plain", "not AI at all",
  "more like a magazine") word for word with what it applies to.
- A mix ("A's layout with C's colours") is done as asked; record which parts were mixed: that says more than which
  colour won.
- Then build the chosen direction in full without stopping at every step. Deliver with a sentence on where its form
  comes from in the content.

## Without the three directions

Any page, screen or slide, before building, answers five questions: its role in the story (hero, transition, data,
quote, close), the viewing distance (a phone at 10 cm, a laptop at 1 m, a projector at 10 m: this sets size and
density), its temperature (quiet, excited, calm, authoritative, gentle, sad), its capacity (will the content fit?), and
its motif (what only this subject has; no answer means the look is still a style label). For a large job not run
through directions, put the assumptions, open questions and placeholders in a comment at the top of the first HTML and
show it early: that is when a wrong direction costs least.

## The look ledger

A record of how delivered designs looked, so the next one does not repeat them, kept in the wiki: find it with
`wiki_query` ("design look ledger"); with none, create `areas/design-look-ledger` with `wiki_write`. Before choosing
a direction, read its last lines and avoid the look family, display face and ground of the last three deliveries
unless the brief or a brand calls for them. After each delivery, add one line with `wiki_edit`:

`date · session · what (artifact id or file) · look family · ground · display face · body face · 2-3 main colours · skeleton · sources`

The person's remarks on taste go on the same page, word for word, with the date and what they apply to.

---
Adapted for pi-phone from `references/directions.md`, `references/workflow.md` and `references/evolution.md` of
[huashu-design](https://github.com/alchaincyf/huashu-design) by alchaincyf (花叔), commit `c4cc219`, MIT. See
`third_party/huashu-design/`.
