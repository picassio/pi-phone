# pi-phone rules

- Never fall back. No "try A, if it fails do B" paths, no silent degradation, no defaulting to a weaker behaviour
  when a requirement is missing. A missing requirement fails with a clear error naming what is missing. A documented
  configuration default is not a fallback.
- Keep answers short and technical. No emojis, no filler.
- Server and scripts: TypeScript only, erasable syntax (Node strip-only): no `enum`, `namespace`, parameter
  properties. No `any`. The web app (`web/`) is plain JavaScript modules without a build step, as pi-pocket wrote it.
- Top-level imports only in our own code; no `await import()`. (pi-pocket's `main.ts` loads the app lazily on
  purpose, after taking the port.)
- Pin direct dependencies to exact versions. Install with `npm install --ignore-scripts`.
- Don't migrate what we don't need: features removed from pi-pocket (DESIGN.md section 3) stay removed unless the
  user asks for them.
- Checks run on the phone: `npm run check` (tsc 6 + `scripts/check-web-imports.ts`) and `npm test`. UI tests need a
  Chromium and are skipped on the phone; CI runs them.
- Design lives in DESIGN.md; update it when a decision changes. Upstream commits are in UPSTREAM.md.
- For running, testing, and driving the app on the phone, load and follow
  [.pi/skills/pi-phone-dev.md](.pi/skills/pi-phone-dev.md).
- Never commit unless asked. Stage explicit paths.
