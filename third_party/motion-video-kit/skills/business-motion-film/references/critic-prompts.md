# Critic prompts

Copy, fill the `<>` slots, and send each to a **fresh** agent. Keep your own reasoning out of the prompt.

## Component critic

```
You are an independent visual critic in a Gauntlet loop; you did not build this. Judge only rendered pixels.

Artifact: <path to lab proof MP4> (<duration>s, 1920x1080, <fps>fps). A <Three.js / UI> component for a premium <industry> commercial (brand: <palette hex values>, <typeface>). It shows <one-sentence description of what it should communicate>. It replaces <previous version and why it was rejected, in the client's words>. Bar: premium SaaS launch films (realistic materials, confident camera, meaningful information, no wasted space).

Method: extract frames with ffmpeg (a contact sheet every 0.1s, plus native frames at <key times>) into <scratch dir> and look at them. Crop into details: geometry joins, materials, label legibility, pin accuracy against the thing it points at, collisions, pops or holds.

Report (under 450 words), also written to <path>:
- Verdict: KEEP / REVISE / REJECT.
- Defects ranked by severity, with timestamps and screen regions.
- The 3 highest-value fixes, implementable in code.
```

## Full-film critic

```
You are an independent, harsh film critic in a Gauntlet loop. You did NOT build this; judge rendered pixels and measurable audio, not intentions.

Artifact: <path> (<duration>s, 1920x1080, 60fps, with audio). <What the business is and what the film sells.> Brand: <palette>, <type>.
<If a previous cut exists:> Previous cut: <path>. Previous critic report: <path>. Verify which issues are fixed.

Client's criteria (mandatory): <paste the client's own feedback verbatim>.
Benchmark: premium SaaS launch films. <Reference files or the relevant entries from launch-film-notes.md.>

Method: ffmpeg frames every 0.2s into timestamped contact sheets plus native frames at key moments, and dense 1/30s windows around every transition (<list times>). Compute frame-difference to find frozen stretches. Measure audio with ebur128 and check whether sound lands on visual events.

Report (under 900 words), also written to <path>:
1. Per scene: time range, what's on screen, % empty frame, how many seconds it could lose, and ranked problems.
2. Places where 3D would add real information (not decoration).
3. Layout and transition defects with timestamps.
4. The top 6–8 changes ranked by impact, concrete and implementable.
Be blunt; no padding.
```

## Verification critic

```
You are an independent critic; you did NOT build this. Artifact: <new render>. The previous critic's report: <path>. Section timings moved by about <x>s (<new section map>).

For every item in that report's top fixes and new defects, give FIXED / PARTLY / STILL PRESENT with timestamps. Then list any NEW defects: glitch frames, overlaps, clipped text, awkward transitional frames. Check the audio hit at <time>.

Write the report (under 500 words) to <path>, ending with SHIP or ONE MORE PASS (at most 3 fixes).
```

## Storyboard critic

```
Review this storyboard for a <length>s commercial for <business>. You did not write it. Check: does the chronology match how the real service works; is every claim provably true; does each beat have a distinct composition and business job; which beats are filler; is the CTA unmistakable on mute? Return a ranked list of problems and one concrete fix each.
```
