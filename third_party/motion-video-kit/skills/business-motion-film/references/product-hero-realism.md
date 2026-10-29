# Product hero realism: making a Three.js device move like the real one

This comes from building a 40 s spec commercial for a foldable phone. The client's main note was: "especially nail the folding animation… it should look realistic". Everything here is measured, not guessed.

## 1. Study the reference motion frame by frame
- Download the brand's own film for **study only**; it never goes into the output. Tile the hero motion at 10 and 30 fps (`ffmpeg -ss A -t D -i ref.mp4 -vf "fps=30,scale=400:-2,tile=7x7"`). Tile your render at the same fps and crop, and compare side by side.
- **Measure the curve.** Estimate the angle per frame from the projected width of the moving part and write keys (seconds after start → degrees). A real foldable unfold ran 0→180° in about 0.8 s, with these keys: `0→0, .08→20, .15→58, .23→82, .31→98, .39→116, .49→140, .59→159, .69→172, .80→180`. It is fastest at 30–60°, slows (dwells) near edge-on and lands softly. That is **not** a smoothstep.
- Interpolate the keys with a **monotone cubic (Fritsch–Carlson) with zero end slopes**. Blending keys with a smoothstep "to soften it" moved the dwell and created a mid-swing hiccup (7.8 → 2.6 → 5.4°/frame), which a critic caught from a per-frame CSV. Have a critic plot °/frame: it must peak once and then dwell, with no second hiccup.
- **Lock the camera** during the motion. A reframe that stops on the contact frame reads as a camera bump. Re-centre the *object* during the swing (the real footage does this), and move any camera reframe to after the landing.

## 2. The screens are half of the realism
The motion matched early on, but it still read as CG until the screen behaviour matched the reference:
- **Before the move:** the outer display shows the *home* screen, reached via a quick unlock. Stagger the unlock: the lock layer lifts and fades out, *then* the home screen scales in from 1.06. A simple crossfade gave a doubled "9:41", which counts as a text collision.
- **During the move:** the outer display **blurs but stays lit** on the moving cover and only sleeps near edge-on. Our first version slept at the lift; that made a 74 % luma drop and a black hole on a black stage.
- **Continuity:** the big display's right half shows *exactly* the layout the small display showed, pixel for pixel. Build the small display's texture as a crop of the big one, so the match holds by construction.
- **The frost:** the newly revealed half keeps a sharp, continuous wallpaper under a white frost veil (about 0.3). The new widgets arrive as frosted, whitened, translucent cards (blur about 40 px, 0.6 opacity, 0.97 scale). These resolve to sharp in about 0.35 s *after* the landing. Blurring the whole half, wallpaper included, read as a smeared photo. Pre-render about 6 blur levels and crossfade between them, so the frost is cheap per frame.

## 3. Motion blur that holds up
- Use deterministic accumulation. Render N sub-frames inside the shutter (`t + ((i+½)/N − ½)·shutter`), average them into a half-float target, and keep every frame a pure function of t.
- **Sub-frames:** 10 left a visible comb on a fast edge (a 3 px ripple of ±20 luma). 24 over the fastest 0.5 s cleaned it up.
- **Shutter:** 180° looked too crisp next to the real footage. About 300° during the fastest swing, easing back to 180°, matched it.
- **Switching:** ramp the shutter from 0 to its full angle over about 6 frames at the window edges, so it never switches on in one frame. Check that no brightness step appears where blur turns on or off.
- **Coverage:** every fast fold in the film needs it. One fold was moving 52 px/frame, another 35 px/frame, and both had no blur.

## 4. Light that tells you the angle
- **Keep ≥60 % of the glass reflections through a fold.** Our builders cut 85 % to hide one-frame flashes, and that removed the main cue that the angle was changing.
- **Fix flashes by widening the light, not dimming it.** A flat polished rail sweeps past a narrow light's mirror angle within one frame. Widen the strip (width 3 → 12 at low power) so the glint builds over about 6 frames. Find the culprit by switching lights off one at a time.
- **Build a black cover to read on a black stage.** Place a broad soft box at the mirror position of the camera about the glass, and let it travel with the angle.
- **Keep magnetic contact dead still.** The real close is pixel-identical for about 17 frames after contact. A camera "jolt" (about 22 px) and a 1.7° rebound read as fake; the fix was no jolt and a rebound of about 0.27°.

