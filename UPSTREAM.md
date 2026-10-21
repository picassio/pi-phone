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
