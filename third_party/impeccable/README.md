# Impeccable's detector rules, adapted for pi-phone's layout check

**Where they come from.** [Impeccable](https://github.com/pbakaus/impeccable) by Paul Bakaus
([impeccable.style](https://impeccable.style)), at commit `c8891a9ae865d6ee311836ae5199bfce0fe115b1` (2026-11-05, engine
0.1.18). Copyright 2025 Paul Bakaus, licensed under the Apache License 2.0 (see `LICENSE`, upstream's copy).

**What pi-phone took.** No file of Impeccable is copied. Nine of its detector's 62 rules were reimplemented in
JavaScript in `src/server/layout-check.ts` (PP-415, the owner's choice of 2026-11-06 after research PP-411, wiki
`resources/impeccable-design-skill-research`), the page script the `screenshot` tool and Pi's browser run:

| pi-phone kind | Impeccable rule | What it finds |
|---|---|---|
| `broken-image` | `broken-image` | an image that loaded with nothing to draw |
| `skipped-heading` | `skipped-heading` | a heading level skipped (h1 then h3), outside a footer |
| `nested-cards` | `nested-cards` | the innermost card inside another card |
| `side-tab` | `side-tab` | a coloured stripe down one side of a card: a border, or an inset shadow |
| `glow` | `dark-glow` | a coloured shadow with a soft blur and no offset, or any on a dark background |
| `pulsing-dot` | `pulsing-dot` | a small round dot that animates for ever |
| `justified` | `justified-text` | justified text in a column of 45 characters or fewer, without hyphens |
| `tight-leading` | `tight-leading` | body text over more than one line set tighter than 1.3 |
| `repeated-text` | `repeated-container-text` | the same words in three or more spots of one card |

Kept from Impeccable: the thresholds (stripe 2 px on a rounded box, 3 px on a square one, the other sides at most 1 px
or half as wide; colours with chroma, channels 30 apart; a glow's blur over 4 px, its light, blur × alpha, at least
3, its lit area at most twice its element's; a card as a border or shadow with corners or a background; cards at
least 50 × 30 with 10 characters of words; tight leading under 1.3 on text over 50 characters below 24 px; justified
text at 45 characters a line; repeated words 4 to 48 characters in 3 distinct spots, in cards of up to 250 elements),
the tags and roles each rule passes over, and innermost-only nested cards.

**pi-phone's changes.** The rules are rewritten for one synchronous page script that reads the DOM as it shows (no
Rust engine, no WebAssembly, no headless browser of its own), with fewer of Impeccable's exceptions (its corpus
decisions for mockups, mega menus, control strips, figure and media frames, fine print and bold titles are not all
carried over); findings come grouped with pi-phone's other kinds and their numbers. Impeccable's `NOTICE.md` names
third-party work in its iOS and Android references, none of which pi-phone uses.

**Updating.** There is nothing to sync: to take a later rule or threshold, read it in a clone of
[pbakaus/impeccable](https://github.com/pbakaus/impeccable) (`crates/core/src/`), change `layout-check.ts` and its test
(`test/layout-check.test.ts`), and record the new commit here.
