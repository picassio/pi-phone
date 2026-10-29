# Case study: a 20 s smart-home display spec commercial (Three.js-led, light and dark stages)

An unofficial concept ad for a smart-home display, the day after it was announced, made in the brand's visual language. It is local only, and the end card carries an "unofficial concept, not affiliated" disclaimer. Every frame is code: seven Three.js canvases on one HyperFrames seek clock, with the type drawn on canvas above them. The device, its screen UI, the kitchen and every texture are procedural. There are no brand logos, no brand footage and no people.

The critics said SHIP at v2. The client then asked for changes over seven more versions. **Almost all of them were about sound and pacing**, which is the main lesson of this film.

## Structure (as delivered, 18.5 s)
| Time | Shot | What carries it |
|---|---|---|
| 0–1.5 | the device at night between the words of the title lockup | frame 0 is the finished lockup (the client's pick), with a slow push |
| 1.5–4.5 | four colours side-on on a light stage, tilting one per 8th note | the brand's measured hinge curve; a highlight runs down the row |
| 4.5–7.5 | monogram glass tokens drop through the cover glass; one person's Home Screen becomes another's | "the screen becomes a different person's in one continuous move" |
| 7.5–10.5 | a section cut of the speaker: woofer plus two force-cancelling radiators in mirror | the parts are driven by the music's low band, so the speaker plays the score |
| 10.5–14 | golden-hour kitchen: a touch dims the real pendants, the voice assistant closes the real blinds | the room equals the UI state, frame for frame |
| 14–16 | the slat light carries across the cut onto the wall-mounted model | band angle, pitch and colour matched across the cut |
| 16–18.5 | the end card plays the opening's distance-adaptive feature backwards | bookend |

## Process
- **Component Gauntlet:** a lab, then a critic, then a fix, then a new critic for the device, the UI, every shot, the type system and the music. That was about 60 critic rounds, plus blind tests: our rendered frames mixed with the brand film's stills, for a judge who had to say which was which.
- **A 7-window wow gate:** the 20 s split into 7 windows of ≈ 2.9 s, each of which must be judged YES. PARTIAL fails.
- **Deadline mode:** with 1.5 hours left the client asked for 1080 only. Every in-flight builder got a 20–25 minute hard stop: land what works and revert anything half-done. Then: integrate, render at 1080, one full-film critic, its top 5 fixes in parallel, and a verify critic. Components whose last round wasn't re-verified were listed in the honest limits.
- **At the critics' SHIP (v2):**
  - 6 of 7 wow windows YES; the opening was PARTIAL (small and dark for its first second);
  - the film blind test at 18/20, the first time a judge was fooled;
  - strict frozen time 0.15 s, with 0 single-frame cell pops;
  - −29.9 LUFS.

## What the client caught after the critics said SHIP
Each item was named from one frame or one listen.
1. **"So much empty space"** on the glanceable UI face: tall tiles with the title at the top, the number at the bottom and a dead band between them. Fix: shorter tiles, each number centred between its label and its bar, and a third row whose content matches the headline. The headline said "lights, locks, blinds", so a Locks row went in.
2. **Text over text.** A voice-assistant request faded out while the card under it faded in, so both were readable at once. Fix: the request's words and the orb leave while the frosted sheet behind them is still ≥ 93 % opaque. The critics had checked overlaps on settled frames, not mid-crossfade.
3. **A state label that lied.** The label read "Open" while the percentage counted down. Fix: Open → Closing → Closed.
4. **"Start the video with this frame."** The client didn't want the reveal from the dark; they wanted the finished lockup at frame 0. Then: "the first scene lingers, start from 1.5". Fix: time-remap the shot's own clock rather than rebuilding it (a window offset plus a rate), and shorten the film to 18.5 s.
5. **"The music doesn't match at all… unnecessary sudden cuts… too loud."** This was the music editor's cut: a dead stop before the drop and a spliced final hit. Two rounds of library edits and two rounds of generated scores followed. What finally worked was **a real track back-timed so its own ending lands on the end card, one continuous piece, every cut on its beat**, offered as seven versions to choose from by ear (`audio.md`).
6. **"Every minimal movement should also have a sound."** The film went from 12 effects to 28.
7. **"I don't like that sound"** on the blinds countdown (a textured wood rattle) and on the speaker opening (a swoosh). I removed them, and the client corrected me: **"I meant use clean ones instead of random."** Replace a disliked sound with a cleaner one from the same family; don't delete it.
8. **"The tilt sound should be louder. Maybe we can't even hear it."** The micro-sound rule ("peak at or below the local music peak") had capped the hero's mechanical moves at 2–4 dB under the music's peak. The fix was explicit caps, which put the tilts at about +8–10 dB in-band and the tokens at +7–8.
9. **"A unique sound for the spatial-audio moment… now reduce it a little."** A sub knock plus a stereo-widened swell that peaks as the title lands. It settled at about +4.7 dB in-band.

## Render plumbing this film added
See `product-hero-realism.md` §5. In short:
- devicePixelRatio flips inside a 4K render;
- DOM type re-rasterises in one-frame steps, so the type moved to canvas;
- fonts load lazily;
- readiness has to be registered early;
- a NaN made one black frame;
- hard thresholds on continuous values cause one-frame flashes;
- the fast-capture path dropped a WebGL canvas.

## Delivery hygiene
- **Desktop names:** another session wrote a file with the same name to the Desktop at the same time. Give deliverables names unique to the project, and put each round in its own named folder that opens when it's ready.
- **Git:** the main checkout was on another branch with someone else's uncommitted work. Use a `git worktree` for the film's branch, and scan the staged files for secrets and oversized media before every commit.
- **API keys:** keys pasted into a chat stay in its history; ask for them to be rotated afterwards. An automated agent may (rightly) refuse to read a key file. Give the user one command to run in their own terminal, without the `!` prefix: in zsh a leading `!` negates the command and skips everything chained after it. Mind the plan's concurrency limit; this ElevenLabs plan allowed 2 requests at a time.
