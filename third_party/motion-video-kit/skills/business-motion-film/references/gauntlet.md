# The Gauntlet loop

Adapted from the Gauntlet Loop idea (somethingbig.ai/gauntlet-loop): separate building from evaluation, compare against an inspectable reference, fix the biggest gap, repeat.

## Rules

1. **Set the outcome and bar first.** Write the brief, name the references, and state what "done" means (see `quality-bar.md`).
2. **Split the work into independently improvable parts.** Each 3D scene, UI component, transition and the audio mix is a part.
3. **Builder ≠ judge.** Spawn a *fresh* critic (a new agent or model session) for every review. Give it only:
   - the actual artifact (MP4 path or frames), not screenshots you chose;
   - the brief and the client's own words;
   - reference descriptions or files;
   - the previous critic's report (for verification rounds).
   Never give the critic your reasoning or a list of what you think you fixed; it must find things itself.
4. **Critics judge pixels and measurements**, not intentions. They extract frames themselves (contact sheets every 0.1–0.25s plus dense 1/30s windows around every transition) and compute frame-difference and loudness.
5. **Fix the largest meaningful gap first.** Don't average away a weak opening with strengths elsewhere.
6. **Verify, don't assume.** The next round uses a *new* critic that checks each prior item as FIXED / PARTLY / STILL PRESENT and looks for regressions. Fixes often create new defects, such as a covered element losing its z-order or a moved object now crossing a headline.
7. **Stop** at the quality bar, at diminishing returns (remaining items are sub-frame or cosmetic), or when the user says stop. Not after an arbitrary number of rounds.
8. **Keep a ledger.** One table: round → artifact → critic's top findings → changes made → measured result. It becomes the proof of craft for the client, and training material for the next project.

## Round types

| Round | Artifact | Critic focus |
|---|---|---|
| Storyboard | Table + rough frames | Chronology, business logic, truthfulness, variety of compositions |
| Asset | Generated stills/clips | Geometry fidelity (straight lines, believable joins), exposure, artifacts, fit to brief |
| Component | Isolated lab render (stills + 3–4s motion proof) | Material realism, camera, readability, collisions, pops, what information it adds |
| Full film | Whole render | Holds, empty space, transitions, text collisions, pacing, business clarity, audio |
| Verification | New render + previous report | Item-by-item status + new regressions + SHIP / ONE MORE PASS |

## What critics caught in practice (real examples)

- A one-frame "pop" when a 3D shingle layer started lifting: an ease-out started at full velocity, and individual courses separated in a single frame. Fix: smootherstep with tiny stagger.
- Wipes that spliced two titles into one word ("Sur|ctions."). Fix: the outgoing title leaves before the wipe, and the incoming title enters after it.
- A camera path that went near top-down, turning a house into a flat slab with a visibly repeating texture. Fix: limit pitch to 35–55° and keep a minimum distance.
- A report card that went blank for 0.2s between states. Fix: crossfade contents in place.
- Text flying through other text during a move. Fix: fade out, then fade in at the destination.
- A retained heading misaligned by ~12px because its parent had a slow scale push. Fix: animate the overlay with the same push.
- A photo labelled with the wrong caption, because one tween targeted both caption variants.
- Music that faded out before the logo landed, and sound effects that were too loud and harsh.
- Around 10 of 36 seconds effectively frozen. None of the builder's checks flagged it as a problem.

## Deadline mode
When the client compresses the schedule (e.g. "we need 1080 and have 1.5 hours"):
1. Give every in-flight builder a hard stop of 20–25 minutes. They land what works and revert anything half-done.
2. Integrate, then render at the delivery resolution only.
3. Run one full-film critic, then its top fixes in parallel.
4. Run a verify critic and deliver.
5. List every component whose last round wasn't re-verified in the honest limits.

## SHIP is not the end
On a 20 s spec ad the critics said SHIP at v2, with 6 of 7 wow windows YES. The client then found nine more things in seven rounds: empty space in a UI face, text over text mid-crossfade, a lying state label, the opening frame, a lingering first shot, music that "doesn't match", and three rounds of effect levels. Critics measure what they're asked to measure. Add those checks to the critic prompts (`quality-bar.md`, "Checks critics missed"). Plan for the client's own pass: deliver versions in a named folder, make each change by timestamp, and turn every round around in minutes.

## Measured progress example

Frozen time (frame difference below threshold) went from ~10s/36s → 6.5s/31.3s → 1.1s/30.1s → 0.7s/28.6s across four rounds. Loudness range went from 0.6 LU (flat wall of sound) to 3–4 LU.
