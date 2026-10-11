# pi-phone rules

- Never fall back. No "try A, if it fails do B" paths, no silent degradation, no defaulting to a weaker behaviour
  when a requirement is missing. A missing requirement fails with a clear error naming what is missing. A documented
  configuration default (for example `PI_CHECKOUT` defaulting to `~/projects/pi`) is not a fallback.
- Keep answers short and technical. No emojis, no filler.
- TypeScript only, erasable syntax (Node strip-only): no `enum`, `namespace`, parameter properties. No `any`.
- Top-level imports only; no `await import()`.
- Pin direct dependencies to exact versions. Install with `npm install --ignore-scripts`.
- The pi checkout (`PI_CHECKOUT`, default `~/projects/pi`) is a dependency; its `experimental/` modules are
  imported from source through `bin/run.mjs`, which preloads the checkout's source resolver.
- Type checking does not run on the phone (TypeScript 7 and Biome have no Android binaries); run `tsc` on the
  laptop or in CI. Tests run on the phone: `npm test`.
- Design lives in DESIGN.md and UI.md; update them when a decision changes.
- Never commit unless asked. Stage explicit paths.
