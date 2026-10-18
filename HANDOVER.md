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
- Android shell (`android/`): WebView, PiService (node, restart on exit 75, applies updates; sets
  `PI_POCKET_SUPERVISED`, termux-exec `LD_PRELOAD`, `SHELL`), RuntimeInstaller, Updater, Settings rail button.
- Termux rootfs with the prefix rewritten to `/data/data/io.piphone`; from build 37 it also has python, tmux, make,
  jq, zip/unzip, nano, vim, htop, file, tree, rsync, sqlite (`scripts/package-rootfs.ts`).
- pi-pocket server and web, cut down (DESIGN.md section 3), pi-phone wording; Claude Code billing patch
  (`claude-billing.ts`, `phone.json`; a test builds pi-ai's real Anthropic request and checks the patch still finds
  it); GitHub device sign-in; Continue a Pi session (file import, a chosen folder, from a machine).
- Restored from pi-pocket: artifacts, scheduled messages and goals. Staying out by the owner's decision: PiP's panel and follows (its session tools are back as Other sessions), Agent
  Teams, memory, triggers/watches/webhooks, the built-in browser, the gallery and drop-ins, Lancet Guard, Web Push,
  share target, dictation. No more trimming: multiplayer, theme editing, the launcher, the extension layer stay.
- Remote work: SSH keys, Machines, sessions on a machine (`machine:<id>:<path>`), Files/viewer/images/Changes/
  diffs/undo there, attachments copied to `~/.pi/mobile/uploads/<session>/` there, uploads from the Files panel
  (`workspace.putFile`, never over a file), the dock's machine bar when it does not answer (`places.reach`).
  Branches stay phone-only.
- Terminal (`terminal.ts`, `web/terminal.js`): pi-env `openTerminal` on the phone (local daemon) or a machine;
  the shell outlives its socket for 15 min and is taken up again by id with its last output; Paste, Select, End.
- Notifications (PiService polls `/api/phone/events`), downloads to Downloads (bridge `download`), ports of
  machines (`forwards.ts`), branches on a machine, This phone (battery optimisation, backup and restore, `backup.ts`).
- Secrets (`secrets.ts`, `extensions/secrets.ts`, Settings › Secrets): done. The plan for what comes next is the wiki
  page `projects/pi-phone-native-tools`. Diagrams (pele), Interview, Web access, and Documents (markit for attachments, file_to_markdown, wiki_ingest): done.
- The PARA wiki: pi-para 0.8.4 and qmd-engine 2.7.2 (both on node:sqlite), tools and prompt context (`para.ts`). Wiki page
  and editor, capture (`para-capture.ts`) done. Wiki settings (embedding picker included) done.
  sqlite-vec for Android (`native/android-arm64/vec0.so`) done: search by meaning works with an OpenRouter embedding
  model. Never a local model (AGENTS.md).
- `ssh <machine name>` works from the phone's bash and terminal (`~/.ssh/pi-phone_config`, written by `machines.ts`).
- Other sessions (`session-control.ts`, `extensions/sessions.ts`): Pi lists, reads, starts, messages, waits for,
  and stops other sessions as its person; denies approvals, never allows.
- Continue in Pi, and back (`pi-handoff.ts`, `web/sheets/pi-handoff.js`, the dock's Pi bar).
- `npm run upstream` (`scripts/upstream.ts`): pi packages vs npm (`--bump` pins and installs the newest), and
  pi-pocket / pi-termux-mobile commits since `UPSTREAM.md`'s, with the files this fork still has.

Verified on the phone: APK and runtime updates, GitHub sign-in, image reads, `watch_ci`, remote work against
han-devbox (`ubuntu@192.168.1.50`). Not yet tried by the owner: the terminal, Continue in Pi, uploads.

Next:
1. The owner's test of the terminal, Continue in Pi, and uploads (`test/tools-ui.test.ts` covers them in CI).
2. Not tried on a phone yet: notifications, downloads, ports, backup and restore (Android parts compile in CI only).
3. Upstreams: `npm run upstream` now and then; port what touches files we still have, then move `UPSTREAM.md`.

## Taking upstream changes

- pi packages: `npm run upstream -- --bump`, then `npm run check`, `npm test`, and the changelogs
  (`node_modules/@earendil-works/*/CHANGELOG.md`). They move together; pin exactly.
- pi-pocket: the fork diverged (cuts, pi-phone features); port commits by hand, file by file, from
  `~/work/pi-pocket` (`git -C ~/work/pi-pocket show <sha> -- <file>`). Then update the commit in `UPSTREAM.md`.

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
