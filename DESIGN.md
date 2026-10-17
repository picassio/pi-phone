# pi-phone

A single-user pi agent as one Android app. No Termux needed at runtime: the APK carries a Termux-built userland
(node, bash, git, rg, ssh, ...) and the server, and shows the UI in a WebView.

Built from two upstreams, cut down to what this app needs:

- https://github.com/badlogic/pi-termux-mobile: the Android shell (plain Gradle, Java, no NDK), the embedded
  Termux runtime, and the APK workflow.
- https://github.com/TannerMidd/pi-pocket (MIT): the server and the web UI, written against pi-durable 1.1.0; we run
  it on the pi packages 1.3.0 (pi-durable, pi-ai, pi-coding-agent, pi-codemode, chord), which `@earendil-works/pi-env`
  needs for remote machines. 1.2.0 renamed tool results' `content` to `output` (the old field is silently ignored:
  a tool answering with it gives the model nothing), made `bash`'s nonzero exits error results, and brought its own
  codemode and image reads, which replace pi-pocket's codemode extension here.
  Imported at commit `e5456a832d47e7154faf04320dd7602ae5051bf7` (see `UPSTREAM.md`); we own the fork from there.

## 1. Layout

```
android/          Android shell: MainActivity (WebView), PiService (foreground service), RuntimeInstaller
scripts/          package-rootfs.ts (Termux packages -> rootfs.bin), package-runtime.ts (server -> runtime.bin)
src/server/       pi-pocket server, cut down; cc-patch.ts, phone-settings.ts are ours
web/              pi-pocket web app (Preact + htm, no build step), cut down
test/             node:test
.github/workflows/build-apk.yml
```

## 2. Runtime on the phone

App id `io.piphone`. Ten characters, the same length as `com.termux`, so `package-rootfs.ts` rewrites every
`/data/data/com.termux` in the Termux packages (ELF binaries, scripts, symlinks) to `/data/data/io.piphone` without
moving a byte. Binaries then find their libraries, configs, helpers (`git`'s exec path, ssh's config, openssl's
certs), and script shebangs at the app's own prefix. Rebuilding Termux packages is not needed.

```
files/usr/        Termux prefix (rootfs.bin)
files/runtime/    the server: src/, web/, package.json, node_modules (runtime.bin)
files/home/       HOME: ~/.pi/agent (pi auth, settings, skills), ~/.pi-pocket (database, config, uploads)
files/home/work/  default working folder for new sessions
files/tmp/        TMPDIR
```

- targetSdk 28: Android 10+ forbids `execve()` of files in app data for targetSdk >= 29. Sideload only.
- `RuntimeInstaller` keeps two parts, rootfs (`files/usr`) and runtime (`files/runtime`), each with a version stamp.
  The APK's own parts are extracted when the APK is new (its versionCode differs from `files/.apk-version`); a
  downloaded update replaces one part later. Each extraction goes to a staging folder with the system `tar` and is
  swapped in, so a failed one leaves the part before it whole. A failed extraction is an error, never ignored.
  `home/` is never touched by an update.
- `PiService`: foreground service with a partial wake lock; runs
  `usr/bin/node runtime/src/server/main.ts --host 127.0.0.1 --port 8787 --cwd home/work`
  with `HOME`, `PREFIX`, `PATH`, `LD_LIBRARY_PATH`, `TMPDIR`, `SSL_CERT_FILE`, `LANG` set. Log in
  `files/log/server.log`.
- `MainActivity`: starts the service, waits for `GET /` to stop answering 503, reads `ownerToken` from
  `home/.pi-pocket/config.json`, loads `http://127.0.0.1:8787/login?token=...` in a WebView.
- Android 12+ phantom-process killer and OEM battery savers can still kill children; document the adb setting.

## 3. Server and UI: what we keep from pi-pocket

