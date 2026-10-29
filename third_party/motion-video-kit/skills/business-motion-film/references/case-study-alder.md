# Case study: ALDER (fictional roofing inspection brand)

A worked example of the whole playbook: one working day, two coding agents (Codex, then Claude Code), HyperFrames + GSAP + Three.js, Replicate (gpt-image-2.5-flare stills, Seedance 2.5 video), ElevenLabs (music), and a bundled SFX library.

## Brief

Sell a roof inspection: a careful inspection turns small details into clear next steps. CTA: "Request a roof inspection". Tagline: *Small details. Big decisions.* Palette: forest `#0a211d`, cream `#f4f0e5`, citron `#d9ef71`; Manrope. Labelled "Fictional brand · Concept film · AI-generated imagery". No diagnosis, savings, guarantee or confirmed appointment is claimed; the form says the company "will confirm availability".

## Final structure (28.6s, 1080p60)

| Time | Beat | Technique |
|---|---|---|
| 0–2.75 | SMALL DETAILS → BIG DECISIONS | Bright sunlit macro (AI still → image-to-video → 1080p60), forest type on sky with a citron bar, citron band wipe |
| 2.75–6.05 | Built in layers | Three.js maquette house; front roof plane separates into shingles / underlayment / deck / rafters; four evenly spaced projected callouts |
| 6.05–10.4 | Surface · Junctions · Drainage | Three AI inspection clips, one title position, one right-to-left wipe with a citron edge, focus reticles, contact strip |
| 10.4–14.5 | Every photo. In context. | Camera flies around the same house; each photo pops out of the spot it documents, docks into a rail, then lands at the report's exact coordinates |
| 14.5–17.6 | Your roof, explained. | Report with equal 124px rows; thumbnail click swaps the photo; an anchored flashing callout resolves into the Materials row; slow push |
| 17.6–20.8 | Talk through options. | The discussion row heading flies to become the scene heading; the selected photo parks in the corner; 3D maintain/repair/replace patches |
| 20.8–23.1 | Start with a visit. | Compact form; a visible Morning choice survives into the "Visit requested" confirmation |
| 23.1–24.9 | Confidence overhead. | Daylight home, slow push |
| 24.9–28.6 | ALDER | Bevelled 3D mark assembles, moves into the lockup, letters rise flat, CTA |

## How it evolved (and why)

1. **10s restrained ad** (image → video → text) was rejected as "too basic". The client wanted SaaS-launch density.
2. **30s and 40s cuts** added a storyboard, custom UI and a Three.js roof slab. They were rejected: the generic roof mesh and an evening house were overused, and it "looks like a basic video".
3. **36s cut** fixed spacing and card-size complaints but kept small 3D objects in large empty fields. The critic measured ~10s of frozen time.
4. **v8 (31s → 28.6s)** replaced the slab with the maquette house (layers + photo-pin flight), added 3D option patches and a new bright opener, and cut every hold. Five critic rounds brought frozen time down to ~0.7s.
5. **Audio (eight rounds):** energetic score rejected ("doesn't match; chill and mellow") → AI effects rejected ("not professional, jarring") → sparse library effects inaudible ("I can't hear anything") → launch-style dense layer rejected ("too loud, annoying") → rumbly repeated whooshes rejected ("whoosh, whoosh, whoosh") → one whoosh identified as the culprit by a music-only A/B → roof split too quiet → final: Lofi score 30% quieter, one soft rumble-free whoosh per transition, clean UI clicks/pops/taps, a key-tuned pluck on the 3D roof split, per-event in-band levels, −19 LUFS.

## Component critic findings that mattered

- Layers: one-frame pop, a camera ending too tight, label collisions, toy gutters, flat glass, grey sky instead of brand cream.
- Photo map: a pin on the wrong face of the chimney, a floating flashing "plinth", a grey gutter model versus a white gutter in the photo, a top-down slab moment.
- Options: an unclipped sweep, two tiles airborne at once, end states that looked alike, parts leaving their cards.

## Generation volume

10 AI stills and 10 AI video clips (5 used in the final film), 7+ music scores, and 14 generated sound effects that were eventually all replaced by library effects. Each full 1080p60 render took ~1 minute locally. Track API spend from the start; it wasn't tracked here.

## Lessons

- The strongest upgrade was making 3D *explain* (how the roof is built, where each photo was taken), not adding more 3D.
- Carrying objects across scenes at exact pixel coordinates made the film feel "one continuous thing".
- Independent critics found defects the builder repeatedly missed. Measurement (frozen time, loudness, sampled colours) turned taste arguments into fixable numbers.
- Audio choices must follow the viewer (homeowners), not the genre of reference (tech launches).
