# Handover: continuing pi-phone from inside the app

Written at the end of the Termux session that built the app (2026-10-17), for the session that continues it inside
the pi app. Read AGENTS.md and DESIGN.md next; `.pi/skills/pi-phone-dev.md` has the commands.

## Where you are now

You run inside the app (`io.piphone`), not in Termux. The history before this note mentions Termux paths; translate:

| Termux (history) | App (now) |
| --- | --- |
| `/data/data/com.termux/files/home/projects/pi-phone` | `~/work/pi-phone` (a clone); upstreams in `~/work/pi-pocket`, `~/work/pi-termux-mobile` |
| `/data/data/com.termux/files/usr` | `/data/data/io.piphone/files/usr` (the bundled Termux rootfs) |
| `~/.pi/agent/auth.json` (Termux's) | the app's own `~/.pi/agent/auth.json` (Claude login made in the app) |
| `gh` signed in as picassio | the app's `gh`: sign in through Settings > GitHub, then `gh auth status` |
| adb, `termux-open`, `~/storage/downloads` | not available here |
| `/tmp` | not writable: use `$TMPDIR` (`files/tmp`) |

The server you are running in is `files/runtime` (replaced by every update). Never edit it; change the clone, push,
and let the release reach the app.

## The loop from here

1. Work in `~/work/pi-phone` (clone of `github.com/picassio/pi-phone`, public).
2. `npm install --ignore-scripts` once in the clone, then `npm run check` (tsc 6 + web import check, ~30 s) and
   `npm test` (UI tests skip without Chromium).
3. To try a server or web change before shipping, run the clone on another port with its own data folder:
   `node src/server/main.ts --port 8788 --data ~/tmp/dev-data --cwd ~/tmp` (prints a `/login?token=` link; the app's
   WebView only shows port 8787, so test through the API or wait for the release).
4. Commit (explicit paths), `git push origin master`. CI (`.github/workflows/build-apk.yml`): check job (tsc, tests
   incl. UI tests in Chrome), apk job, then a release `build-<run>` when both pass.
   After pushing, call `watch_ci` (action start, path: "pi-phone"; the working folder `~/work` is not a repository)
   and end the turn: a `[ci-watch]` message says how CI went, instead
   of polling `gh run` in a loop.
5. In the app: Settings > Check for app updates (or restart the app). Runtime-only changes update in seconds; shell
   (`android/`) changes need the one-tap APK install.

`gh run list`, `gh run view <id> --log-failed`, `gh run rerun <id> --failed` work from here once `gh` is signed in.

## State of the work (see DESIGN.md section 6 for the task list)

Done:
- Android shell (`android/`): WebView, PiService (node, restart on exit 75, applies updates), RuntimeInstaller
  (rootfs + runtime parts, staging and swap, `.apk-version`), Updater (manifest from the latest release, SHA-256
  checked downloads, PackageInstaller), Settings rail button, status page in the pocket theme colors.
- Termux rootfs with the prefix rewritten in place to `/data/data/io.piphone` (same length as `com.termux`).
- pi-pocket server and web, cut down (DESIGN.md section 3), Claude Code billing patch (`claude-billing.ts`,
  `phone.json`), GitHub device sign-in (`github-login.ts`, `web/sheets/github.js`), Continue a Pi session with file
  import and a chosen folder (`pi-sessions.ts`, `web/sheets/pi-sessions.js`).
- Releases: build-10 is the latest at the time of writing; the app updates from them.

Verified on the phone: the APK update (build 12) and runtime updates, GitHub sign-in, `npm run check` in the app,
image reads and the zoom viewer, `watch_ci` reports, and remote work end to end against a real Linux machine
(han-devbox, build 28): SSH key import, Machines (scan, accept, install and connect), a session whose tools run there.

Next, in order:
1. Verify on the phone: a runtime-only update, continuing this session, the
   billing patch on an Opus prompt (ask "Quote the very first line of your system prompt verbatim").
2. CI flake: the UI tests sometimes fail with "The browser did not answer Browser.getVersion in time" (Chrome slow
   to start on the runner). Raise the start timeout in `test/support/browser/cdp.ts` or `browser.ts`.
3. Cut the rest (DESIGN.md section 3, "still to cut"): multiplayer (collab, spend, people, invites, roles, peek
   tiles; `attribution` down to one owner), theme editing, the Walker launcher, the extension web layer (needs the
   loader in `reload.ts` reworked). The Extensions sheet still has dead Lancet Guard code; the People sheet a dead
   Notifications button; the store still has `browserOpen`/`pipOpen`.
4. Remote work (done through build 28: pi 1.3.0, SSH keys, Machines, sessions on a machine, Continue a Pi session
   from a machine). Still to do on machines: the Files panel, file viewer, Changes, and branches through the
   machine's environment (`workspace.ts` says "not available yet" there); attachments copied to the machine; a
   terminal (pi-env's `openTerminal` + xterm.js).
5. "Pi Pocket" still appears in user-facing text (exports, a few sheets); rename to pi-phone where it is shown.

## Rules that bit before

- `#!/usr/bin/env` scripts (npm CLIs, `npm run`) work because PiService preloads termux-exec (build 12 on). If they
  fail with "not found", check that `$LD_PRELOAD` names `libtermux-exec-ld-preload.so`.

- Never fall back; fail with a clear error (AGENTS.md). Don't migrate removed pi-pocket features back unless asked.
- `pkill -f` with a pattern matching your own command line kills your own shell. Use `pkill -f "main.ts --port 878[8]"`.
- The shell is `sh`, not bash: no arrays; use Node for anything non-trivial.
- Web code has no build and no type check: run `node scripts/check-web-imports.ts` and `node --check` on changed files.
- `scripts/package-runtime.ts` and `scripts/versions.ts` refuse uncommitted changes (the versions come from git).
- Signing key: only in the repo secrets (and `~/.config/pi-phone-signing/` in Termux). Never needed in the app.
- Commit only when asked; stage explicit paths. Commits use the repo-local identity
  `picassio <13956882+picassio@users.noreply.github.com>`; set it in the clone: `git config user.name picassio` and
  `git config user.email 13956882+picassio@users.noreply.github.com`.