Kept: the durable core (`app`, `room`, `projection`, `timing`, `entry-format`, `fence`, `docs`, `host`, `reload`
for built-ins, `lock`, `errors`, `paths`, `http` + api/conversation/events/assets/io/sign-in routes), `commands`,
`resend`, `shell`, `titles`, `prompts`, `skills`, `models`, `project-model`, `model-refresh`, `running`,
`transcripts`, `providers`, `workspace`, `files`, `changes`, `branches`, `git`, `export`, `worktrees` (forks
and new sessions in a git worktree of their own; wired through session creation), owner-only `config`/`auth`;
extensions `prompt`, `subagents`, `codemode`, `plan`, `artifacts` (restored 2026-10-17: the `artifact` tool, its
sheet and viewer, and `/a/`, which also serves the sandboxed frame that runs HTML blocks in replies), `schedules`
and `goals` (restored 2026-10-17 without their PiP ties: `/schedule`, the `schedule` tool, `/until`; a goal's check
runs through the session's environment, so on a machine it runs there). `pi-sessions` (continue a pi CLI session with its history),
with two changes: a session file can be imported (`POST /api/pi-sessions/import`, kept in
`~/.pi/agent/sessions/--imported--/`), and a session whose folder is not on the phone continues in a folder chosen
for it. The same reader is the base for pulling sessions from other machines over ssh later. `omarchy.ts` stays only for its `colors.toml` parser, which
theme palettes use. The web app's chat, composer, transcript,
diffs, files and changes, sessions, session tree, subagents board, sheets for those, and the `pocket` and
`lantern` themes.

Removed, and staying out (the owner's decision, 2026-10-17): PiP, Agent Teams and linked sessions, memory, triggers
(GitHub watches, repository watches, webhooks), the built-in browser, the extension gallery and drop-ins, Lancet
Guard (ONNX), Web Push, the share target, dictation, the launcher (access modes, tunnels, QR), and the repo extras (docs
site, nix, lint config).

Kept on purpose (the owner's decision, 2026-10-17: no more trimming): multiplayer (`collab`, `spend`, people,
invites, roles, peek tiles), theme editing and Omarchy palettes, the Walker-style launcher, and the extension web
layer (`extension-web.ts`, `extension-commands.ts`, `http/extension-routes.ts`, `web/extension-ui.js`). Do not cut
them. pi-pocket's Chromium driver lives on in `test/support/` for the UI tests.

## 4. Ours

- **Claude Code billing patch** (`src/server/cc-patch.ts`, ported from picassio/pi-cc-patch): rewrites direct
  Anthropic OAuth payloads so Pro/Max quota is billed. Installed through `PocketApp`'s `configureModels`, which
  wraps `ModelRuntime.streamSimple` to add `onPayload`. Gated on the OAuth identity block, so API-key and other
  providers are untouched. Toggle and Claude Code version in `~/.pi-pocket/phone.json`
  (`{"claudeCodeBilling":{"enabled":true,"version":"2.1.280"}}`), re-read on change.
- **GitHub sign-in** (`src/server/github-login.ts`, `web/sheets/github.js`): GitHub's device flow with `gh`'s own
  OAuth app; the token goes to `gh auth login --with-token`, then `gh auth setup-git`. The agent's `git` and `gh`
  use it for private repositories; it lives in the app's home folder, where the agent can read it.
- **CI watch** (`src/server/extensions/ci-watch.ts`): the `watch_ci` tool registers GitHub Actions runs (default: the
  runs of the commit just pushed); a durable background task per run looks every 30 s with the app's `gh` and sends
  the conversation one `[ci-watch]` message when it finishes (conclusion, jobs, failed steps and the end of their log,
  fenced). Ends with its run, after 2 hours, after 6 failed looks in a row (it says so), or when stopped (the tool, or
  Stop in the bar above the message box). Survives restarts.
- **SSH keys** (`src/server/ssh-keys.ts`, `web/sheets/ssh-keys.js`): the app's keys for machines, one per purpose, in
  `~/.ssh/keys/<id>` (mode 600) with names in `keys.json`. Generated (ed25519, no passphrase: background work has
  nobody to ask) or imported; the public key is shown to put in a machine's `authorized_keys`. Each machine is
  assigned one key (Machines, next).
- **Machines** (`src/server/machines.ts`, `web/sheets/machines.js`): other computers sessions can work on, through
  `@earendil-works/pi-env` (its daemon on the machine, deployed over ssh and verified by hash). `machines.json` holds
  name, `user@host[:port]`, and the SSH key; host keys the owner accepted are in `~/.ssh/pi-phone_known_hosts` under
  one alias per machine (a changed key is refused). Three owner taps before anything runs there: scan the host key,
  accept it, "Install and connect" (deploys the daemon to `~/.pi/mobile/tools` on the machine). `ready(id)` refuses a
  machine not connected yet, so the agent can never trigger a deployment. Tested against the bundled `sshd`.
- **Sessions on a machine** (`src/server/places.ts`): a session's `cwd` is a folder here, or
  `machine:<id>:<path on the machine>`. pi-pocket carries that one string everywhere; `Places.env(cwd)` gives
  `NodeExecutionEnv` or pi-env's `RemoteExecutionEnv` (one lazily started connection per machine), so the agent's
  `bash`, `read`, `write`, `edit` run there with no change to the tools. The prompt's environment section says which
  machine, that its git/gh logins are the machine's, that attachments stay on the phone, and that a command stops ~30 s
  after the link drops; AGENTS.md and skills are not read for a machine (they would be the phone's). The folder picker
  browses the machine through its environment (New folder makes one there). Worktrees are for the phone's folders.
  The Files panel (pi-env's gitignore-aware `listFiles`), the file viewer, images in replies (the image route reads
  them there), Changes, diffs, and undo (git run there through `folder-access.ts`) work on a machine's folder.
  Attachments to a session on a machine are copied to `~/.pi/mobile/uploads/<session>/` there (out of the
  project and its git status), and the message names their paths there; images also go to the model as before.
  Branches (the top bar's chip and the branch sheet) stay phone-only: they read `.git/HEAD` from disk every few
  seconds; on a machine the branch shows in Changes.
- **Pi sessions on a machine**: Continue a Pi session lists a connected machine's `~/.pi/agent/sessions/*/*.jsonl`
  through its environment (first lines only: id, folder, first message as title), copies the chosen file into the
  imported folder with an `.origin.json` beside it, and the preview then defaults to the session's folder on that
  machine (checked there).
- **Terminal** (`src/server/terminal.ts`, `web/terminal.js`): a shell in a pseudo-terminal through pi-env's
  `openTerminal`, on a machine over its connection or on the phone through a local daemon (pi-env's Android build;
  PiService sets `SHELL` to the bundled bash). One WebSocket per terminal at `/api/terminal`, owner only and only
  from the app's own page (`Origin`); input sent before the shell is up is queued. xterm.js 6 (ES modules, served from
  `/vendor/`) in a full-screen sheet with a row of keys a phone lacks (Esc, Tab, sticky Ctrl, arrows). Opened from the
  session menu, the launcher, and a connected machine's row.
- **Self-hosting**: the agent works on a clone of this repo in `home/projects`, pushes, CI publishes a release, and
  the app updates from it (section 5).

## 5. Build

`.github/workflows/build-apk.yml` on every push to `master`:

1. `scripts/package-rootfs.ts`: resolve the Termux package set from the aarch64 index, download, check SHA-256,
   extract without maintainer scripts, rewrite the prefix, drop dangling symlinks, `tar --hard-dereference`
   (Android forbids hard links in app data) to `rootfs.bin`, manifest `termux-packages.json`.
2. `npm ci --omit=dev --ignore-scripts --os=android --cpu=arm64`, then `scripts/package-runtime.ts` tars
   `src/`, `web/`, `package.json`, `node_modules` to `runtime.bin` and writes `runtime-version`.
3. `scripts/versions.ts assets` writes the shell, rootfs, and runtime versions into the APK's assets.
4. `gradle assembleDebug` (one variant: debuggable, for `run-as` over adb) signed with the fixed key from secrets
   (`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, alias `pi-phone`).
5. When the tests and the build pass on `master`, a GitHub release `build-<run>` with `pi-phone.apk`, `rootfs.bin`,
   `runtime.bin`, `termux-packages.json`, and `manifest.json`; the last 10 are kept. The repository is public, so
   the phone downloads without credentials.

### Updates

Three versions (`scripts/versions.ts`): shell (the tracked files under `android/`), rootfs
(`scripts/package-rootfs.ts`, which holds the package list), runtime (the commit). CI reuses the latest release's
`rootfs.bin` while the rootfs version is the same, so a code change does not ship newer Termux packages by accident.

The app (`Updater.java`) reads `releases/latest/download/manifest.json` once per process after the UI loads, and
when the web menu asks (`window.PiPhoneApp.checkForUpdates()`, owner only, shown only inside the app):

- Same shell, different rootfs or runtime: "Update available"; on yes, the parts are downloaded, checked against
  the manifest's size and SHA-256, and handed to `PiService`, which stops the server, swaps them in, and starts it
  again. A few seconds; durable runs continue after.
- Different shell, newer versionCode: "App update available"; the APK is downloaded, checked, and committed through
  `PackageInstaller`; Android asks the user to confirm (needs "install unknown apps" for pi once). Data stays.

Type checking (`tsc`) runs in CI; tests run on the phone (`npm test`) and in CI.

## 6. Tasks

1. Done: remove the old stack (experimental-stack server, `bin/`, `client/`, `contracts/`, Expo `app/`).
2. Done: import pi-pocket at the pinned commit; drop repo extras and the launcher; pin dependencies.
3. Done: billing patch through `configureModels`, `phone-settings.ts`, tests.
4. Done: Android shell, `package-rootfs.ts`, `package-runtime.ts`, CI workflow with a signed APK.
5. Done: cut server and web features (section 3, first list); `check-web-imports.ts` in CI.
6. Install on the phone; verify: runtime extracts, server starts, UI loads, Claude login, one prompt, bash/git/rg
   from the agent, the billing patch on an Opus prompt.
7. No more trimming: the features left in section 3 stay.
8. Done: GitHub sign-in for the app's `git` and `gh` (`github-login.ts`, the GitHub sheet); updates from releases.
9. Self-hosting: the agent works on a clone of this repo in `home/projects` and pushes; the release reaches the app.
