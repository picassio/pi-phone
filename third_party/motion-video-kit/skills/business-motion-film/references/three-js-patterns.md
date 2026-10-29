# Three.js patterns for commercial motion

Use 3D where it **explains** something physical or spatial. Everything else (type, reports, forms) stays crisp HTML/SVG.

## Render contract (deterministic, seekable)

```js
export async function createScene(canvas, opts = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1); renderer.setSize(1920, 1080, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // ...build everything once...
  function pose(t) { /* set every transform from t only */ }
  function render(t) { pose(t); renderer.render(scene, camera); }
  function anchors(t) { pose(t); return points.map(p => project(p)); } // screen coords for HTML overlays
  await renderer.compileAsync(scene, camera); render(0);
  return { render, anchors, dispose };
}
```

- The root timeline calls `render(localTime)` on every seek and update. No RAF loop, timers or physics history.
- Load all textures before resolving, and have the renderer wait for fonts and every scene before capture.
- Retime by mapping film time → local time (`(t - start) * speed`), never with a free-running clock.

## Patterns that worked

**Exploded architectural layers.** Build the object in its own local frame (e.g. for a roof plane: x along the ridge, y out of the plane, z down the slope, via `matrix.makeBasis(u, n, v)`). Stack real layers (rafters → deck → underlay → shingle courses) as separate groups, then lift each along the plane normal with different amounts and a smootherstep ease (`x*x*x*(x*(x*6-15)+10)`). Use a tiny stagger (≤5ms per course). A cubic ease-out starts at full speed and makes a visible one-frame pop. After the lift, keep a slow "breathing" separation (+10–15%) so the hold isn't frozen.

**Projected callouts.** `anchors(t)` returns screen points (`vector.project(camera)` → pixels) for points on each layer. HTML labels sit in an evenly spaced column with leader lines to the points; recompute every frame. Equal label spacing matters more than exact alignment to each anchor.

**Photos pinned in context.** Fly the camera around the model; at the moment each documented spot is visible, a real photo card pops out of its pin with a leader line, then docks into a rail. On handoff, cards animate to the exact pixel rectangles of the next scene's layout. Keep cards opaque with a shadow that fades during handoff. Pin on the side facing the camera, and make each label match its photo.

**Animated option patches.** Pixel-space orthographic camera (`OrthographicCamera(-960, 960, 540, -540)`) so each 3D patch sits exactly in its HTML card. Give each option a distinct end state: e.g. maintain = a scan line that stays parked, repair = one visibly new tile, replace = a new field with an edge trim. Sequence actions so only one piece is airborne at a time, and keep moving parts inside their card.

**Physical logo mark.** Bevelled parts assemble into the mark, then the same canvas moves (CSS transform) into the final lockup, so the mark visibly survives into the end card.

## Realism checklist (what critics flagged)

- Background colours shift under ACES tone mapping. Measure the rendered pixel and compensate with an HDR background (e.g. multiply the linear RGB by 1.1–1.9 per channel) until it matches the brand token. Fog uses the same colour.
- Architectural-model ("maquette") styling reads premium and avoids uncanny fake photorealism: cream walls, real roofing material textures, a model base board.
- Toy giveaways: gutters floating off the fascia, square downspouts that read as posts, flat black glass (raise the colour and add environment reflection), open ridge notches (add a ridge cap), plinth-like flashing (make it a flush sloped apron).
- Studio lighting: a soft key from the side you want lit, low shadow radius so lifted layers cast readable shadows, and a warm/cool rim.
- Camera: pitch 35–55°, keep a minimum distance (never top-down on large textured planes, where tiling becomes visible), no roll, pull back rather than end tight on a slab.
- Depth of field: a subtle lens pass helps macro moments. Focus on the subject distance.

## Lab first

Build each scene in `templates/component-lab.html`, render stills at meaningful times plus a 3–4s proof, and get a component critic's KEEP before integrating.
