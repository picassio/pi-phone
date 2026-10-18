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
  The Files panel uploads into the open file's folder or the session's (`workspace.putFile`), here or on the machine,
  never over an existing file. The dock says when the session's machine does not answer (`places.reach`, the
  daemon's `hello`); its connection starts again by itself, so Retry is a look.
  Attachments to a session on a machine are copied to `~/.pi/mobile/uploads/<session>/` there (out of the
  project and its git status), and the message names their paths there; images also go to the model as before.
  Branches (the top bar's chip and the branch sheet) stay phone-only: they read `.git/HEAD` from disk every few
  seconds; on a machine the branch shows in Changes.
- **Pi sessions on a machine**: Continue a Pi session lists a connected machine's `~/.pi/agent/sessions/*/*.jsonl`
  through its environment (first lines only: id, folder, first message as title), copies the chosen file into the
  imported folder with an `.origin.json` beside it, and the preview then defaults to the session's folder on that
  machine (checked there).
- **Continue in Pi, and back** (`src/server/pi-handoff.ts`, `web/sheets/pi-handoff.js`): the session's context as
  the model has it (no system messages) becomes a Pi session file (format 3) in the machine's
  `~/.pi/agent/sessions/--<folder>--/`, with a `custom` entry naming the session and entries named `pp<entry>-<n>`;
  `SessionMeta.piLink` keeps the file, Pi's last message both have, the session's last model entry, and the file's
  size. Bring back appends Pi's messages after that one (compactions keep their message, edits apply) when neither
  side went another way; otherwise only as a new session (the machine import). Continue again appends the session's
  new messages to the same file, refused while Pi has unseen messages or after the session compacted past the link.
  The dock's Pi bar checks the file (one `stat`) when the session opens or the app comes to the front.
- **`ssh <name>` from the phone** (`machines.ts`, `ssh-config.ts`): every machine with an accepted host key gets a
  `Host` entry in `~/.ssh/pi-phone_config` (its key only, the app's known hosts and alias, strict checks, `BatchMode`),
  rewritten whenever the machines change and included by its whole path at the top of `~/.ssh/config`, whose other
  lines stay. Phone sessions' prompt names these machines.
- **The PARA wiki** (`src/server/para.ts`, `extensions/para.ts`): pi-para (npm, pinned) on Pi Durable. Its wiki
  (`~/.pi/wiki`), config (`~/.pi/para/config.jsonc`), qmd index and scheduler are pi-para's own, so pi on a computer
  with pi-para shares the format. Its nine `wiki_*` tools are pi-para's implementations wrapped as Pi Durable tools;
  its own `para` skill (read from the package) leads a `wiki` prompt section, ahead of the tools-only rule and the scoped
  context (schema, index, the scope's pages), which is cached per scope until a tool changes the wiki; pi-para's short
  guidance list is left out, the skill covering it.
  A session's scope is found as pi-para finds it, in its folder here or, for a session on a machine, asked there.
  qmd-engine and pi-para run on `node:sqlite` (`QMD_SQLITE_DRIVER=node`, set by `para-env.ts` before they load);
  the runtime package leaves out their bundled better-sqlite3 and qmd's tree-sitter grammars.
  The Wiki page is the module's browser part (`extensions/para-web/`, owner only): the PARA tree, qmd search, pages
  rendered with `[[links]]`, backlinks, freshness, an editor that saves through pi-para's `wiki_write`, and Ask Pi
  (`pocket.compose`). The app's markdown turns `[[page]]` into `#wiki:page` links anywhere; the Wiki page opens them.
  Capture (`para-capture.ts`): a session idle for `wikiCaptureMinutes` (config.json, 20 by default, null: only when
  asked from the menu) with entries past its watermark (`ParaCaptureDoc`) gets those messages, serialized by pi-para,
  under pi-para's capture prompt, sent to the archived "Wiki capture" session, reset first. That session selects only
  `pocket-para-capture` (the wiki tools and `CAPTURE_SYSTEM_PROMPT`), which the default selection leaves out; it runs on
  pi-para's `models.capture`, or the app's default model for "auto". The watermark moves when the capture is sent.
  Wiki settings (a sheet from the Wiki page and the launcher) are the only way people change pi-para's config: the app
  writes `config.jsonc` with pi-para's own `saveParaConfig`, keeping what it does not show. They hold the capture model
  and minutes, the prompt context's budget and schema, the OpenRouter embedding model (from OpenRouter's
  `/embeddings/models`, with `pi-auth:openrouter`; a change reopens the search), and the health checks.
  Search by meaning: qmd embeds through the remote provider and keeps vectors with sqlite-vec, loaded into node:sqlite;
  on Android from sqlite-vec's own release build, `native/android-arm64/vec0.so` (`scripts/sqlite-vec.ts`, checked
  against the release's checksum; `QMD_SQLITE_VEC_PATH`). Never a local model: `QMD_NO_LOCAL_MODELS=1`, and the
  runtime package refuses node-llama-cpp.
  The wiki's files are the tools' alone: the prompt says so, and a hook refuses `write`, `edit`, and non-read-only
  `bash` commands that name the wiki folder (on the phone; a session on a machine works on that machine's files), naming
  the wiki tool to use. It keeps Pi honest rather than being a security boundary; nothing watches the folder, as only
  the tools, the Wiki page, and capture change it.
- **Secrets** (`src/server/secrets.ts`, `extensions/secrets.ts`, `web/sheets/secrets.js`): API keys and tokens Pi uses
  without seeing them, in Settings › Secrets. Each has an env-var name, a value (8+ characters, one line), a
  description, folders it may be used in (none: anywhere), whether machines may use it, and whether each use asks
  first. They are kept in `<data>/secrets.json` (mode 0600, written atomically, in backups like Pi's `auth.json`);
  the routes never send a value back. **Use:** app.ts installs its own `coding-tools` (Pi Durable's four tools), whose
  `bash` has a `prepare` that puts the secrets a command names (`$NAME`, `${NAME}`) into its environment. The stored
  command keeps the name. On a machine, pi-env sends `env` inside the daemon's `exec` request over SSH, never on a
  command line. The extension's `beforeTool` refuses a secret outside its folders and sends ask-first secrets through
  `Approvals`. **Redaction:** values, raw, base64 (with and without padding, and URL-safe), and URL-encoded, become
  `[secret NAME]`. Bash's streamed output goes through `Secrets.guard(env)`, the harness's env wrapped so `exec`'s
  `onOutput` is redacted; it holds back the last `longest-1` characters of each stream, so a value cut across
  chunks is still caught. Every tool's result goes through the extension's `afterTool` (output, details, and
  structured output). A person's message is redacted in `commands.ts` before it is sent. **Asking:**
  `secret_request` is an approval with `form: { type: "secret" }`. Its card (`SecretRequestCard` in
  `transcript.js`) has a hidden field, answered by `POST /api/secrets/requests/<id>` (owner only); a plain Allow is
  refused. `secret_save` runs a command through the unguarded env and stores its stdout. `secrets_list` and
  `secret_request` are allowed in plan mode, as are `wiki_query`, `wiki_read` and `wiki_summarize`. None of this
  is a boundary against a model set on leaking a value; it keeps values out by accident. The approval card's heading
  is now "Pi asks before this … call", no longer Lancet Guard's.
- **Diagrams** (`web/rich.js`, pele 1.6.0 pinned): a ```mermaid block in any Markdown (replies, wiki pages, later
  interview questions) is a rich block of kind `mermaid` (`richKind` in `ui.js`), shown as **Diagram** with its code a
  tab away. pele is one 0.7 MB module, served as `/vendor/pele.mjs` and imported the first time a diagram shows.
  `mount()` draws it with `links: false`, `zoom: "auto"` (pan and zoom when large), and DOMPurify's SVG profile as
  `sanitize`. Its colors are CSS variables (`--pele-*`, set from the theme's on `.rich-diagram-canvas`), so a theme
  change needs no redraw. A diagram pele cannot read shows its error, with the line.
- **Other sessions** (`src/server/session-control.ts`, `extensions/sessions.ts`): the part of PiP that stays, as
  tools in every session: `sessions`, `session_read`, `session_start`, `session_send`, `session_wait`,
  `session_stop`, `approvals` (deny only). They act as the calling session's requester with that person's rights;
  a session never messages or stops itself; messages carry `[via session #N "title"]`; an hourly limit on sends and starts
  per session (the owner's `sessionSendLimit` in config.json, 30 by default or none; a session's own `sendLimit`
  first; the session menu's Other sessions sheet); what is read is fenced as data. No panel, no follows, no repository watches.
- **Notifications** (`src/server/phone-events.ts`, PiService): a session's run ending (with the end of its answer),
  failing, or waiting for an approval becomes an event; PiService long-polls `GET /api/phone/events` with the owner
  token and posts a notification per session while the app is not in front. Tapping one opens the session
  (`/login?next=/s/<id>`, or `navigate` when the app is up).
- **Downloads**: the viewer's Download asks `GET /api/c/<id>/download` (here or on the machine, up to 200 MB); in the
  app the bridge's `download` saves it to Downloads through MediaStore and notifies, elsewhere it is a browser download.
- **Ports** (`src/server/forwards.ts`, `web/sheets/forwards.js`): `ssh -N -L 127.0.0.1:<free>:127.0.0.1:<port>`
  with pi-env's `sshArguments` (without `ClearAllForwardings`); the phone's browser opens `http://127.0.0.1:<free>`.
- **Branches on a machine**: `branches.ts` takes a git runner; on a machine it is the folder access's git, and the
  chip's branch is asked of git there every 15 s (`Workspace.head`), the view rebuilding when it changes.
- **This phone** (`web/sheets/phone.js`): notifications, battery optimisation (the bridge), and **backup and restore**
  (`src/server/backup.ts`): a `.tar.gz` of the data folder (its database through SQLite's backup), `.ssh`,
  `.pi/agent`, `.config/gh`, `.gitconfig`. A restore is checked (only those paths), unpacked to
  `~/.pi-phone-restore`, and swapped in by the next start (`applyRestore`, before the database opens), what was
  there moving to `~/.pi-phone-before-restore/<time>/`.
- **Terminal** (`src/server/terminal.ts`, `web/terminal.js`): a shell in a pseudo-terminal through pi-env's
  `openTerminal`, on a machine over its connection or on the phone through a local daemon (pi-env's Android build;
  PiService sets `SHELL` to the bundled bash). Owner only, and only from the app's own page (`Origin`), at
  `/api/terminal`. A shell outlives its WebSocket (a phone drops it in the background): it waits 15 min with the
  last 256 KB of its output, and a socket with its `id` takes it up again; `close` ends it. Input sent before the
  shell is up is queued. Paste and Select (a finger cannot select in xterm.js) open a text box over the screen. xterm.js 6 (ES modules, served from
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
