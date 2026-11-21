# App paradigms, and the board that shows them

For an app or mobile prototype: eight paradigms to think with while you find its form, and how to present several
screens. On a web page that could borrow from apps, read each paradigm's "On the web". They are a reference, not a
quota: no prototype has to use one, and three directions need not take one each. When the subject grows its own
form, use that.

## Where this comes from, and how far to trust it

- The 90 finalists of the 2025 and 2026 App Store Awards (Apple Newsroom and the developer site): store screenshots of
  89 of them, 1,572 pictures, all looked at by upstream (games only their first few), gathered in November 2026.
  2025 winners are marked ★; the 2026 winners were not out yet.
- Only store screenshots and a few preview videos, no hands-on use. So this covers what can be seen (the main
  screen's form, the visual system, how data is drawn, the voice of the copy), not flows, empty states, gestures or
  real motion.
- A finalist is not always a visual benchmark: some were chosen for their community or social value, with near-default
  controls. The apps named below are the ones that make that paradigm clear.
- **Borrow one layer, not the whole.** A paradigm is a mechanism (the interface is a place; progress is a shape of its
  own; a day is a line with lengths): borrow it. The named apps' palettes, type, shapes and illustration are their
  expression: leave them. Taking "a big number over a row of pills" from an app is borrowing; taking its blue ground,
  yellow pills and tick marks too is copying. Borrow across categories where you can, and run the remake test
  (`design-artifact`'s `references/borrowing.md`).
- The screenshots belong to their developers. Look at them on the store (`screenshot` with the store page's `url`,
  `https://apps.apple.com/us/app/id<id>`, ids at the end); never put them in the work.
- The overview sheet, `design-artifact`'s `assets/sheets/paradigm.jpg`, shows one invented screen per paradigm
  (subjects and data made up, not a copy of any app).

## Ask one question first

Almost none of the best apps of these two years opens on "a nav bar, a list of cards and five tabs". Each first
answered: **what does the thing this app looks after look like in the real world?** A day is a timeline with lengths,
a tide is a curve, a camera is a machine with levers, drinking water is the level in a jug. The interface grows from
that shape; controls come after. Ask it of the subject, then see which paradigms apply.

## The eight paradigms

### 01 The world is the interface
The whole screen is a place or an object, and the features are things in it, not controls floating over it.
- **Seen in:** (Not Boring) Camera (2026): the screen is the back of a camera, the viewfinder set into the body, the
  flash a lever; no nav bar, no pages. Focus Friend ★ (2025): an isometric room, the timer an object in it; while you
  focus, everything greys but the character and the countdown. Raylie (2026): a flight is the view from the window,
  with a glass card saying "Sunset 17:05 · right side".
- **Ask:** can the main screen be a place or a thing? Which object there is the thing the person came to do?
- **Not for:** dense information to scan and compare (bookkeeping, mail): twenty rows do not fit in a world.
- **On the web:** the first screen is not a layout about the product but the scene where it works; navigation can be
  things in that scene.

### 02 A signature object
One control or graphic made for this app alone, recognised in any screenshot; the rest can stay plain.
- **Seen in:** GO Club (2025): progress is a solid yellow capsule followed by fine ticks, done solid, to-do ticks;
  water is the level in a jug with the percentage over it. (Not Boring) Camera: manual focus is an orange gear ring
  around the viewfinder. Tiimo ★ (2025): the focus timer is a ring around a small illustrated object.
- **Ask:** what does the person touch most every day? Make that look like nothing else, and make it 120 %.
- **Not for:** copying the object onto every screen. It belongs to the one thing it does.
- **On the web:** one signature interaction for the whole site (a demo you can turn, a progress of its own) beats a
  little motion in every section.

### 03 Time has a shape
A day, a week, a journey is not a list but a shape with lengths and rises.
- **Seen in:** Structured (2025): tasks are capsules on a vertical timeline, their length the duration, gaps visible.
  Tiimo ★: the day in four parts (any time, morning, day, evening). Raylie: the flight an arc with a moving point, the
  sun's path another. Moonlitt (2026): the moon walks a dotted orbit, each day of the calendar a phase.
- **Ask:** what shape is this data in reality? Capsule, ring, orbit, curve, water level, a week as a line: let the
  shape speak, the numbers to the side.
- **Not for:** where people must check exact numbers (reconciling, expenses): shapes give a feeling, tables give
  precision.
- **On the web:** pricing, processes, roadmaps, comparisons: find the shape before the table.

### 04 One set of meaning colours
Colour answers one question across the whole app, and a colour means the same thing everywhere.
- **Seen in:** Bevel (2026): strain, recovery and sleep each have a colour, and the ground turns to it in that part:
  colour says where you are, down to the store images' titles. Hearing Buddy (2026): captions tagged by kind (asked of
  you blue, your name pink, summary green). Paste (2026): a colour band on top of each clip for its type. Strava ★
  (2025): on black, orange only for the route and the key numbers.
- **Ask:** what must the person tell apart at a glance? Colour does that one job; everything else is neutral.
- **Not for:** a colour per category for looks, with no judgement resting on it.
- **On the web:** colour on the site has one use and one only (status, category, or "press here"); decoration colours
  do not count.

### 05 The content is the interface
The interface has almost no colour or shape of its own; it gives everything to the content.
- **Seen in:** Cosmos (2026): an off-white ground, one search field, a wall of images; searching by colour turns the
  whole page, ground included, that colour. Museas (2026): one painting full screen, the interface a pill and two small
  buttons in a corner. Detail ★ (2025): every colour comes from the person's video, tools as glass floating over it.
  HBO Max ★, Letterboxd: posters are the interface; a genre page takes on its key image's colour.
- **Ask:** take every interface element away and leave the content: does the screen still stand? Then add back only
  what is needed.
- **Not for:** content that is not beautiful (forms, settings, text tools): there the interface needs a character.
- **On the web:** portfolios, media, product pages: take the ground and accents from the content, not from a brand
  colour laid over it.

### 06 AI lands on the object
The result of the intelligence appears on the thing the person was already looking at, not in a separate chat.
- **Seen in:** Karrot (2026): take a photo, and the title, description and category fill the listing form. Hearing
  Buddy: the AI tags each caption ("asked of you", "your name") and sums up a conversation. Tiimo ★: say a sentence,
  get task cards ready for the timeline. Brilliant (2026): the tutor is a small character in a corner saying one line
  at a time; the problem stays the hero.
- **Ask:** on which existing thing should this result grow? How does the person see at once that it is unsure, and fix
  it in one move?
- **Not for:** showing off "it has AI": sparkle icons, gradient glows, a chat box taking half the screen. Many
  finalists were AI products; almost none made a chat box the main screen.
- **On the web:** demo an AI feature with the thing it changed, before and after, not a fake conversation.

### 07 A character carries the state
A character's look tells the state; the numbers step back.
- **Seen in:** StressWatch (2026): stress is a face, and the character over the same data can change (round face, cat,
  bear): a skin, not the data. Focus Friend ★: whether the bean is knitting is whether you are focusing. Hearing Buddy:
  a set of companions to choose from. Kiddopia (2026): a parent's report opens not with numbers but "your child is
  becoming a little maker".
- **Ask:** if this state were a face, what would it look like now? Each look comes with "so, what to do".
- **Not for:** a mascot stuck in a corner: a character that does not change with the data is a sticker. Careful in
  serious or high-stakes places (medical readings, money).
- **On the web:** empty states, loading, success and failure are the four best places for a character with a state.

### 08 Access shapes the form
Design for the person who struggles most first; the layout follows, and works better for everyone.
- **Seen in:** Be My Eyes ★ (2025): one screen is one button, in one blue. Hearing Buddy: the product turns sound into
  something seen. Art of Fauna ★ (2025) and PBS KIDS Video (2025) gave accessibility options a store image of their
  own, as a selling point. Tiimo ★'s sections and icons for neurodivergent people serve everyone.
- **Ask:** what does the person who struggles most (who cannot see well, cannot hear, has one hand free, stands in the
  sun, is running) need this screen to be?
- **Not for:** nothing. It is a starting point, not a style; it pushes toward large type, high contrast and one task
  per screen, which is right.
- **On the web:** one main action per screen; a state said by a shape or a word as well as by colour.

## Three more, for every direction

- **Type is the voice.** No standout app of these two years used the system face throughout. Tiimo sets weekdays in
  a serif; GO Club writes in rounded bold lower case with full stops; chilli slips one italic serif word into lower
  case sans; Unedo uses an extra-bold rounded face; (Not Boring) Camera labels in small uppercase mono. Decide how the
  app speaks first, then pair faces (`design-artifact`'s `references/colour-type.md`).
- **Copy takes a stance.** Unedo: "Tired of Spanish apps made only for beginners? So were we." (Not Boring) Camera on
  privacy: "Nothing collected. Nothing stored. Nothing shared." Raylie: "Which window has the sunset?" Buttons, empty
  states and hints too: write what only this product would say, never "Welcome" or "Get started".
- **Words before numbers.** Bevel writes "below normal" beside a metric, the range under it; Raylie says "right side",
  not a bearing; GO Club shows one big number per screen. Beside every number ask: does the person know whether it is
  good, and what to do?

## What these two years almost never showed

A check list in reverse: the purple-blue "AI" gradient, a chat box as the main screen, a coloured icon on every card,
five tabs of equal weight, one system face throughout, frosted glass everywhere. iOS 26's Liquid Glass appears on
floating toolbars and bottom capsules (Detail, Raylie): a layer over the content, not the material of the whole
screen.

## Watch, TV, spatial

For those screens only:
- **Watch:** one screen is one big number and one shape (GO Club, Strava ★, Bevel); the ground colour says the state.
- **TV:** one picture fills the screen, text at the lower left, navigation a column of small icons on the left edge
  (HBO Max ★); secondary data such as ratings drawn very small (Letterboxd).
- **Spatial:** put data back in the place: MLB draws a pitch's angle on the real field, Museas sets works in a built
  space, Moonlitt makes the moon calendar a small object on the desk.

## The presentation board

A prototype of several screens is shown on a board, never as five or six equal phones in a row: in upstream's blind
tests, whatever the direction, an even row was called "too regular, boring". The board is the direction's first
poster and needs design of its own:

| Move | How | For |
|---|---|---|
| Lead and follow | The screen that best says what the app is, 1.2–1.4× larger at the centre; the others smaller, staggered around it at different heights | Almost always; the first choice |
| A flow | Screens in the order of a real task, a thin line from "tapped here" to "went there", the note on the line | Apps with one main task (ordering, logging, a trip mode) |
| A close-up | Beside one screen, its key component at 2–3×: the signature interaction, a data drawing, a crafted control | An app with one detail worth remembering |
| A ground of its world | The board's background is where the app is used: a real picture, the subject's colour, its material, not a white canvas | Subjects with a strong scene (outdoors, kitchen, night) |
| The board's own type | A title area with the app's name, one line of what it is, and labels for each screen, in the direction's own type and colours | Always |

Three rules: the board's ground and type follow the direction (a dark direction gets a dark board, not a white
canvas); every phone still works (each its own small state: tabs switch, buttons and cards respond, a sheet opens);
no screen shrinks until its text is unreadable (each phone 300 px wide or more on a desktop). On a phone's width, the
board becomes one column: the lead screen first, at full width, the rest after it. Three directions' boards differ in
composition too: the difference most often forgotten.

Before delivering, tap through it: open a detail, a key control, a tab switch on each phone (`screenshot` with
`steps`), and check the layout check reports nothing thrown or logged.

## Store ids

For looking at a finalist's screenshots (`https://apps.apple.com/us/app/id<id>`). Apps only, no games; US store.

| App | id | Year · category |
|---|---|---|
| BandLab | 968585775 | 2025 · iPhone |
| LADDER | 1502936453 | 2025 · iPhone |
| Tiimo ★ | 1480220328 | 2025 · iPhone |
| Detail ★ | 1673518618 | 2025 · iPad |
| Graintouch | 6740813845 | 2025 · iPad |
| Structured | 1499198946 | 2025 · iPad |
| Acorn | 6737921844 | 2025 · Mac |
| Essayist ★ | 1537845384 | 2025 · Mac |
| Under My Roof | 1524335878 | 2025 · Mac |
| Camo Studio | 6450313385 | 2025 · Vision |
| D-Day The Camera Soldier | 6737838494 | 2025 · Vision |
| Explore POV ★ | 6479555991 | 2025 · Vision |
| GO Club | 6739782103 | 2025 · Watch |
| Strava ★ | 426826309 | 2025 · Watch |
| HBO Max ★ | 1666653815 | 2025 · TV |
| PBS KIDS Video | 435138734 | 2025 · TV |
| Art of Fauna ★ | 1630468596 | 2025 · Cultural Impact |
| Be My Eyes ★ | 905177575 | 2025 · Cultural Impact |
| Focus Friend ★ | 6742278016 | 2025 · Cultural Impact |
| Retro | 6443709020 | 2025 · Cultural Impact |
| StoryGraph ★ | 1570489264 | 2025 · Cultural Impact |
| Whoscall | 929968679 | 2025 · Cultural Impact |
| Yuka | 1092799236 | 2025 · Cultural Impact |
| ElevenReader | 6479373050 | 2026 · iPhone |
| (Not Boring) Camera | 6737783441 | 2026 · iPhone |
| Raylie | 6793443320 | 2026 · iPhone |
| Cosmos | 1577975475 | 2026 · iPad |
| Kiddopia | 1223397201 | 2026 · iPad |
| Mockup | 1527554407 | 2026 · iPad |
| Paste | 967805235 | 2026 · Mac |
| Things 3 | 904280696 | 2026 · Mac |
| Ulysses | 1225570693 | 2026 · Mac |
| Adobe Premiere | 6742757464 | 2026 · Vision |
| MLB | 493619333 | 2026 · Vision |
| Museas | 6496682427 | 2026 · Vision |
| Bevel | 6456176249 | 2026 · Watch |
| Moonlitt | 6444718902 | 2026 · Watch |
| StressWatch | 6444737095 | 2026 · Watch |
| Case Solved The London Files | 6769660234 | 2026 · TV |
| Letterboxd | 1054271011 | 2026 · TV |
| Pocket Casts | 414834813 | 2026 · TV |
| Brilliant | 913335252 | 2026 · Cultural Impact |
| chilli | 1645549437 | 2026 · Cultural Impact |
| Hearing Buddy | 6747363502 | 2026 · Cultural Impact |
| Karrot | 1018769995 | 2026 · Cultural Impact |
| setlog | 6587576438 | 2026 · Cultural Impact |
| Unedo | 6503170902 | 2026 · Cultural Impact |

Pro Camera by Moment (a 2025 Watch finalist) could no longer be reached when upstream gathered these.

---
Adapted for pi-phone from `references/app-paradigms.md` and the presentation board of `references/app-prototype.md`
of [huashu-design](https://github.com/alchaincyf/huashu-design)
by alchaincyf (花叔), commit `c4cc219`, MIT. See `third_party/huashu-design/`.
