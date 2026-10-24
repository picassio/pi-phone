# Upstreams

- pi-pocket: https://github.com/TannerMidd/pi-pocket at `e5456a832d47e7154faf04320dd7602ae5051bf7` (MIT, see
  `LICENSE-pi-pocket`). `src/server/`, `web/`, `test/`, `types/` started from this commit, then cut down
  (DESIGN.md section 3).
- pi-termux-mobile: https://github.com/badlogic/pi-termux-mobile at `a36765b88081d0b2728315311f918756283475ba`.
  `android/`, `scripts/package-rootfs.ts` (ported from `package-rootfs.py`) and the APK workflow started from it.

## Taken from pi-pocket since (PP-63)

The base stays `e5456a8`: later commits are taken one by one, by the owner's choice (2026-10-21), and listed here. The
rest of 0.15.0–0.19.0 (extensions hub, MCP, gallery, billing, LANCET, iPhone, nix, panels and slots, Simplified
Technical English, memory rules, linked-session limits, corners, the providers' columns, the base prompt's commit rule)
is skipped on purpose.

- Fixes (PP-64): b24d44c (`!` output without escape codes), 24f488f, 32b28cd, 3acdbce (a held session row), 29a1953 (New
  session here; the picker opens in the session's folder), 6856e07 (a message sent again takes the session's model).
- Interrupt (PP-65): 1923035, c40be26, ead0b3d, 9b68685, and the composer part of 2af63f9 (Queue stays chosen; not its
  slots). Model names (cab7322, fc705ad) are PiP's only: nothing to take.
- Subagent tiles (PP-66): 638e8f5, 242bbbf, with upstream's test/peeks.test.ts back (it was cut at the fork and runs).
- Speed (PP-68): 11d7e9f, 120a4ec, a82ed70, f3af788 (live Markdown, block by block; the session list and rail not drawn
  again for a view-only change), f1fdb02, 0ae752c (the message Pi writes sent as what changed), 4dc9a43 (the session list
  only when it changed), 9bff1b9, c1095e0, b2af3bd (compression, ETag and 304, modulepreload links: relative here, for a
  shared space's <base>), cfe0ddc (a new document base every 64 changes: done by hand for pi-phone's documents, those in
  docs.ts and its own in para-capture.ts, interviews.ts and openui.ts), e4bc3a4 (Changes reads only new entries; editFacts
  keeps pi-phone codemode's `args` path).
- Web speed from 0.21.0 (PP-133, by nohj). #139 (merge 52c7eb8), opening a session: 2e9b153, 8e1bba3 (with pi-pocket's
  `jumping` guard, which pi-phone lacked, so a jump is not pulled back down), d137e2e, 53f0379, 669a7a1, bda7809, 7dfab21,
  4bb8e21, 1e38d48 (the app's own DOMPurify; `rich.js` keeps the global one), 417bff6, 6e87d03, 930853b, 1988f67,
  2a485d3, 8012abb (History keyed on the history alone: pi-phone's has no `loadEarlier`), 94b87b3, test/open-fast-ui.
  Skipped: 0222db3 (pi-phone has no wide code blocks), 532e538 (no `slots.js`), ceb1881 and d492ce5 (PiP and font tests
  pi-phone does not have). #138 (merge ac7332f), Back to the list: 5794030 (hello's `former`, `sessionGroups` and `usage`
  kept too), 47b35fc, 6c89ea1, 55b01d5 (no badge in pi-phone), 3c6fa73, f957a3d and d782be6 (pi-phone's rows: folder
  groups, settled, a second tick while one works), 216fcf7, 8dbc20f, cfe9932 for the session list only (the rail keeps
  `apartFromViews`: its extension and peek buttons read keys of their own), 848bf3e and c6c9662's tests. Skipped: b68f775
  (PiP), the session-list-extensions test (pi-phone has no session chips). `scripts/bench-open.ts` measures both.
- Wait out provider limits from 0.21.0 (PP-135): a5909b7 (feat/rate-limit-wait), 2795c40 (gate review), cd69115 (the
  named Claude and ChatGPT windows, #128 by @piromagnus), 01a6381 and the limit parts of 83acd94, 4314fee (the vital
  tests, ported), 45982fb (ChatGPT Business admin caps fail fast). Rewritten by hand into `limits.ts`, `limit-gate.ts`
  and pi-phone's views; pi-phone adds the usage bars as a source of the reset, the account card (Wait or Move), the
  team server's pass-through, and the notice as a phone event and web push. Not taken: pi-pocket's push kinds and
  `alerts.ts` (pi-phone's phone events instead), PiP's summaries, the theme surface docs.