## 5. The render plumbing
- **Handoffs:** use shared functions (`applyTurn(u)`, `applyPoseP()`) so both sides of a cut compute identical poses. Check each cut with a mean frame difference against its neighbours.
- **The environment map:** three r181 `PMREMGenerator.fromScene` ignores the render target you pass and leaks a new one every call. Keep one persistent target, copy each result into it and dispose of the fresh one. Feather the soft boxes, or the reflections have hard edges.
- **Supersampling:** render at a 1.5× pixel ratio and let the browser downsample; size the depth-of-field target to the drawing buffer.
- **Fonts:** headless Chrome renders `-apple-system` as Times. Bind the family names with `@font-face` to a local font file that sits next to the CSS (lint rules may reject `../`), and don't redistribute system fonts.
- **Shared-file edits:** while several builders work in parallel, edit shared files through a `.next.js` copy, run `node --check`, then `mv` it into place. One mid-edit syntax error blanked every canvas.
- **Stage colour:** measure the stage colour through the capture→encode path. CSS `#f5f5f7` decoded as `#f3f5f5`, so author the stage colour to what should come out.
- **Blind tests on encoded frames only.** Lossless PNG captures of our stage sat at (245,243,246) while the reference film decoded to (243,243,245): a perfect tell that has nothing to do with realism. Pull your frames from the rendered MP4, run both sets through the same encode, and hide the key.

**More gotchas, from a 20 s spec ad (HyperFrames 0.8, 4K = the 1080 composition at a device pixel ratio of 2):**
- **Never read `window.devicePixelRatio` per frame.** Inside a 4K render it reads 2 only on frames 0, 30, 60… and 1 in between, while the pixels stay true 4K. Anything sized from it per frame (mesh sharpness, line widths) flickers. Freeze it at load.
- **Render with `--experimental-fast-capture=false`.** The fast path dropped a WebGL canvas at 4K.
- **Type under a slow transform steps.** DOM text under a slowly changing CSS transform or font size re-rasterises in visible one-frame steps (≈ 10 steps in 2 s at a 12 %/s push). Draw each line on a 2× canvas: one `fillText` of the whole line, with each word revealed through a clip so the per-word rise keeps the natural kerning. Keep the DOM line at opacity 0 for layout and overlap checks. A transparent fill gets flagged as unpainted text.
- **Fonts load lazily.** A line laid out before its weight loaded kept the fallback font's metrics. Preload every weight (`document.fonts.load`) before mounting the overlays.
- **Hidden segments measure 0 px.** Overlays mounted inside `display:none` segments measured zero-width text and overlapped. Lay every segment out (visible but hidden) while the overlays mount, then hide them.
- **Register readiness early.** Late registration of the render's ready promise captured blank first frames. Do it in a classic `<head>` script, before any module.
- **`will-change` broke seek determinism.** Remove it.
- **One NaN, one black frame.** A ripple shader evaluated past its range produced a single black frame that existed in every render for two rounds. Scan every render for single near-black frames.
- **Hard thresholds on continuous values flash.** A bulb icon switched its ink at `light > 0.3`, and the animation landed at 0.29999999, so the bulb was white for exactly one frame. Make every threshold on a continuous input a crossfade.
- **Comments can swallow code.** A trailing `//` comment on a long one-line statement swallowed the next uniform definitions. `node --check` passed, and the scene threw at load. Render a frame after every edit to a shared file.
- **A whole-frame "pop" flag may be intended.** A screen blooming from dark to light and a woofer making a full stroke both tripped the single-frame pop detector. Before you "fix" a flag, look at the frame-to-frame difference over ±5 frames: a ramp (0.25 → 1.08 → 0.36) is motion, while a lone spike is a bug.
- **Re-time a shot instead of rebuilding it.** Give each segment window a local clock offset, and let a scene remap its own clock (`t → t0 + rate·t`). Opening on a later, finished frame and trimming a lingering first shot were both one-line changes.

## 6. How the review loop found these
- The critic that mattered most compared the render against the reference **frame by frame** and wrote a **per-frame CSV**.
- The director's own first reading of the reference was wrong once: whether the outer display sleeps at the lift. A second, fresh fold critic caught it.
- Always verify the fixes in the next round; don't trust the builder's own numbers. One builder measured a glint at 1.11× its neighbours; the critic, measuring in the film, found 2.1×.
