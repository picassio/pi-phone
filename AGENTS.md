# pi-phone rules

- Never fall back. No "try A, if it fails do B" paths, no silent degradation, no defaulting to a weaker behaviour
  when a requirement is missing. A missing requirement fails with a clear error naming what is missing. A documented
  configuration default is not a fallback.
- Keep answers short and technical. No emojis, no filler.
- Server and scripts: TypeScript only, erasable syntax (Node strip-only): no `enum`, `namespace`, parameter
  properties. No `any`. The web app (`web/`) is plain JavaScript modules without a build step, as pi-pocket wrote it.
- Top-level imports only in our own code; no `await import()`. (pi-pocket's `main.ts` loads the app lazily on
  purpose, after taking the port; `para.ts` loads pi-para when the wiki opens, as its modules use top-level await,
  which in the app's module graph let `app.ts` be read half-loaded.)
- Never a local model: no node-llama-cpp, GGUF, or other model run on the phone (battery, memory, heat), and nothing
  that downloads or installs one. Embeddings, reranking, and every other model call go to a remote API provider, or
  do not happen; there is no local fallback. qmd runs with `QMD_NO_LOCAL_MODELS=1` (`para-env.ts`), and the runtime
  package refuses to build with node-llama-cpp in `node_modules`.
- The wiki (`~/.pi/wiki`) changes only through pi-para's tools, the Wiki page, and capture: never write its files
  directly, in code or as the agent. Its index, search, prompt context, and log follow only those.
- People never edit files to configure pi-phone: every setting a person may change has a place in the app (a sheet,
  the menu). That includes the settings of what pi-phone embeds, such as pi-para's `~/.pi/para/config.jsonc`: the app
  reads and writes those files, people do not. Errors and hints name the app's setting, never a file to edit.
- Pin direct dependencies to exact versions. Install with `npm install --ignore-scripts`.
- Don't migrate what we don't need: features removed from pi-pocket (DESIGN.md section 3) stay removed unless the
  user asks for them.
- Checks run on the phone: `npm run check` (tsc 6 + `scripts/check-web-imports.ts`) and `npm test`. UI tests need a
  Chromium and are skipped on the phone; CI runs them.
- Every release has notes (the owner's rule): the release job writes them from the commits since the previous release
  (`scripts/release-notes.ts`). So write each commit's subject for people, with its kind and scope: `feat(machines): …`
  is listed as new, `fix(…): …` as a fix, anything else under other changes.
- README.md lists every feature people can use: a new one, or one changed or removed, changes it in the same commit.
- Design lives in DESIGN.md; update it when a decision changes. Upstream commits are in UPSTREAM.md. Current state
  and next steps: HANDOVER.md.
- For running, testing, and driving the app on the phone, load and follow
  [.pi/skills/pi-phone-dev.md](.pi/skills/pi-phone-dev.md).
- Never commit unless asked. Stage explicit paths.
