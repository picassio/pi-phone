# Quality bar

A cut ships only when all of these hold. Critics check them; scripts measure the numeric ones.

## Measured

| Check | Target | How |
|---|---|---|
| Frozen time | Total stretches with frame-diff below threshold ≤ ~1s per 30s; no single hold > 0.6s except the final CTA | `scripts/frozen-time.sh` |
| Loudness | −14 LUFS for punchy launch-style pieces; about −16 LUFS for calm pieces; true peak ≤ −1 dBFS | `scripts/loudness.sh` |
| Dynamics | Energetic scores: loudness range ≥ ~3 LU (a flat wall of sound reads as stock). Calm/chill scores: ~1.5–3 LU is fine, as long as the track doesn't die before the ending | `scripts/loudness.sh` |
| Effects vs music | ~+4 dB lift within each effect's own frequency band over the music-only mix; never inaudible, never poking out (clicks/ticks spiking 10+ dB at 2–8 kHz read as annoying) | Band-passed 50ms peak vs music-only render |
| Text contrast | WCAG AA on all settled text (transitional fades excepted) | Framework check / manual sampling |
| Brand colour | Sampled backgrounds match brand tokens (tone mapping in 3D shifts colours, so measure) | Crop + average pixel |
| Determinism | Same frame rendered twice from different seek orders gives identical pixels | Seek-consistency test |

## Visual (critic-judged)

- **No empty frames**, e.g. a blank colour band before a title lands, or a lone photo on an empty field.
- **Frame 0 is a finished composition.** No half-entered word at the first frame.
- **No text collisions,** including mid-transition: one title over another, text flying through a heading, titles spliced by a wipe.
- **Equal spacing** in lists and rows (identical row height, shared left edges, separators). Clients notice this immediately.
- **Aligned left edges** across headline, image and supporting rows.
- **Lead subject fills 60–85%** of the frame in feature beats.
- **3D reads as designed:** no toy-like gaps, floating parts, visible texture tiling, top-down "slab" angles, or pops.
- **Pins and callouts** sit on the thing they name, and each photo's label matches its content.
- **Transitions** keep a carried object or matched direction. No unrelated slide-in after unrelated slide-in.
- **Brightness:** home-services and consumer buyers rejected dark, moody openers. Keep imagery bright and clear unless the brand demands otherwise.

## Business (critic-judged, on mute)

- By the end, a first-time viewer can say what the business does and the one next action.
- Every claim is true or clearly labelled as a concept.
- The CTA is readable at phone size for at least ~1.5s.

## Common rejection reasons from real clients

- "Too basic: image, then video, then text."
- "So much space is being wasted."
- "Some parts linger too long."
- "Not spaced equally."
- "It's not elite; go harder."
- "The first image looks too dark."
- "The music doesn't match."
- "The sound effects feel unprofessional and jarring."
- "So much empty space" (a glanceable UI with a dead band between the title and the number).
- "Start the video with this frame" / "the first scene lingers" (open on the finished hero composition, not a reveal).
- "Unnecessary sudden cuts" in the music (dead stops and splices), and "too loud" at −30 LUFS.
- "Maybe we can't even hear it" (the hero's mechanical moves held under the music by a micro-sound cap).
- "I meant use clean ones instead of random" (a disliked effect should be replaced, not deleted).

## Checks critics missed and clients caught
- **Text over text mid-crossfade.** Check overlaps on every frame of every crossfade, not only on settled frames.
- **State labels that contradict the values**, e.g. "Open" while the number counts down.
- **Glanceable layouts:** no dead bands; each big number centred between its label and its bar; every tile earns its space. Content that echoes the headline (a "Locks" row under "lights, locks, blinds") fills the space with meaning.
- **The hero moments are audible** on a laptop at normal volume, with the music on.
