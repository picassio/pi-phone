# Look pass: look, pick the worst three, fix, look again

A first version is a draft. What separates a designer from someone who writes code is the next step: sit back, look
at it, see what is wrong, fix it, and look again. The same model that looks at its own screenshots and fixes three
rounds makes work a grade better than the one that delivers what it wrote first.

Run it on a designed page (an artifact, a landing page, a deck, a report, a prototype) **after the numbers**: the
layout check's must-fix kinds are zero first (this skill's steps 1 to 4), then the eyes.

## How to look

1. `screenshot` the page at 390 and 1280 px, `fullPage: true`, and keep the pictures with `save`
   (`look/round-1.png`; a tall page comes in parts, `-2`, `-3`). Each round gets its own folder name.
2. Look **one screen at a time, at real size**. A whole page shrunk to one picture blurs the type and the spacing, and
   the faults with them. Cut each saved part into screens with `media` (`action: image`, `crop:
   <width>:<screen height>:0:<top>`, 844 px tall at 390, 720 or 800 at 1280) and `read` each crop.
3. A deck does not scroll: one picture per slide (`screenshot` with `steps` such as `[{ press: "ArrowRight" }]`, or
   the deck's own address per slide). A motion piece: the key frames.
4. The layout check's numbers (its Look line, findings, counts) tell you where to look first. They never replace
   looking. A quiet direction with a large share of empty ground meant it: do not fill it to please a number.

## What to ask

Each round, ask these eight questions of every screen, and write down **the worst three** answers, each as "which
screen, which element, what is wrong":

1. **The first screen in three seconds.** Would someone who has never seen this project tell what it is, and for whom?
   Is something only this subject has in that first look?
2. **The hero material.** Is the hero material the direction card named there? Are the pictures the content needs
   present: does a page about an app show the app, does a page about data make the data the picture?
3. **An event on every screen.** Scrolling down, does each screen have one thing that makes you stop, or is it "a
   heading and three cards" to the end?
4. **Hierarchy.** Squint at each screen: is the first thing that jumps out the most important one?
5. **Craft.** Alignment, the rhythm of the spacing, a lone character at the end of a line, ugly breaks, overflow,
   broken images, an element that is not of the same family as its neighbours.
6. **The phone.** The same questions again at 390: not "not broken", but designed for a phone too.
7. **Against the direction card.** Put the screenshot beside its card and its reference (or the style's sheet in
   `design-artifact`): were the rules in "Borrowed" carried out? Where did it drift?
8. **Take one thing away.** Which one element, removed, makes this screen better?

## What to fix

Fix only the worst three in a round, then take new screenshots and look again. Fixing a dozen things at once hides
which change helped, and breaks good parts on the way. Structure first (a first screen that does not stand, missing
hero material, a whole screen that is ordinary), craft after.

A screen that stays ordinary however you look at it: stop patching and rebuild it with another way to organise its
information. Before you do, ask: what would a top studio, given this project, spend three more days on in this
screen?

## How many rounds

| Stage | Rounds |
|---|---|
| Each draft of the three directions (`design-artifact`'s `references/directions.md`) | 1: look, fix the worst three. A draft is for choosing a direction, not for finishing |
| The chosen direction, the version you deliver | At least 2, until a careful round finds no three worth fixing; usually 3 to 5 |
| The person is in a hurry | 1, and say in the delivery that it had one round |

Still rebuilding large parts in round 5 means the problem is the direction or the structure, not the polish: stop,
and tell the person what you see, with two ways to change it (an `interview`, your recommendation marked).

Keep every round's pictures. When you deliver, show the first round's first screen beside the last round's (embed
both), so the person sees what the rounds changed, and name the rounds and the three fixes of each in a line.

A model that cannot see pictures cannot run this pass: run the numbers anyway, and say in the delivery that the work
was not looked at, with the screenshots' paths.

---
Adapted for pi-phone from `references/polish-loop.md` of [huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
