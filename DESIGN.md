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
  `files/log/server.log` (appended, never cut). An exception nothing caught is written there with its stack under a
  `FATAL` line before the server exits with 1 (`fatal.ts`).
- One server per data directory, also on phones that end the app's process but not its child (PP-198: the new server
  found `harness.lock` held by a live pid and exited 1). Before each start `PiService.stopEarlierServer` waits for the
  server a destroyed service stopped, and when the lock's pid is this app's `node` running this runtime's `main.ts`
  (`/proc/<pid>/cmdline`, real uid in `/proc/<pid>/status`, not a zombie) it sends SIGTERM, then SIGKILL after 11 s
  (the server's own stop limit is 10 s), writing a `pi-phone app:` line to server.log; another pid is never signalled.
  `onDestroy` stops the server the same way (SIGTERM, SIGKILL after 11 s). The server itself waits up to 10 s for a
  live lock holder (`waitForLock`, the holder's pid and command line logged), then fails with "pi-phone is still
  stopping its earlier server (pid N), so it cannot start. Restart the app." (never a file to delete). Closing, the
  app ends every voice call's sideband first (`VoiceBridge.closeAll`: a close OpenAI does not answer is ended after
  1.5 s, not ws's 30 s) and keeps what was said before the storage closes.
- The status screen (`assets/status.html`, `MainActivity.show`): progress, and a failure with its reason, the log's
  last error on top (a `FATAL` line before any other, with the stack under it), Copy log (its last 256 KB) and Share
  log (its last 4 MB as a file through the share sheet: `LogProvider`, not exported, read grant on the intent only),
  then the log's last 64 KB scrolled to its end (PP-198).
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
(GitHub watches, repository watches, webhooks), the built-in browser, the extension gallery, Lancet
Guard (ONNX), Web Push, the share target, the launcher (access modes, tunnels, QR), and the repo extras (docs
site, nix, lint config).

Drop-ins are back (the owner's decision, 2026-10-26, PP-171; they were cut on 2026-10-17): the owner's own modules in
`<data>/extensions`, loaded after the built-in ones, each off until turned on in Settings › Extensions (see
"Drop-in extensions" in section 4). The gallery that installs them stays out: nothing downloads a drop-in.

Kept on purpose (the owner's decision, 2026-10-17: no more trimming): multiplayer (`collab`, `spend`, people,
invites, roles, peek tiles), theme editing and Omarchy palettes, the Walker-style launcher, and the extension web
layer (`extension-web.ts`, `extension-commands.ts`, `http/extension-routes.ts`, `web/extension-ui.js`). Do not cut
them. pi-pocket's Chromium driver lives on in `test/support/` for the UI tests.

Multiplayer reaches other devices over Tailscale only (the owner's decision, 2026-10-18; no Cloudflare, no LAN mode).
The server always listens on 127.0.0.1 for the WebView (`PiService.java` passes `--host 127.0.0.1`); Settings ›
Access (`web/sheets/access.js`, `GET|PUT /api/access`, config `tailscale`) turns on a second listener on the
phone's Tailscale address (100.64.0.0/10, from the Tailscale app's VPN), with the same handler and terminals
(`src/server/tailnet.ts`). It looks the address up every 10 s and follows it as the VPN comes and goes; while it
listens, `app.access` is that URL, so invite links point there.

Dictation came back on 2026-10-18 (the owner's decision): pi-pocket's `web/voice.js` (mic beside Send, words as they are
heard, Alt+V) as it was. WebView has no Web Speech API, so inside the app `web/android-speech.js` stands in
`SpeechRecognition` on Android's own `SpeechRecognizer` (`Dictation.java`, bridge methods `dictationAvailable`,
`startDictation(lang)`, `stopDictation`, `abortDictation`; events back to `window.__piPhoneSpeech`). Android hears one
utterance per start; the stand-in starts the next one itself while dictating continuously, keeps every result, and ends
after a quiet one. RECORD_AUDIO is asked the first time the mic is tapped. The language is the device's, or the one picked
in Settings › Dictation (`web/sheets/dictation.js`, kept in localStorage per device). Guests in a browser use its own.

pi-phone is also the phone's **digital assistant** (PP-146, from @yichan002's #3): a `VoiceInteractionService`
(`PiAssistant.java`, `res/xml/assistant.xml`) whose session (`PiAssistantSession.java`) is a see-through window over
the app in front, holding a WebView on `/?assist=1` (`web/assist.js`): the web app draws the backdrop and the sheet,
with the transcript's own components once a message went. Android lists an assistant only with a recognition service
of its own, and then makes it the phone's default recognizer; `PiRecognition.java` passes each request on to the
phone's real one, and dictation names that one too (`Recognizers.real`), never "the default", which would be itself.
The sheet cannot ask for the microphone (no activity): it sends the person to Menu › Assistant, where the app's window
can. Until the server answers, the window shows a one-line page and loads the sheet once it does, so nothing is heard
before it can be sent. The app in front comes from the assist data (its activity's package, its name only). The
choices (where the words go, Send or by themselves, the app noted or not) are the server's (`src/server/assistant.ts`),
so Pi changes them through the settings tools; "the last session" is the one the app's window kept in localStorage.

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
- **SSH keys** (`src/server/ssh-keys.ts`, `ssh-agent.ts`, `web/sheets/ssh-keys.js`): the app's keys for machines,
  one per purpose, never as private key files.
  - **Storage:** private keys are in the database (`pocket.sqlite`, table `pocket_ssh_keys`, beside pi-durable's
    tables; it tracks its own schema). Public keys are in `<data>/ssh/keys/<id>.pub`, and names in `keys.json`.
  - **The agent:** `SshAgent` runs OpenSSH's `ssh-agent -D -a <data>/ssh/agent.sock` with the server, gives it each
    key on `ssh-add -`'s stdin, and starts it again if it ends.
  - **Generating and importing:** keys are ed25519 with no passphrase (background work has nobody to ask), and pass
    through a scratch folder in `<data>/ssh` (mode 700) only for `ssh-keygen`.
  - **Moving in:** keys from before (`~/.ssh/keys/<id>`) move in once at startup (`SshKeys.open`). Each must derive
    its public key, is stored, then its files are deleted; a mismatch stays and shows as its row's problem.
  - Each machine is assigned one key (Machines, next).
- **Devices** (`src/server/devices.ts`, `config.ts` `StoredDevice`, `auth.ts`; owner's decisions of 2026-10-19, wiki:
  pi-phone-sign-in-management): each sign-in is a device with a token of its own (sha256 in `config.json` `devices`),
  named from its browser, with created, last seen (written at most once a minute) and address. Login links,
  invites (an owner invite included) and Sign out every device make one (`Auth.signIn`); the cookie holds the
  device's token, so a person's own token never leaves the server. `Auth.session` reads a device's cookie first, then
  an old-style cookie holding a person's token (`legacy`: upgraded to a device on `GET /api/me`, so no one signs in
  again), then `Bearer` (the phone's service, the renderer). `GET /api/devices`: the owner's list is everyone's, others
  see their own; `POST /api/devices/<id>/sign-out`: the owner any, others their own; the device's tabs close (each
  event connection carries its device). `POST /api/sign-out-everywhere`: every other device of the person's, and a new
  token for them (`rotateOwnerToken`, or `rotateUserToken`). Removing a person removes their devices. The phone's app
  (its WebView, `; wv)` from this phone) stays one device, replaced at each of its sign-ins, and signs in again by itself
  through the bridge's `signIn()`. People shows Devices ("Your devices" for others).
  **Recovery code** (break glass, owner's request of 2026-10-19): `POST /api/recovery-code` makes one **only from the app
  on the phone** (the owner's app device, from this phone, no `x-forwarded-for`; others get 403), shown once,
  kept as a sha256 (`config.recovery`), and ends the one before; six groups of four from 31 letters and digits (~120
  bits). `POST /recover` (same site only) with it signs the browser in as the owner, a device of its own, once, and adds a
  `security` phone event (PiService shows those even with the app in front, and opens the app). Wrong codes: 5 in 15
  minutes, then 429 for 15. The sign-in screen takes it as typed (spaces, dashes, capitals).
- **Choice** (`web/ui.js`): the sheets' dropdowns (Web access, Dictation, a machine's key, Ports) in the app's own
  style, the model and branch menus' `.pop-menu` rows, not the system's `<select>`: fixed to the screen under its field (over
  it with too little room), closed by a tap elsewhere, a scroll, a resize, or Escape. **Settings by link:** `/?sheet=<name>`
  opens a settings sheet (`LINKED_SHEETS` in `app.js`), so Pi can screenshot the app's own sheets after changing them.
- **Machines** (`src/server/machines.ts`, `web/sheets/machines.js`): other computers sessions can work on, through
  `@earendil-works/pi-env` (its daemon on the machine, deployed over ssh and verified by hash). `machines.json` holds
  name, `user@host[:port]`, and the SSH key; host keys the owner accepted are in `~/.ssh/pi-phone_known_hosts` under
  one alias per machine (a changed key is refused). Three owner taps before anything runs there: scan the host key,
  accept it, "Install and connect" (deploys the daemon to `~/.pi/mobile/tools` on the machine); or one approval card
  for Pi's `machine_add` (PP-139, `extensions/machines.ts`): it scans the host key of the new address first
  (`Machines.scanNew`, under the id the machine will get, saving nothing), refuses one that is not the fingerprint Pi
  read on the machine itself (`expectedFingerprint`), and shows the address, the key and the host key on the card
  (`form.type: "machine"`, `MachineAddCard`; only the owner approves). Approve adds it, accepts that key, connects;
  Deny or a failed step saves nothing (a key made with `key: "new"` stays, and its public half comes back to Pi).
  `ready(id)` refuses a machine not connected yet, so the agent can never trigger a deployment without the owner's
  yes. Tested against the bundled `sshd` (`test/machines.test.ts`, `test/machine-add.test.ts`).
  **Windows** (2026-10-19): through Windows' own OpenSSH Server (pi-env's Windows daemons, x64 and arm64, are in the
  APK). The daemon runs command lines with Git Bash, so "Install and connect" runs one and refuses a Windows machine
  without it (install Git for Windows). Paths there are drive paths with forward slashes (`C:/Users/tuan`,
  `src/server/machine-paths.ts`): what the daemon answers with `\` (home, folder checks, listings) is turned to `/`
  once, so places, the web's path joins, and Git Bash read them alike. `machine_run` gives Windows the command line
  (Git Bash) instead of `sh -c`; `machine_copy` takes `<machine>:C:/…`. The environment section tells Pi it is
  Windows with Git Bash. Machine tools are not offered there.
  Its **terminal**: pi-env's Windows daemon has no pseudo-terminals ("Terminals are not supported on this system yet"),
  so `Places.terminal` opens one on the phone's own daemon running the app's `ssh -F <config> -tt <alias>` with PowerShell's
  `-EncodedCommand` (cmd.exe dropped the quotes around `C:\\Program Files`), which starts Git Bash `--login -i` in the folder
  (`CHERE_INVOKING=1`). Windows' sshd gives it a ConPTY.
  Adding one, "It's a Windows PC" shows a PowerShell script (`web/windows-setup.js`) with the chosen key in it, to paste
  into PowerShell run as administrator: OpenSSH Server installed by winget (`Microsoft.OpenSSH.Preview`: seconds, with
  progress; Windows Update's optional feature showed none for many minutes, and its DISM module fails in PowerShell 7),
  started, and automatic; the firewall rule
  `OpenSSH-Server-In-TCP` (TCP 22, every profile); the key in `administrators_authorized_keys` when sshd_config has
  `Match Group administrators` (rights by SID with icacls, as sshd demands), else `~/.ssh/authorized_keys`, written as
  ASCII (no BOM); Git for Windows by winget when Git Bash is missing; then the addresses to enter. Each step may run again.
- **Sessions on a machine** (`src/server/places.ts`): a session's `cwd` is a folder here, or
  `machine:<id>:<path on the machine>`. pi-pocket carries that one string everywhere; `Places.env(cwd)` gives
  `NodeExecutionEnv` or pi-env's `RemoteExecutionEnv` (one lazily started connection per machine), so the agent's
  `bash`, `read`, `write`, `edit` run there with no change to the tools. Its preamble (`machinePreamble` in
  `extensions/prompt.ts`) says that, and that every other pi-phone feature works there as anywhere: the wiki (the
  phone's, shared), secrets (bash's env goes to the machine), web tools, `file_to_markdown`, interview, artifacts,
  interactive answers, schedules, subagents, other sessions. A prompt that listed only limits had Pi there believe these
  stayed on the phone; all were checked working there on 2026-10-18. The environment section says which machine, that
  its git/gh logins are the machine's, that attachments are copied there, and that a command stops ~30 s after the link
  drops; AGENTS.md and skills are not read for a machine (they would be the phone's). The folder picker
  browses the machine through its environment (New folder makes one there). **Health:** a machine counts as set up once
  connected, but whether it answers now is `Places.health()`: every set-up machine `reach`ed at once (10 s each),
  kept a minute, with `sshProblem()` saying what a failure means (key refused, host key changed, not reachable). It is
  served at `GET /api/machines/health` (`?fresh=1` checks again). The Machines sheet asks fresh as it opens and shows
  "Answers now" or "Can't connect" with the reason and Check again; the folder picker marks a machine that does not
  answer. Worktrees are for the phone's folders.
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
- **Pi's sessions as tools** (`src/server/extensions/pi-sessions.ts`; owner's decisions of 2026-10-19, wiki:
  pi-session-agent-tools): `pi_sessions` (the phone's or a machine's, a file changed in the last 2 minutes marked busy),
  `pi_session_import` (a machine's copied in with its origin, then continued in its folder there), `continue_in_pi`,
  and `pi_bring_back`: the sheet's and the session menu's own steps through `SessionControl`, as the person Pi works
  for, so the owner's only, as those are. An import counts against the hourly limit, as a start does.
- **Continue in Pi, and back** (`src/server/pi-handoff.ts`, `web/sheets/pi-handoff.js`): the session's context as
  the model has it (no system messages) becomes a Pi session file (format 3) in the machine's
  `~/.pi/agent/sessions/--<folder>--/`, with a `custom` entry naming the session and entries named `pp<entry>-<n>`;
  `SessionMeta.piLink` keeps the file, Pi's last message both have, the session's last model entry, and the file's
  size. Bring back appends Pi's messages after that one (compactions keep their message, edits apply) when neither
  side went another way; otherwise only as a new session (the machine import). Continue again appends the session's
  new messages to the same file, refused while Pi has unseen messages or after the session compacted past the link.
  The dock's Pi bar checks the file (one `stat`) when the session opens or the app comes to the front.
- **The app's own ssh, and none for Pi's bash** (`machines.ts`, `extensions/machines.ts`): the app connects with its
  own ssh, from `<data>/ssh/`.
  - **Its files:** `config` (`-F`: `IdentityAgent` is the agent, `IdentitiesOnly`), `known_hosts`, and the public
    keys.
  - **Who uses it:** `Machines.target()` gives pi-env the public key as `identityFile` with `configFile`, and port
    forwards and machine terminals use the same.
  - **Nothing in `~/.ssh`:** the app's files from before there (`pi-phone_config` and its `Include`,
    `pi-phone_known_hosts`) are moved or removed at startup. The owner's own files and lines stay, and the phone
    terminal's `ssh` is the owner's.
  - **Pi's tools instead:** `machine_run` (one command on a named machine, through `host.envOf`; a machine with
    `askRun` (Settings › Machines' "Pi asks before each command", the setting `machines.askRun`; off by default, as bash)
    shows each command on a card first, at most 1,500 characters, PP-230; secrets as in bash,
    their values redacted, output kept to its last 30,000 characters) and `machine_copy` (one file of up to 100 MB,
    phone to machine, machine to phone, or between machines: `<machine>:<path>`). Or a session on the machine.
  - **The prompt:** the phone prompt names the machines (alias, address, id) and these tools, and says its bash has no
    ssh.
  - **The guard:** the secrets module (required) refuses Pi's `read`, `write`, `edit`, and `bash` on the app's key
    stores (`<data>/ssh`, `pocket.sqlite`, `secrets.json`; `ssh-add` and `SSH_AUTH_SOCK` in commands), and every other
    tool that takes a file on the phone too (`pathsOf`: `browser_upload`, `machine_copy`'s phone side, `file_to_markdown`,
    `doc_image`, `wiki_ingest`, `interview`, `screenshot`, `image_markup`, the screenshot tools' and `browser_save_pdf`'s
    paths; none of them writes into `<data>/extensions`; PP-204), and treats `machine_run` as bash for secrets.
  - **The launcher:** it offers "Terminal: <machine>" for each connected machine.
  - **`pi-ssh`:** for what needs ssh itself (rsync, tunnels, scp), `<data>/ssh/bin/pi-ssh` is `exec ssh -F
    <data>/ssh/config "$@"`. The config has a `Host` per machine with an accepted host key, by its alias, with its
    public key, its host-key alias and strict checks, and `Host *` signing through the agent. The coding tools'
    `bash` puts its folder on the PATH for phone sessions (`prepare` in `app.ts`). Pi uses the keys through the agent
    and never reads them: `pi-ssh <alias> 'cmd'`, `rsync -e pi-ssh`, `scp -S pi-ssh`, `pi-ssh -N -L`. Plain `ssh`
    in Pi's bash and in the phone terminal uses the owner's own `~/.ssh`, for other hosts.
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
  Open questions (pi-para 0.8.5, `pi-para/questions`): tracked lines `- [ ] (date, #session) question`, resolved under
  "Resolved Questions" as `- [x] (date, #session) question → answer`. pi-para lists them in the wiki context and in
  `wiki_read`/`wiki_query` results, and `wiki_write`/`wiki_edit` name the ones new text may answer; the wiki section
  tells Pi its session number ("This is pi-phone session #N") so the lines it writes name it; a capture is sent every
  open question in the wiki (`Para.openQuestionsText`, at most 40) to resolve the ones its session answered; Wiki
  settings set `lint.questionDays` ("Open questions are stale after", 7 by default), after which `wiki_lint` warns.
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
  refused. `secret_save` runs a command through the unguarded env and stores its stdout, for the owner only and after a
  card showing the whole command (at most 1,500 characters; Run and save); a failed command's output is never shown
  (pi-pocket's review of our port, 2026-10-26). The store writes its file from a copy before memory changes, and a
  broken file's log line quotes none of it. `secrets_list` and
  `secret_request` are allowed in plan mode, as are `wiki_query`, `wiki_read` and `wiki_summarize`. None of this
  is a boundary against a model set on leaking a value; it keeps values out by accident. The approval card's heading
  is now "Pi asks before this … call", no longer Lancet Guard's.
- **Extension points for people's values** (from pi-pocket 0.22.0, PP-167; `hidden.ts`, `extension-points.ts`):
  `host.hide`, `host.commandEnv` and `host.ask`, with pi-pocket's names and signatures, beside Secrets rather than in
  its place. **One redaction:** `Secrets` holds the app's `HiddenValues`; given a session, `redact`, `longest` and
  `guard(env, id)` replace its hidden values (`[label]`) with the secrets' forms, longest first, so streamed output,
  every tool's result (the secrets extension's `afterTool`, object keys too), messages, edits sent again and `@` files
  go through the same code. The stream keeps stdout and stderr in order and flushes what it held at an omission
  (pi-pocket's `stream`). A session's values hold in its subagents (`rootOf`). A `!` command holding a hidden value is
  refused: it would be stored as typed. **Command env:** the harness's env is `commandEnvs.wrap(secrets.guard(env,
  id))`, so bash, `!` commands and goal checks (`envFor`) get what providers add; a provider has 5 s, and one that
  throws or hangs adds nothing. What the caller sets (bash's PATH, the secrets a command names) wins over a provider:
  pi-pocket lets the provider win. **Ask:** an approval with `form: { type: "ask" }` (fields, never values), answered
  by `POST /api/asks/<id>` through `answerAsk`, which checks each field (`checkValues`) and hands the values to the
  asker in `ApprovalAnswer.values` only. The person Pi works for answers it (the owner when nobody is known;
  `cannotAllow`), anyone who can steer declines, and a plain Allow is refused. `AskCard` in `transcript.js`; the
  decision is kept with `ask: true` (Answered / Declined). Built-in modules and drop-ins use them; pi-pocket's
  `host.browser` is not ported (Pi's browser here is pi-phone's own).
- **Drop-in extensions** (PP-171; the owner's decisions of 2026-10-26; `reload.ts`, `web/sheets/extensions.js`): the
  loader gets `<data>/extensions`, whose `node_modules` is linked to the app's (`prepareDropInFolder`), so a module
  imports the packages the server runs. The owner puts files there; nothing downloads them, and the secrets
  extension's hook keeps Pi's write, edit and bash out of the folder (an enabled drop-in reloads when its file changes,
  and has the host, secrets included). Each is off until the owner turns it on. **Refused** (`Refused`, kept as
  `ExtensionInfo.refused` beside its error): a drop-in with a tool of a built-in tool's name, refused whole (the
  built-in wins; the owner's choice), and one that returns no extensions and adds nothing. For that one the host it
  gets is a proxy noting the members it looked for that pi-phone lacks, so pi-pocket's browser modules (which return
  nothing without `host.browser`) are refused saying so. Built-in tool names are `BUILT_IN_TOOLS` (a module that is
  off cannot be asked without running it), with every tool installed now but by a drop-in; `test/drop-ins.test.ts`
  turns every built-in module on and fails when one installs a tool the list lacks. A drop-in with a built-in
  module's file name is never loaded (`nameClashes`). Turning one on that is refused answers 409. The sheet shows the
  folder, what drop-ins can use, each drop-in's refusal in the person's language, and the name clashes; the
  `settings` tool's help says the same. pi-pocket's gallery modules (fixtures in `test/fixtures/gallery`): secrets is
  refused for its tools (and, installed as `secrets.ts`, for its file name), browser-sign-in and browser-runs for
  `host.browser`. No `_pocket.d.ts` is linked there: pi-phone has no `types/pocket.d.ts`.
  **Installing** (PP-173; the owner's decisions of 2026-10-26): on the phone the folder is in the app's private
  storage, out of reach of file apps, and the hook keeps Pi out (strictly, the owner's choice), so modules come in
  through the app. Settings › Extensions' **Add drop-in…** uploads a `.ts` or a `.zip` (`POST
  /api/extensions/drop-ins?name=&replace=1`, the owner's); `extension_install` (in `extensions/settings.ts`, the
  owner's; a guest is refused before anyone is asked) reads a file, folder or zip on the phone and asks on a card
  (`form: { type: "extension" }`: path, size, files, what is left out and replaced, the module's first 40 lines;
  Install, the owner only). Both read with `drop-in-install.ts` (its own zip reader: stored and deflate, no zip64 or
  encryption) and install with `PocketApp.installDropIn`: one module `<name>.ts` at the top with `<name>.*` and
  `<name>/` (a lone wrapping folder is read from inside; the rest is left out and said so), no absolute path or `..`,
  no symbolic link, at most 5 MB and 1000 files, never a built-in module's name; what it replaces needs the owner's
  yes (the upload's confirm, the card), and it is switched off (and uninstalled) before its files change. It lands off.
  A `.js` alone is refused: the loader's modules are `.ts`, and a `.js` beside one is its browser part.
  `/?sheet=extensions` opens the sheet.
- **Diagrams** (`web/rich.js`, pele 1.6.0 pinned): a ```mermaid block in any Markdown (replies, wiki pages, later
  interview questions) is a rich block of kind `mermaid` (`richKind` in `ui.js`), shown as **Diagram** with its code a
  tab away. pele is one 0.7 MB module, served as `/vendor/pele.mjs` and imported the first time a diagram shows.
  `mount()` draws it with `links: false`, `zoom: "auto"` (pan and zoom when large), and DOMPurify's SVG profile as
  `sanitize`. Its colors are CSS variables (`--pele-*`, set from the theme's on `.rich-diagram-canvas`), so a theme
  change needs no redraw. A diagram pele cannot read shows its error, with the line.
- **Interview** (`src/server/interviews.ts`, `extensions/interview.ts`, `web/sheets/interview.js`): pi-interview's
  `interview` tool, native. It keeps pi-interview's question format (`single, multi, text, image, info`,
  `recommended`, `conviction`, `weight`, `context`, `content`, `media`, rich options), its checks and normalisations,
  and its words back to Pi (MIT, ported to `interviews.ts`). Questions come inline or as a path, read through the
  session's env. The call is replay-safe. It stores `{ questions, draft, status }` in `InterviewsDoc` by call id, with
  recommendations pre-selected (except `conviction: "slight"`), then waits on `Approvals` with
  `form: { type: "interview", callId, title, count }`. The card (`InterviewCard`) has Answer, which opens the sheet,
  and Skip, which is a deny. The phone notification says "Pi has N questions: title". The sheet saves the draft 600 ms
  after each change (`POST /api/c/<id>/interviews/<callId>` with `action: save`), and `submit` or `cancel` ends it
  and answers the approval. A plain Allow is refused. An optional `timeout` ends it as pi-interview's timeout does.
  Media: images (paths through `fileUrl`, data: or https URLs), tables, Mermaid (pele), HTML (`HtmlPreview`).
  Chart.js charts are not drawn: the tool's description points to Mermaid pie and xychart. Image answers upload to
  the session's upload folder and reach Pi as paths; in a session on a machine, each is copied there as the draft is
  saved (`Workspace.placeUploads`), and Pi gets its path there. `async: true` returns at once with a short id; a
  durable background task (`pocket.interview`) holds the approval instead, and once it ends sends the outcome as a
  follow-up starting "Interview <id> finished." (`src/server/deliver.ts`, shared with `watch_ci`). Allowed in plan mode.
  **Helpers** (`src/server/interview-helpers.ts`, `POST /api/c/<id>/interview-helpers`), for single and multiple choice
  questions while the interview waits, for those who steer, on the session's own model (`src/server/side-model.ts`,
  shared with titles: spend counted, held-back sessions ask nothing): ✦ More options (up to 3, added to the question),
  ↻ Review (a rewrite of the question and options, shown as a proposal; using it renames the draft's choices by
  position), and Ask beside each option (a thread kept in the interview as `asked`, by `<question id>\n<option>`). Docs are copied as JSON, not with
  `structuredClone`: `tx.doc` objects are proxies, which it cannot clone ("#<Object> could not be cloned").
- **Web access** (`src/server/web/`, `extensions/web.ts`, `web/sheets/web-access.js`): pi-web-access's tools, native, with
  the same names and arguments. **`web_search`** searches with the one provider the owner picks in Settings › Web
  access (`config.web.provider`; none: off, with an error saying so). One to five queries run in parallel, and each
  fails on its own. There are 38 providers in `web/providers/`, one `SearchProvider` file each. They are ported from
  pi-web-access 0.42.0 (by three subagents, against `types.ts` and `http.ts`), plus OpenRouter's web plugin (Exa
  engine on gpt-oss-20b, results from its `url_citation` annotations) and DeepSeek's Search API. A provider's key
  has one place: a Pi sign-in for model providers (`{ kind: "pi" }`: openai, google, mistral, xai, kimi-coding, zai,
  deepseek, openrouter, read with `models.getAuth`), otherwise a secret named as pi-web-access's env var
  (`{ kind: "secret" }`, `Secrets.value()`), or none. There is no fallback between providers. A filter an API cannot
  apply throws, with the hint to search without it. Left out: Gemini Web (cookies), OpenAI through a ChatGPT
  subscription, and Bright Data (needs a SERP zone setting). `http.ts` has `request()` (30 s, key hidden in
  errors), `mcpCall()` (for Exa, Parallel and Baizhi without keys), and the filter helpers. **`fetch_content`**
  (`web/fetch.ts`) runs where the session works (`host.envOf(cwd)`): an HTML page goes through Readability over
  linkedom, then turndown; documents (by content type or extension) through markit (`markit-engine`, our fork with
  the Android build); a GitHub repository is cloned `--depth 1` into `~/.cache/pi-phone/github/`, an issue or PR is
  `gh … view --comments`, and a blob is fetched raw; images come back as images (5 MB at most), and text as it is.
  One call's output is held under 30,000 characters and 1,200 lines, shared by its addresses: the harness cuts a tool's
  output at about 2,000 lines, which once dropped the note from the end. A longer text is saved whole to
  `~/.cache/pi-phone/fetch/<hash>.md` (the env's `$HOME`), and the note goes first. Both tools are allowed in plan
  mode. The release build's `npm ci --os=android --cpu=arm64` installs `markit-engine-android-arm64`, and
  `package-runtime.ts` refuses to package without it.
- **Documents** (`src/server/documents.ts`): markit (`markit-engine`, our fork with the Android build) turns files into
  Markdown. Which files are documents is markit's own answer: `documentKind` asks its converters' `accepts()` (by
  name and type), and pi-phone keeps no list of its own. The converters are PDF, DOCX, PPTX, XLSX, iWork (Pages,
  Numbers, Keynote), EPUB, ipynb, CSV/TSV, RSS/Atom, HTML, ZIP, and audio (tags). Images count only with
  `{ images: true }` (`file_to_markdown`), for their EXIF; attached images go to the model as pictures. Text Pi reads
  as it is (plain text, code, JSON, YAML, XML), which markit would only fence, is not converted. A `.xml` is a feed
  only when its type says so. `.xls` and the OpenDocument formats are not markit's. The engine loads on first use. Four places use it:
  - **Attachments:** when a message is sent, each document gets `<file>.md` beside it in the uploads folder. Both go to
    a machine for a session there, and the message line reads `… → as Markdown: <path>.md (size)`. A file markit
    cannot read is a notice, and goes as it is.
  - **`file_to_markdown`** (`extensions/web.ts`): reads through the session's env, so it works on machines; converts
    on the phone; writes `<file>.md` beside the file through the env; returns the text, bounded as `fetch_content`'s.
    Not allowed in plan mode, as it writes.
  - **`fetch_content`:** document URLs. HTML still goes to Readability first, for the article rather than the whole page.
  - **`wiki_ingest`:** a document path on the phone is converted to `<file>.md`, and that file is ingested (pi-para
    reads files as UTF-8).
- **Tool-use rules** (prompt sections, each from its module, so off with it): `asking` (`extensions/interview.ts`:
  choices and multi-part questions go through `interview`, a single yes/no stays in chat), `web` (`extensions/web.ts`:
  research with `web_search` and `fetch_content`, local documents with `file_to_markdown`, not curl), and
  `plan_mode` while plan mode is off (`SUGGEST_PLAN` in `plan.ts`: suggest it before large or risky changes; only a
  person turns it on). They were added after Pi asked a multi-part decision in chat and researched with `gh` and `npm`
  though the tools were there: a tool's description alone did not change the habit, as the wiki's rules had shown.
- **A batch's file and shell calls in order** (PP-203, `batch-order.ts`): Pi Durable runs one answer's calls at once,
  or the whole round one at a time when any tool of it is `sequential`; so `bash` in [edit X, bash `cat X`] could run
  before the edit landed (seen on machine folders, each call a round trip over ssh). `edit`, `write` and `bash` are
  wrapped (`inBatchOrder`): before running, each waits for the tool tasks of the `edit`, `write` and `bash` calls before
  it in the round (`LiveDoc.tools`, in the model's order, read at the call's start; `waitForTask`, so a restart keeps
  the order). Other tools stay parallel, with these too. Not `executionMode: sequential`: that would serialize every
  tool of the round. Code mode's nested calls are not round slots; a script awaits them in its own order.
- **The reminder on edits by script** (PP-100, PP-206; `extensions/prompt.ts`): a bash result gets one line ("this
  command wrote files by script…") when the command writes files by script (`writesByScript`: sed or perl -i, `cat >`,
  tee, a program's writeFileSync or open(…, "w")) and one of the files it names is a project file. Not a project
  file: under /tmp or $TMPDIR (as written, or the server's TMPDIR), a name with `.local.`, or one git ignores in the
  session's folder (`git check-ignore` through `host.run`, here or on the machine; outside a repository nothing is
  ignored). A write that names no file it can read (a variable, a path built in the program) keeps the reminder.
  Relative names are the session folder's; a `cd` in the command is not followed.
- **Languages** (PP-81, PP-236): English, Simplified Chinese (`zh-CN`) and Vietnamese (`vi`). The list is in
  `web/i18n.js` (`LANGUAGES`, Auto by the browser's tags), `src/server/i18n.ts` (phone notifications, Auto by Android's
  locale), `PocketApp.LANGUAGES` and `appearance.language`; Pi's prompt says the person's language (`section("language")`).
  Each language has `web/i18n/<id>.json` (sentences), `<id>.server.json` (server messages) and Android's
  `res/values-<qualifier>` (zh-rCN, vi). `scripts/i18n-check.ts` reports each catalog and fails on a placeholder that
  differs; `--missing <id>` and `--missing <id>.server` list what one lacks. Vietnamese wording: `web/i18n/vi.glossary.md`.
- **Settings and extensions:** each feature's settings are in Settings (the menu), and follow its module.
  - **Extensions' own rows:** an extension adds its row with `pocket.menu`, which the menu lists with the app's settings
    and drops when the module is off. The wiki's "Wiki" row opens its settings sheet; the Wiki page has no Settings
    button of its own any more.
  - **Web access:** a core sheet, shown only while `pocket-web` is loaded (`webAvailable()` in `commands.js`, from
    `server.extensions`), in the menu and the launcher alike.
  - **Secrets:** required (`REQUIRED` in `reload.ts`), like the system prompt. Bash gets values from the app itself,
    so turning the module off would keep values flowing while dropping their redaction from other tools and the
    ask-first approvals.
  - **Diagrams and documents:** core, with no module to turn off.
  - **The Extensions sheet** lists Secrets, Interview and Web access by title, in `ORDER`.
- **Math** (`web/math.js`, KaTeX 0.19.0 pinned): a marked extension turns `$…$`, `\(…\)` (inline) and `$$…$$`,
  `\[…\]` (display; as a block only at a line's start, inside a sentence it stays inline) into
  `<code data-math="inline|display">` placeholders, with the TeX as text. `data-math` is the one data attribute
  added to the sanitizer's. A single `$` follows pandoc's rule (it opens before a non-space, closes after one, and
  not before a digit), so prices stay text. `Markdown` calls `drawMath` after every render: it loads KaTeX (`/vendor/katex/katex.mjs`
  and its CSS; `katexFile` in `http/assets.ts` serves the module, the stylesheet, and the woff2 fonts) the first time,
  and replaces each placeholder with KaTeX's output (`trust: false`, `throwOnError: false`). A drawn one stays,
  because Preact leaves unchanged HTML alone, so there is no cache to clear. In `ui.js`, sanitizing skips
  `code[data-math]` (no path links, no inline-code part).
- **OfficeCLI** (`src/server/officecli.ts`; owner's decisions of 2026-10-18): Word, Excel, and PowerPoint files.
  - **Binary:** the fork picassio/OfficeCLI's Android release (`android-v1.0.157`: NativeAOT for `linux-bionic-arm64`,
    one 52 MB binary; the CoreCLR folder build crashes on bionic). `scripts/officecli.ts` fetches it in CI, checked
    against its sha256, into `native/android-arm64/officecli/` (gitignored); `package-runtime.ts` refuses without it.
    Bundled in the APK, as the owner chose.
  - **Pi's bash:** `<data>/bin/officecli`, a wrapper written at start-up, on the PATH of phone sessions' bash (beside
    `pi-ssh`). It sets `LD_LIBRARY_PATH=$PREFIX/lib` (Termux's OpenSSL 3: Android's BoringSSL libssl aborts every
    command), `OFFICECLI_SKIP_UPDATE=1`, and `OFFICECLI_NO_AUTO_INSTALL=1` (a bare `officecli` installs itself into
    other agents' config folders). No wrapper tool: it is a CLI made for agents (JSON output, element paths).
  - **Skills:** OfficeCLI's 11 (`third_party/officecli/skills/`, at the fork's commit), with each install section
    replaced by "already installed, never install or update it" (its README). Offered as `SkillSources.builtIn`, after
    every other skill place, so one of the owner's by the same name wins; only where OfficeCLI runs.
  - **Files viewer:** a .docx/.xlsx/.pptx that is binary to the viewer shows in an iframe of
    `/a/office/<conversation>?path=` (`Workspace.officePage`: read as a download is, here or on the machine, then
    `officecli view <file> html` with no resident process), in the artifacts' sandbox CSP. `hello`'s
    `server.officecli` says whether it runs.
  - **Machines:** see Machine tools.
- **Screenshots** (`src/server/screenshots.ts`, `extensions/screenshot.ts`, `android/.../Renderer.java`; owner's decision of
  2026-10-18): Pi sees what it made. `screenshot({ artifact | path | url, widths = [390, 1280], fullPage, settle })`
  asks the app's service, which long-polls `GET /api/phone/renders` (beside `/api/phone/events`), to draw the page in an
  off-screen WebView of the app (on a private virtual display of its own at density 1, laid out at the page's size, at most
  4000 px tall; the picture is the frame the GPU composed, since `view.draw` into a canvas misplaced composited layers,
  PP-10). Before the frame, the page runs `layoutCheck()` (`layout-check.ts`): what spills out of its box or its parent and
  a page wider than the screen, with sizes, printed under each picture, signed in with the app's cookies and the owner
  token on its own pages; it posts JPEGs to `POST /api/phone/renders/<id>` and Pi gets them as images. Artifacts render
  at `/a/<conversation>/<id>/latest`, HTML and SVG files at `/a/file/<conversation>?path=` (artifact sandbox), Office files
  at `/a/office/`. Without the service polling (tests, a server not on the phone) a render fails at once, saying so.
  Allowed in plan mode. A `seeing` prompt section asks Pi to look before calling an artifact done; Effective HTML's and
  OfficeCLI's pi-phone notes point to it.
- **Server edition** (`--platform server`, PP-20; the owner's decision of 2026-10-20, board epic PP-19): the same server in
  Docker (`Dockerfile`, `deploy/`), behind Caddy. `main.ts` runs as `phone` unless told `--platform server` (the image sets `PI_PHONE_PLATFORM=server`). On a
  server, Pi's browser is a `ChromeEngine` with its profile kept in `~/.pi/mobile/browser`, screenshots come from
  `chrome-renderer.ts` (a headless Chrome that takes the render requests the phone's service would, and signs in only to
  the app's own address), OfficeCLI is the Linux build, and there is no Tailscale serving. Its tools are fetched by
  `scripts/server-tools.ts` from the machine tools' pinned releases. The image is built on the machine
  that runs it (`docker compose up -d --build`; the owner's decision, 2026-10-20: not in CI), and checked with
  `deploy/smoke.sh`.
- **Team edition** (PP-21; `src/gateway/`, `src/controller/`, `deploy/compose.yaml`): a **gateway** in front of one
  pi-phone container per person.
  - **Sign-in:** better-auth 1.7.12 on the gateway's `node:sqlite` file, with password, the twoFactor (TOTP) and passkey
    plugins, and admin with roles owner and member. Sign-up is off: accounts come from the setup token and invites.
    Migrations run from the options before better-auth starts, so its schema check sees the tables.
  - **The gateway's data** (`store.ts`): the setup token, invites, and each person's key and owner token.
  - **Forwarding:** everything outside `/auth/` goes to the person's container, HTTP and WebSockets, with that
    container's owner token (`PI_PHONE_OWNER_TOKEN`, which `ConfigStore` takes) and none of the browser's cookies.
    pi-phone's own sign-in, invites, devices and people routes are refused.
  - **Containers:** they carry `PI_PHONE_GATEWAY=1`, so the menu offers the gateway's account page and its sign-out.
  - **The controller** (`controller.ts`) holds the Docker socket alone, has no network, and serves a Unix socket with a
    shared secret. Each person gets `pp-user-<key>` on `pp-net-<key>` (with only the gateway attached) and `pp-data-<key>`,
    with CapDrop ALL, no-new-privileges, no published ports, a PID limit and memory/CPU caps.
  - **Hardening** (PP-26; deploy/README.md › Security has the route table):
    - **8080 only from Caddy:** `proxy-guard.ts` lets in the addresses of `PP_TRUSTED_PROXY` (Docker DNS, looked up again
      on a miss at most once a second). Containers share networks with the gateway, so they could otherwise call sign-in
      directly with a made-up `X-Forwarded-For` and dodge better-auth's per-address limit.
    - **Origin on changes:** non-GET `/auth/gw/*` needs Origin equal to `PP_ORIGIN` (the Lax cookie still reaches a
      same-site, cross-origin page, such as another tailnet machine). Pi's `#teamCall` is in-process and exempt.
    - **Sign-in audit:** a better-auth `hooks.after` (`onSignInFailed`) records failed password, TOTP, backup-code and
      passkey steps with the email and Caddy's address; 429s from the limiter (before hooks) are recorded by the
      gateway on `finish`, once a minute per address.
    - **Bodies:** `readBody` answers 413 past its limit and 400 for anything but a JSON object (it was a 500).
    - **Backups** include `boards/` (`pocket.sqlite`, `wiki.sqlite`, `documents.sqlite`) through `VACUUM INTO`
      snapshots; before, shared boards, project wikis and team documents were left out.
    - **Caddy** adds `X-Frame-Options: SAMEORIGIN` only where the app sent none (`?`; a plain `header` replaced the
      gateway's DENY, seen live) and a `Permissions-Policy` (camera,
      microphone, geolocation for self only).
  - **Sharing sessions** (PP-53; wiki `projects/pi-phone-shared-sessions`):
    - **Base path** (`web/base.js`): the app's URLs are relative to `<base href>`, which `serveApp` writes from
      `x-pocket-base` only when it matches `/space/<key>/<write|watch>/` (the gateway sets it and strips a client's).
      Routes stay `/s/<id>` inside the app; `at()` and `routeOf()` convert at the address bar. Import-map addresses
      start with `./`; `import()` and `new URL()` use `document.baseURI`.
    - **Scoped accounts** (`extensions/sharing.ts`, `shares.json`): one per teammate per level, writer `guest` and
      watcher `viewer`, with `User.team`; today's guest and viewer rules apply. The sharer's pi-phone sends the
      gateway each teammate's whole list with the account's token (`/internal/shares` put), which `pp_space` keeps.
    - **Gateway** `#space`: 404 unless shared; forwards with the scoped token and the base; terminal refused.
    - **Teammates' limits:** `refuseTeammate` (files, branches, undo, shell), `cannotAllow`, and `mayUseMachines`
      in the policy and secrets hooks.
    - **Continue in mine:** `PiHandoff.sessionFile` → gateway `copy` (checks the share; the sharer's own token on
      `/api/x/sharing/export/<id>`) → `piSessions.import` + `continuePiSession` in the teammate's pi-phone.
    - **Tools:** `sessions_shared`, `session_share` (card), `session_unshare`.
- **Custom roles** (PP-22):
  - **The gateway** keeps roles in its own tables (`pp_role`, `pp_user_role`), with `roles.ts` holding the catalogue and the
    seeded roles. better-auth only ever sees owner/member, and people actions go through its internalAdapter, since its
    admin API wants its own admin. Every gateway route checks a permission, and `pp_audit` logs the changes.
  - **Each person's pi-phone** gets its role's policy (`policy.ts`) on `POST /api/policy`, sent by the gateway before it
    forwards anything and again when the policy changes; browsers can't reach that route.
  - **How a pi-phone applies it:**
    - **Extensions:** browser.ts, web.ts and machines.ts are turned off without their permissions (byPolicy), and
      `setExtensionEnabled` refuses turning them on.
    - **Tools:** the required `extensions/policy.ts` refuses the rest (secrets, settings, machine tools) and tells Pi what the
      role leaves out.
    - **Routes:** api.ts refuses the routes in `ROUTES`, and terminal.ts the terminal.
    - **Models:** modelList, configure and submit hold to the allow list.
    - **Spend:** the monthly cap counts from what the person had spent when the month began.
    - **The page:** `server.policy` lets the menu, rail and launcher leave items out (`roleAllows`).
- **Idle stop and always on** (PP-33):
  - **The gateway** counts what is open to each person's pi-phone: forwarded requests, a page's event stream, and
    WebSockets. It also notes when each was last used, and sweeps every minute with the controller's list (`GET /people`).
  - **A running pi-phone stops** when nothing is open to it, it is past the server's idle minutes (`pp_setting`
    idle_minutes), and its `GET /api/activity` (owner only, refused from browsers) says it is not busy. Busy means
    anything in Running now; waiting approvals don't count.
  - **A visit during a stop** waits for the stop, then starts the container again.
  - **Always on** (`pp_always_on`): never stopped, and `#keepUp` starts the container if the list shows it stopped,
    then sends the role's policy, trying for 30 s while it boots.
- **Rolling updates** (PP-34):
  - **Controller:** the list marks each container `current` when its image id is the people image's. `ensure` makes
    again a container of an older image, keeping its volume: when it's stopped, or with `renew` while it runs (stopped
    gracefully first).
  - **Gateway:** after the idle stops, the sweep renews running, non-busy, outdated containers one at a time. Visits wait
    on it through `#starting`, and each must take its role's policy before the next one starts.
  - **A gateway made again** is on no person's network. Before asking a running container it hasn't reached, the sweep
    goes through `ensure` (`#doing`).
- **Export and backup** (PP-35):
  - **Controller:** `export` streams a person's `/data` through Docker's archive API, from a helper container
    (`pp-export-<id>-<random>`, labelled `export`). The helper has the volume read-only and no network, is never
    started, and is removed when the stream closes.
  - **Gateway:** a person export is `/auth/gw/people/<id>/export`, gzipped as it streams. The server backup is
    `/auth/gw/backup`: a `VACUUM INTO` copy of the gateway's database plus each person's tar, kept in a temp folder
    (sizes must be known for the headers) and written by `tar.ts` (ustar).
  - **Who:** both need `server.manage`, since they hold everyone's sign-ins and secrets. The seeded Admin doesn't get
    it. Restore is documented, and was rehearsed on the devbox, in deploy/README.md.
- **Effective HTML** (`third_party/effective-html/`; owner's decision of 2026-10-18): plannotator/effective-html's 7
  skills (MIT, at commit `975b047`) for HTML artifacts: `html` (router), `design-artifact`, `html-wireframe`,
  `html-prototype`, `html-plan`, `html-diagram`, and `big-pics-little-words` (by name only). Built-in skills of every
  phone session (`SkillSources.builtIn`, first among the app's, after the owner's). Each gets one marked note: publish with
  the `artifact` tool, self-contained, phone widths first, say what could not be checked. Plan mode's prompt points long
  plans to `html-plan`, as an artifact beside the numbered list.
- **Machine tools** (`src/server/machine-tools.ts`; owner's decisions of 2026-10-18): command-line programs run where
  bash runs, which in a session on a machine is the machine, so OfficeCLI, ripgrep, and fd are installed there.
  - **Catalog** (`TOOLS`): OfficeCLI 1.0.157 (upstream's builds for linux/darwin x64 and arm64, the fork's NativeAOT
    build for Termux on Android), ripgrep 15.2.0 and fd 10.5.0 (static musl builds for Linux and Android, and macOS),
    each pinned with its sha256 (OfficeCLI's and rg's from their releases; fd publishes none, so the files'). rg and fd
    are offered only when the machine has none of its own. **Windows** (2026-10-19): the projects' own Windows builds
    (OfficeCLI's `.exe`, rg's and fd's `.zip`s, x64 and arm64), installed by the same script in Git Bash (curl, sha256sum,
    `unzip -p` for a zip); a program keeps its `.exe`, and the wrapper execs it by its drive path (`C:/Users/…`).
    **Computer use (ocu)** (PP-177, `OCU_TOOL`): our fork's release v1.1.2-pp.2 of open-computer-use
    (picassio/open-computer-use: password fields marked `[password]` and typing into them refused unless the call says
    `allow_password_input: true`, which pi-phone sends only for the owner's take-over input and a saved secret by name), linux-x64,
    linux-arm64 and windows-x64, pinned to the release's SHA256SUMS; command `ocu`; `desktop: true` puts "needs a
    desktop session on Linux" beside it in every list. Computer control (`computer-control.ts`) runs `ocu mcp`.
  - **Install:** the machine downloads each itself (curl or wget), checks the sha256 (sha256sum or shasum) before
    keeping anything, into `~/.pi/mobile/tools/<tool>/<version>/`, and a wrapper `~/.pi/mobile/tools/bin/<command>`
    (marked `# pi-phone-tool <id> <version>`, written by a quoted heredoc) runs it with what it needs (OfficeCLI: no
    self-update, no self-install; Termux's OpenSSL on Android). Older versions are removed. OfficeCLI's skills are copied
    with it (`<version>/skills/`, a tar from the phone's `third_party/`).
  - **Where it shows:** adding a machine lists the tools, ticked, under "Install and connect"; after connecting, the
    ticked ones the machine has a build of (and, for rg and fd, has none of) are installed. Pi's `machine_add` card lists
    them too, ticked (`form.tools`, PP-177); Approve sends the ticked ids (`POST /api/approvals/<id>` `{allow, tools}`,
    refused when the card did not offer one), and the tool installs those the machine offers once connected
    (`toolsToInstall`). A tool that fails leaves the machine added and says why. A connected machine has
    Install tools: each tool's state there (installed and its version, the machine's own, not installed, no build),
    offered ones ticked. `GET /api/machines/tools` is the catalog; `POST /api/machines/<id>/tools` the status, or
    `{install: [...]}`. What is installed is kept as `Machine.tools` (machines.json).
  - **Sessions there:** bash's command gets `PATH="$HOME/.pi/mobile/tools/bin:$PATH"` first (`prepare` in `app.ts`);
    the environment section names the installed tools; the skills section lists the installed tools' skills at their
    paths on the machine (`machineToolSkills`), which Pi reads there.
  - **Tests:** `remote-session.test.ts` serves a tool from a local HTTP server; its sshd runs with `SetEnv HOME=` the
    test's folder, so nothing reaches the real home.
  - **Tests** stand in a script for the binary (`test/officecli.test.ts`); `openApp` turns OfficeCLI off, as on the
    phone the real binary would run.
- **Interactive answers** (Open Intelligent UI): Pi writes a program in OpenUI Lang 1.0, and a frame draws it with
  Open Intelligent UI's component library: layout, inputs bound to `$state`, charts, tables, MapLibre maps with OSRM
  street routes, Wikipedia photos, KaTeX math, SVG, flashcards, 59 `@functions`. It shows in a reply as an
  `openui`-fenced block (rich-block kind `openui`, view "Answer"), or as an artifact of type `openui`.
  - **Source:** `third_party/open-intelligent-ui/`, the library from commit `0321343` (MIT), with its README listing
    what was kept and our two changes, each marked `pi-phone:` in the code.
  - **Build:** `scripts/intelligent-ui.ts` (esbuild, which also runs on Android) builds `src/frames/intelligent-ui.tsx`
    plus the library into `web/vendor/intelligent-ui/`. That is ES modules split so icons, MapLibre and KaTeX load
    on use (about 25 MB, mostly about 5,000 one-icon chunks), the CSS and fonts, and MapLibre's worker as one module.
    It is gitignored, built in CI before the Android install, and `package-runtime.ts` refuses to package without it.
    The dev dependencies (React 19.2.3, `@openuidev/react-lang` 1.0.0, MapLibre 6.14.0, lucide-react 0.562.0, zod
    4.6.6, esbuild 0.28.2) are pinned to the source's lockfile.
  - **Frame:** `/a/openui`, or an `openui` artifact's page (`openUiPage` in `http/artifacts.ts`: the program as
    JSON with `<` escaped), runs under the artifacts' CSP sandbox with an opaque origin. Its files come from
    `/vendor/intelligent-ui/` with `Access-Control-Allow-Origin: *`, which module scripts from an opaque origin need.
    MapLibre's worker is fetched and started from a Blob URL, because a worker cannot start from another origin.
  - **Messages** (the frame and `web/openui.js`'s `OpenUiFrame`; only the parent's or frame's window counts):
    - `iui-ready`, then `iui-program` with the program (null for an artifact, whose page holds it), theme, and the
      state kept for this answer, which the renderer takes as `initialState`;
    - `iui-state`: the renderer's `onStateUpdate` (form fields and `$` bindings). The page keeps it 600 ms after the
      last change, or on leaving, at `PUT /api/c/<id>/answer-state/<key>` (`OpenUiStateDoc` in `openui.ts`, the newest
      200 per conversation, 64 KB each; viewers read, those who steer write). The key is `answerKey`: FNV-1a hashes of the
      program for a block, or of the artifact's address (with its version) for an artifact;
    - `iui-fetch` for `/api/wiki`, `/api/image-search` and `/api/street-route`, which the frame's `fetch` sends to the
      app, which asks `GET /api/openui/<name>` signed in (`src/server/openui.ts`, ported with their caches);
    - `iui-ask`: `@ToAssistant`'s words, with form values and context, submitted as the person's message;
    - `iui-size`: the frame's height.
  - **Guide:** `openui_guide` (`extensions/openui.ts`) returns a pi-phone preface plus their prebuilt system prompt
    (`system-prompt.txt`, about 8,500 tokens), on request. The `interactive_answers` section says when to use it.
  - **Tests:** `test/openui.test.ts` renders the guide's three examples and a map, chart and math program with the
    library in Node (`renderToString`, stylesheets emptied by a plugin), with no errors.
- **Other sessions** (`src/server/session-control.ts`, `extensions/sessions.ts`): the part of PiP that stays, as
  tools in every session: `sessions`, `session_read`, `session_start`, `session_send`, `session_wait`,
  `session_stop`, `approvals` (deny only). They act as the calling session's requester with that person's rights;
  a session never messages or stops itself; messages carry `[via session #N "title"]`; an hourly limit on sends and starts
  per session (the owner's `sessionSendLimit` in config.json, 30 by default or none; a session's own `sendLimit`
  first; the session menu's Other sessions sheet); what is read is fenced as data. No panel, no follows, no repository watches.
- **Notifications** (`src/server/phone-events.ts`, PiService): a session's run ending (with the end of its answer),
  failing, or waiting for an approval becomes an event; PiService long-polls `GET /api/phone/events` with the owner
  token and posts a notification per session while the app is not in front. Tapping one opens the session
  (`/login?next=/s/<id>`, or `navigate` when the app is up). A `limit` event: a run began to wait 10 minutes or more
  for a provider's limit (once for the wait, Providers' switch).
- **Waiting out provider limits** (PP-135, from pi-pocket 0.21.0; owner's decisions of 2026-10-24): `limits.ts`
  classifies a failed request (status and limit headers from a recording `fetch`, or the text); `limit-gate.ts` wraps
  `models.streamSimple` between `timing.ts` (inside) and the image guard (outside) and waits inside the request, keyed
  by provider id for an account's limit (each account `anthropic~work` waits alone) or `provider/model`. The time is the
  provider's reset, else the account's usage bars (`usage-limits.ts`, a full window's reset), else growing gaps; the
  owner's hours (default 6) are a ceiling only, and a weekly window, billing or a sign-in fails at once. pi-phone never
  switches by itself; side requests (titles, interview helpers, image descriptions) pass `noWait`. **The account card**
  is not a Pi Durable approval (those belong to a tool call, and a request inside a generation phase has none): it is
  derived from the gate's in-memory wait and the other accounts' usage bars, shown in the waiting conversation's root
  session (`limitOffers` in the view), and answered by `POST /api/c/<id>/limit/answer`. It is durable through the
  replay: after a restart the replayed request waits again and the card comes back, unless the answer was given; the
  gate keeps the answers (Wait: `declined`; Move: `moved`, so the replay goes to the new account at once) and the
  long-wait notices sent (`told`) in `provider-limits.json` with the gate. Move sets the waiting conversation's model
  (`conversation.configure`) and sends the same request through the other account's provider id in the same stream;
  a subagent's move sets its root session's model too (the session's own model id under that account). The card
  lists every account that qualifies (same base provider, same model, allowed by the role, signed in, no closed gate,
  every window under 100%; `#qualifies`) in a dropdown (`Choice`, the app's own), each with the use of the window that
  ran out, and one Move for the account picked (the first until another is picked): the
  person's own first, then team accounts (`isTeamAccount`, `~team-` in its id, or registered from the team server),
  marked `team` ("(team)") as they spend the team's subscription, each the emptiest first. The person chooses; the
  answer names the account, which is checked again with fresh usage (`recheckLimitAccount`): refused, the card is made
  again and the refusal says why. The older usage banner over the composer hides while a card is up. The notice's "at HH:MM" is
  in the server's zone (the phone's own for the app's notification) and, for a web push, in the zone the browser told
  when it turned notifications on (`PushSubscriptionRecord.zone`). The team server never waits: `/internal/llm/stream` adds the provider's status and limit headers to an error line
  (`facts`), and the pi-phone marks the failed message with them (`withFacts`) for its gate.
- **The Browser panel's pictures** (`PiBrowser.#startFrames`, PP-199): while a tab watches, a capture first (`surface:
  false`, 5 s), then the screencast. A capture is held as long as the page's main thread is busy (headless Chrome, a
  big dialog rendering), and a still page's screencast sends nothing: when no picture came 4 s after the cast started,
  the frames start again after 2, 4, 8, 16, then every 30 s; after 3 tries the state says why (`pictureError`) and the
  panel shows its last picture with a bar, or the error with Retry (`POST /api/browser/frames`). A failed frame
  acknowledgement (which would end the cast) starts it again. The last picture is kept (`lastFrame`) and sent to a tab
  that starts watching, so a panel opened while Pi is not browsing, or while the cast runs for another tab, shows it.
- **The Browser panel's stream** (PP-200): the event stream says only that a picture is there (`browser-frame`: its
  number and size); the panel keeps one request waiting at the server for the next (`GET /api/browser/frame?after=N`,
  a JPEG, up to 2 s, then the event stream's word starts it again), decodes it off the main thread
  (`createImageBitmap`) and draws it on a canvas, so a slow link or phone gets the newest picture, never a queue. A
  frame is acknowledged to Chrome at once while the tabs keep up (they took the one before), else when taken or after
  500 ms. The panel says how big it draws the picture (`POST /api/browser/watch` with `width`/`height`: its box ×
  `devicePixelRatio`, at most 2) and the cast is that size (the largest watcher's; at most twice the page, 1600 px).
  Take over: a tap's two mouse events go at once; keys and text go without waiting for the page (Pi's own presses still
  wait for a navigation). `node test/perf/browser-stream.ts [local|tailscale|slow]` measures it (a throttled link to
  a headless Chrome, the panel in another).
- **Onboarding** (PP-232; plan `projects/pi-phone-onboarding`): the first-run welcome's state is per person in
  config.json (`User.welcome`: absent shows it, `done`, `skipped`). A config from before it (no `onboarding: 1`)
  marks everyone done once, so only new pi-phones (a team member's own included) welcome their owner; guests never get
  it. `hello` sends `user.welcome` (`show` / `done` / `skipped`); `POST /api/me {welcome}` and the setting
  `onboarding.welcome` (Pi's setting_change) set it, and the person's tabs hear `welcome`.
  The welcome (`web/welcome.js`, over the app at z-index 18, under the sheets so a sign-in's dialog and Providers open
  on top): 1 language (`POST /api/me {language}`; the page loads again in it), 2 a model (the providers' OAuth
  sign-in for anthropic, openai-codex, github-copilot, openrouter, "An API key" opens Providers; behind the gateway with
  team models, a radio list sets `defaultModel`), 3 this phone (the bridge: notifications, run unrestricted, mic, the
  side key; read again on `visibilitychange`) or this browser (web push, the install prompt). Full screen on a phone, a
  card when `min-width: 960px`. Test: `test/welcome-ui.test.ts` (devbox).
  Getting started (PP-235): `app.gettingStarted` (`POST /api/getting-started`; Menu › Getting started, the welcome's
  "Get started with Pi") opens the owner's session again (`User.guide`, back in the active list) or makes one titled
  "Getting started" in the default folder, on a model there is, and sends "Show me around." in their language (the page's
  for "auto"); with no model it is refused (409) and the web app shows the welcome instead. The built-in module
  `onboarding.ts` adds a prompt section in that session (read the `getting-started` skill: `src/skills/`, a built-in
  skills folder) and the `guide` tool (set / tick / untick / finish) that keeps `GuideDoc`, which the view sends as
  `guide` and `web/guide.js` shows as a bar under the header (one line on a phone, the list on wide screens); `finish`
  settles the session. Tests: `test/onboarding.test.ts`, `test/getting-started-ui.test.ts` (devbox).
  `show_screen` (same module, owner's decision C): a card in the chat with an Open button for one of the app's sheets or
  Android's settings (`SCREENS`; the bridge's `openSettings`, `openNotificationSettings`, `runUnrestricted`, `askMic`,
  only in the app); nothing opens without the tap. Settings a guide needed: `dictation.language` (per person,
  `User.dictation`; their devices follow it, Menu › Dictation sets it) and `notifications.device` (target: a web push
  device; off forgets it, on only on the device itself).
  What's new (owner's decision G): release notes in `whatsnew/<version>.md` (packaged with the runtime and the Docker
  image), a header of `title`, `date`, `big` (`whats-new.ts`). The newest big release's card (`hello`'s
  `user.whatsNew`; `User.whatsNewSeen`) shows on the session list (phone) and the home screen (wide) for the owner
  past the welcome; a new owner's welcome counts it as seen. Show me marks it seen and opens Getting started with
  `whatsNew` (Pi reads the file, the skill's What's new topic); Dismiss marks it seen; `onboarding.whatsNew` shows it
  again.
- **Image guard** (`image-guard.ts`, outermost on `models.streamSimple`): no image over 2000 px a side reaches a
  model (Anthropic refuses them in a request of more than 20 images). Sizes come from the headers; only bigger ones are
  scaled by Photon, one at a time. The whole history goes with every request, so each scaled image is kept by a
  SHA-256 of its base64 in an LRU of 32 MB and 128 images (`ImageCache`): scaled once per process (PP-198: 15 images
  scaled on every request, until the phone's server died). A failure in the guard (the Photon worker, WebAssembly out
  of memory) never fails the request or the server: one log line, the image goes as it was, or, in an Anthropic request
  of more than 20 images, a text note takes its place; the failure is cached too.
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
- **Phone control** (PP-141, part A of epic PP-140: this phone; owner's decisions of 2026-10-25, wiki:
  `resources/sim-use-phone-control-research`): Pi reads and operates other Android apps on the phone.
  - **Android:** `PiAccessibility.java` is an accessibility service in pi-phone's own APK (config
  `res/xml/phone_control_service.xml`: window content, gestures, screenshots, interactive windows, view ids; both window
  events, so the node cache behind `getRootInActiveWindow()` stays fresh). It is off until the owner turns it on in
  Android's Accessibility settings (Android 13+ first wants App info › ⋮ › Allow restricted settings for a sideloaded
  app). `PhoneControl.java` long-polls `GET /api/phone/control` like `PiBrowser.java` and answers
  `POST /api/phone/control/<id>`: `status`, `front`, `apps`, `tree` (windows; the nodes of the app in front only, short
  keys, children fetched in parallel, a password field's text never sent), `tap`, `press`, `swipe` (`dispatchGesture`),
  `type` (`ACTION_SET_TEXT` on the node the server names, found again by window id and child path and checked to be
  where it was read, or the focused field; never a password field; Enter is `ACTION_IME_ENTER`, Android 11+), `button` (global actions), `open` (the app's launch
  intent, from the service, which Android lets start activities from the background), `shot` (`takeScreenshot`, Android
  11+, JPEG at most 2000 px, with the screen's size), `banner` (a `TYPE_ACCESSIBILITY_OVERLAY` over the status bar, "Pi
  is using your phone · N min" with Stop, and an ongoing notification with Stop). Ported from lycorp-jp/sim-use's
  bridge (Apache-2.0, `third_party/sim-use/`); no HTTP server on the device, no adb.
  - **Server:** `phone-control.ts`: the channel (`PhoneRequests("phone control")`), control sessions per device
  (`phone` now; other phones with pi-phone and devices behind a machine are later kinds of `PhoneDevice`) kept in
  `phone-control.json` with who approved, the conversation, the apps, the home screen's package and the end, so a
  restart keeps them; a timer and every call end them at their time. `phone-outline.ts` renders the tree as an outline
  numbered `[n]` like the browser's controls (port of sim-use's `AndroidOutlineRenderer` and friends: regions
  Top/Content/Bottom and toolbars, lists with their row count, clickable wrappers folded into their label, skeleton and
  dividers left out, a popup over the app listed alone, the keyboard; unlike sim-use a full-screen scrollable list stays,
  so Pi can scroll it by number).
  - **Scope:** a session touches only the apps on its card and the home screen; another app needs another card, unless
    the card follows along (`follow`, the owner's choice of 2026-10-25, after Samsung's Settings › Battery turned out to
    be another package): an app that comes to the front right after Pi's tap, long press or typing in one of the named
    apps joins (`followed`, saved, shown in the live line). One step only: not from a followed app, nor after back, home
    or recents, nor from the home screen. `screen()` reads again once an app joins, as the service held its nodes back.
    Never:
  `io.piphone` (Pi must not tap its own cards), the built-in lists (`NEVER_GROUPS`: banks and wallets, global and
  Vietnamese, crypto; password managers and authenticators) and the owner's own list, which only the owner changes, in
  Menu › Phone control (no tool: the owner's decision, an exception to "a tool for everything"). The server checks the app
  in front (`front`) before each act but open, back and home, renders only an allowed app, and sends the scope
  (`allowed`, `never`, `until`, and the apps' names) with every scoped request; the service checks it again against the
  app in front at that moment, refuses a session the owner stopped on the phone even before the server hears of it, and
  shows the session's banner again before it reads or acts when it is not up (pi-phone's process started again in a
  session the server kept), so Pi never has the phone without the banner.
  - **Tools** (`extensions/phone.ts`, permission `phone.control`, which the gateway's catalogue does not have, so no role
  on the team server has it; the owner's Pi only; plan mode blocks them): `phone_control` (start = a card, `form.type: "phone"`,
  `PhoneControlCard`, only the owner approves; stop; status), `phone_screen`, `phone_act` (tap, long_press, type a text,
  never into a password field, swipe, scroll, button, open_app, wait; each answers with the screen after it; typing a
  saved secret by name is for a later round), `phone_screenshot` (marks by element or area, in screen
  pixels). A device parameter, `phone` by default, for the later kinds.
  - **Stop:** the banner's and the notification's Stop (the service posts `POST /api/phone-control/stop` with the owner
  token), the session's live line in the app (`PhoneControlLine`, from `server.phoneControl` in hello and
  `phone-control` events to the owner's tabs), `phone_control stop`, or adding one of its apps to the Never list.
  Pi's next call says how and when it ended.
- **Voice** (PP-185, tasks PP-186 to PP-194; owner's decisions and approved plan of 2026-10-27, artifact `plan-voice`;
  wiki: `resources/codex-voice-for-pi-howaboua`): a voice call with the session's Pi, and Codex dictation, on the
  owner's openai-codex (ChatGPT) sign-in.
  - **Core** (`src/server/voice.ts`, PP-186): the token comes from the model runtime's auth (refreshed when it ran out)
    and stays on the server: never in what the page gets, the logs, a refusal's words (OpenAI's error text has it taken
    out) or the transcript. The page holds only the media.
  - **How a call is set up**, per live model, as the model check found it for this sign-in (and Settings › Voice says
    it): `key` (the server mints a 60 s key with `POST /v1/realtime/client_secrets` carrying the call's whole
    configuration, the page posts its SDP to `/v1/realtime/calls` with it and names the call, `rtc_…`), `server`
    (minting refused with 401/403 but a call is not: the page gives the server its SDP, the server posts it with the
    sign-in), or `codex` (`gpt-live-*`: ChatGPT's private calls endpoint, `intent=quicksilver`, never used unless picked).
    Not a fallback: each model's way is what the check found, shown with it. Checked live on 2026-10-27: minting,
    calls with a key or the sign-in, and joining a call by id all accept the Codex token.
  - **The model check** mints a key per candidate (and posts a made-up SDP offer only where minting is refused or for
    Codex's endpoint): a 404 hides the model. Setting a live or dictation model, a voice or a language checks it the
    same way first (a voice with the live model, a language with the dictation model); a refusal says OpenAI's reason
    and nothing is kept. Kept in `config.json` (`voice`, only what differs from the defaults; `voiceCheck`).
  - **Settings** (`voice.*` in the settings tools, owner only): live and dictation model, engine (android or codex),
    voice, language (auto or a code), mode for new sessions (work, chat, think), turns (hands-free: semantic VAD that
    stops the voice when you talk; tap; hold), progress (text or answer), cueSeconds (20), reader (live or device),
    dailyLimit (minutes or none), noise (near_field, far_field, off), eagerness (auto, low, medium, high),
    autoMuteSeconds (0 to 600, 0), muteKey (off, headset, volume, both; headset), proximityMute (false), vad (semantic,
    server; semantic), vadThreshold (0 to 1, two places; 0.7) and vadSilenceMs (200 to 3000; 500). A session's
    own mode in `SessionMeta.voiceMode` (`sessions.voiceMode`).
  - **The mic in a call** (PP-201: people near the owner were heard after he finished). Every change of the mic goes
    through one place (`setMic` in `web/voice-call.js`): the track off (nothing is sent) or on, the view, the
    notification (`update`: Muted / Unmute), and the server (`POST /api/voice/calls/:call/mic {muted, by, turns}`, in
    order; `VoiceCall.muted`, `micBy`, `turns`; a call begins with Settings › Voice's turns, muted for hold). The
    bridge's `session.update` on a mode change uses the call's turns, not Settings › Voice's. `by` says who: you, tap,
    auto, proximity, key, notification, hold.
    - **Tap to talk** (`turns: tap`): turn detection stays semantic VAD (it is what ends the turn); the mic opens with
      a tap and closes at `input_audio_buffer.speech_stopped` or `committed`, so what is said after the owner's turn is
      never sent. A call starts open for its first turn (starting it was the tap); switching to tap in a call starts
      closed. With Codex's `gpt-live` the turn ends only if its channel sends those events (untested).
    - **The quiet** (`autoMuteSeconds`, hands-free only): counted from the voice's end (`response.done`, again at
      `output_audio_buffer.stopped`; the device reader's last reading) and from the mic turning on; talking
      (`speech_started`) or the voice starting again stops it; still speaking when it ends counts again. Off (0) by
      default: hands-free stays as it was, and the owner turns it on where he wants it.
    - **Keys** (`muteKey`): "mic" from the app toggles the mic (tap: a tap; hold: the first press opens as holding
      does, the next commits and asks for the answer). A headset's button: `VoiceCallService` holds a `MediaSession`
      only during the call (playing state, so Android routes media buttons to it), HEADSETHOOK / PLAY_PAUSE / PLAY /
      PAUSE. The volume keys: only while the app's window (`dispatchKeyEvent`) or the side-key sheet
      (`onKeyDown`/`onKeyUp`) is in front, and then they do not change the volume; not a `VolumeProvider` (that would
      take the volume keys away everywhere). The notification's Mute toggles the same way.
    - **Proximity** (`proximityMute`, off by default: a speakerphone call is never at the ear). The rule: at the ear =
      the proximity sensor near (below its own range, at most 5 cm) and the phone not face down (accelerometer z above
      -7 m/s²). Away for 0.5 s is "away": the mic mutes (`by: proximity`); at the ear for 0.3 s is "ear": it turns on
      again only if the sensor muted it, never a mic the owner, tap to talk or the quiet muted. Hold to talk ignores it.
      A phone without the sensor says so once (a notice naming the setting); the call goes on.
    - **The view**: a wide mic button in words above End (Mute / "Mic off · Tap to unmute" on `--err-soft`; in tap to
      talk "Tap to talk" in the accent / "Listening"), in the voice view, the side panel and the assistant sheet (one
      `CallControls`); the status says why it is off (the quiet, the ear); Hands-free / Tap to talk / Hold to talk.
  - **Hearing in noise** (PP-195): calls and Codex dictation carry `audio.input.noise_reduction` (`{type: near_field |
    far_field}`, or null for off; `noiseReduction`), and hands-free's semantic VAD the setting's `eagerness`
    (`turnDetection`; low waits longer for the turn's end, which helps in noise). The page's own `session.update`
    (Hands-free / Hold to talk, `callInput` in `web/voice-call.js`) carries both from the same settings, so it never
    drops them. OpenAI took both noise types (calls and dictation), null, and each eagerness with the ChatGPT sign-in
    (2026-10-28, minting only: `~/work/tmp-ocu/codex-noise-check.mjs`); any other value is a 400, as the fake OpenAI
    answers too. The page also asks the mic for the browser's echo cancelling, noise suppression and gain control.
  - **Turns by loudness** (PP-201, `voice.vad: server`): semantic VAD has no loudness threshold, so people talking
    near the owner could start a turn. With server, hands-free and tap to talk use `{type: server_vad, threshold:
    vadThreshold, silence_duration_ms: vadSilenceMs, interrupt_response: true, create_response: mode !== think}`
    (OpenAI's prefix padding, 300 ms), in the key, the bridge's updates and the page's (`callInput`); Codex dictation's
    `server_vad` gets the same threshold and silence (with semantic it keeps OpenAI's defaults). 0.7 by default, above
    OpenAI's 0.5: by loudness is for a noisy place. Semantic stays the default (calls as they were). OpenAI took
    thresholds 0 to 1 and silences 200 to 5000 for calls and dictation, and `create_response: false`, and refused 1.5
    and -1 with a 400 (2026-10-28, minting only: `~/work/tmp-ocu/codex-vad-check.mjs`); the fake OpenAI answers the
    same.
  - **Minutes** in `SpendDoc.voice` by day (seconds of calls and of Codex dictation), shown in Spend; a call or a
    dictation is refused once today's minutes reach the daily limit. Calls are in memory: a restart ends them.
  - **Bridge** (`src/server/voice-bridge.ts`, PP-187): once a `key` or `server` call is named, the server joins it by id
    (`wss://…/v1/realtime?call_id=`, the sign-in's headers) and sends `session.update`: the call's whole configuration
    but the model, its instructions with `<startup_context>` (the session's title and its last ~6000 characters of
    the owner's messages and Pi's text) and, in "Pi works", the tools `ask_pi({request})` and `stop_pi()`. ask_pi
    submits `[voice] request` (`VOICE_PREFIX`) as the owner's message, steering a busy Pi, answers the tool at once and
    asks for the ack. The bridge follows the session's view: Pi's new text is queued in pieces (`speechChunks`: two
    sentences, then paragraphs; `speakable` drops code and Markdown) and each goes as a system item (`Pi says: …`) with
    `response.create` only when no response runs (the next after `response.done`); a tool call with no text is a cue
    (`Pi is working: bash …`) when nothing was spoken for `cueSeconds`; with progress `answer` only Pi's last text,
    when the run ends. "Pi thinks": no tools, `create_response: false`; each transcript of the owner goes to Pi as it
    is and Pi's words are read out (`Read aloud: …`). Codex's `gpt-live` has no sideband: the page passes the data
    channel's events (`POST /api/voice/calls/:call/events`) and gets the server's as `voice` events; a
    `delegation.created` goes to Pi and Pi's words to `delegation.context.append` (channel `speakable`). OpenAI
    closing the sideband ends the call (its minutes count).
  - **Transcript** (PP-188): a request handed to Pi is the owner's message `[voice] …`, shown with a "voice" mark. What
    else was said goes in a `pocket.voice` entry (`VOICE_ENTRY`, `Commands.voiceTurns`, written when a response ends:
    the owner's words unless they went to Pi in that response, and the voice's) shown as quiet rows. What the voice says
    for Pi (Pi's words read back, cues) is not kept again. In "Chat only" the entry carries a model message
    (`[voice chat, before this message] …`), so Pi gets the talk with its next message, as `Commands.note` does;
    otherwise none: Pi never sees it. Secrets are redacted as in messages; export and peeks show the rows.
  - **The view** (PP-189, `web/voice-call.js` the call, `web/voice-view.js` the view): the message box's waveform button
    (beside the mic, which stays dictation) starts a call in the session, one at a time in the app. The page asks the
    server for the call (`POST /api/c/:id/voice/call`), opens the mic (echo cancelling, noise suppression), makes an
    `RTCPeerConnection` with the mic's track and a data channel (`oai-events`), and posts its offer: with the key to
    OpenAI (`connect-src` allows exactly `…/v1/realtime/calls` besides the app's own server, `voiceConnect` in
    `http.ts`; OpenAI answers with `Access-Control-Allow-Origin: *` and exposes `Location`, checked 2026-10-27) and names
    the call (`joined`), or to the server (`sdp`). The key is used once and not kept. The view is a `PanelHost` panel
    (`voicing` before the browser's and computer's): full screen over the chat on a phone, at the right on wide screens;
    Back or × hides it and the call goes on (the button, lit, shows it again). It is built from the assistant sheet's
    parts (`assist-words`, `assist-wave`, `assist-controls`, one loud button) and the panels' bar, with the session's
    last turns above: what you say as heard and what the voice says (the data channel's transcription and transcript
    deltas), a wave from the mic's or the voice's loudness (Web Audio analysers), Mute (the track disabled: silence
    goes, the call stays), End (red), Type instead, the status with the time, and Hands-free / Hold to talk for this
    call (a `session.update` on the data channel: semantic VAD, or none; holding enables the track and clears the
    buffer, letting go commits and asks for an answer, not in "Pi thinks"). A pending approval shows "Pi needs your
    OK": approvals stay a tap in the chat. The mode chip (and a Voice row in the model chip's menu) sets the session's
    mode; a call going on follows (`VoiceBridge.modeChanged`: a new `session.update`, no hang-up). The call going (not
    End) after 50 minutes starts it again, with the session's context; earlier, the view says it ended. A spoken
    request's title is its words, not `[voice]`.
  - **Settings › Voice** (PP-190, `web/sheets/voice.js`, Menu › Voice, `?sheet=voice`): the live models of the last
    check with their way (`short-lived key`, `through pi-phone`, `Codex's own · private`), Check again, voice (the
    realtime voices; the server checks the pick with the live model), language (auto or a code), the defaults for new
    sessions, progress and cue seconds, reader, dictation engine and model, the daily limit and today's minutes. Each
    choice is `POST /api/settings {voice}`, checked as Pi's `setting_change` is. Settings › Dictation has the engine too.
    **Codex dictation** (`web/codex-dictation.js`): a SpeechRecognition-shaped recognizer `voice.js` uses when the
    engine is codex (the owner's, WebRTC and a mic at hand): a short-lived key for a transcription session
    (`POST /api/voice/dictation`), the page's own offer to OpenAI, `…transcription.delta` as words coming and
    `…completed` as settled, one result per item; Stop commits the buffer and waits up to 2.5 s for the last words, then
    ends (`…/dictation/:id/end` counts its seconds). **Spend** shows voice minutes today and this month, and the daily
    limit (Change opens Settings › Voice).
  - **The app** (PP-191, `VoiceCallService.java`, `VoicePage.java`, `MainActivity.java`): the WebView's
    `onPermissionRequest` grants `RESOURCE_AUDIO_CAPTURE` only to the app's own origin (`http://127.0.0.1:8787`), only
    for audio (anything else asked is denied whole), and only once Android allows pi `RECORD_AUDIO` (asked then, the
    first time; the request waits for the answer). The page tells the window of its call through `PiPhoneApp.voiceCall`
    (`{state: start | update | end, session, title, muted, muteKey, proximity, handOver}`, `web/voice-call.js`): a foreground service
    (`foregroundServiceType="microphone"` and `FOREGROUND_SERVICE_MICROPHONE` declared for a later targetSdk; at 28 a
    plain foreground service keeps the mic) shows the call's notification (`Notification.CallStyle.forOngoingCall` from
    Android 12, with Mute; before, an ongoing notification with Mute and End; a chronometer; a tap shows the call), and
    holds the audio: focus `GAIN_TRANSIENT` (voice communication), `MODE_IN_COMMUNICATION`, and the route (Android 12+:
    `setCommunicationDevice` to a BLE or SCO headset, else wired or USB, else the speaker; before: Bluetooth SCO when a
    headset is there, else the speaker unless wired), all given back on end. Mute and End reach the page as
    `__piVoiceAction("mute" | "end")` (`VoiceCallService.page`, set by the window whose call starts). While a call runs
    the WebView's renderer keeps its priority hidden (`setRendererPriorityPolicy(IMPORTANT, false)`); the WebView is
    never paused. The window going (swiped away) ends its call and the notification. A notification tap opens
    `/s/:id?voice=show`; `?voice=start` starts a call there (`voiceFromShell`).
  - **Pi thinks and its reader** (PP-193): the live model never answers (`create_response: false`, no tools); each
    transcript of the owner goes to Pi as `[voice] …`; Pi's words (`speechChunks`) are read by the reader setting.
    `live`: a system item `Read aloud: …` and `response.create` with "read it exactly as written", one response at a
    time. `device`: the server sends the page `voice {call, say}` (`BridgeHost.say`) and the page reads it with the
    device's own voice, one after another (`readOut`): in the app Android's text-to-speech (`Speech.java`, the bridge's
    `speakAvailable`/`speak(id, text, language)`/`stopSpeaking`, events to `__piPhoneSpoken`; voice-communication
    audio, the phone's engine as the person set it up: pi-phone runs no model for it), in a browser its speech
    synthesis. The language is Settings › Voice's (the device's own for auto). Talking over it (`speech_started`) or
    holding to talk stops it and drops what waits. A device with no voice does not start a call in Pi thinks with this
    reader: it says to pick the live model (no other reader takes its place). OpenAI's text-to-speech is not a reader:
    `/v1/audio/speech` refuses the ChatGPT sign-in (429 `billing_not_active`, checked 2026-10-27,
    `~/work/tmp-ocu/codex-tts-check.mjs`). The reader's first name, `android`, reads as `device`.
  - **The side key and home** (PP-192): `assistant.talk` (`dictate` or `call`, Menu › Assistant's "When the sheet
    opens", Pi's `assistant.talk`). With `call` the sheet starts a call in its target session instead of listening (a
    new session is made first); its waveform button (while listening, after sending, after nothing heard) does so for
    this time. The call's controls (`CallControls`, shared with the voice view) take the sheet's foot, the session's
    transcript above. The sheet's WebView grants the mic like the window's but cannot ask Android: without it the sheet
    says so and sends the person to pi-phone. The sheet's bridge `voiceCall` starts the same notification; when the
    sheet hides (`onHide`) it calls `__piVoiceHandOver` (the page ends its call with `handOver`, so the notification
    stays) and starts the app's window with `EXTRA_VOICE_START` (and `EXTRA_VOICE_BACK` unless Open took the person
    there): the window starts a new call in the same session (startup context carries the talk so far) and, once it is
    up, goes back behind the app that was in front (`moveTaskToBack`). A call ended while it is still being set up ends
    on the server too (`STALE` in `voice-call.js`). Home: **Voice** beside New (the session list; on the desktop's home
    beside New session; in the sidebar only its waveform) makes a session titled Voice in the default folder and calls
    in it, with Settings › Voice's mode and turn-taking for new sessions.
  - **Routes:** `POST /api/c/:id/voice` (mode), `POST /api/c/:id/voice/call` (start), `GET /api/voice`,
    `POST /api/voice/check`, `POST /api/voice/calls/:call/{sdp,joined,end}`, `POST /api/voice/dictation[/:id/end]`,
    `POST /api/settings {voice}`. Tests: a fake OpenAI (`test/support/fake-openai.ts`).
- **Computer control** (PP-178, epic PP-175; owner's decisions of 2026-10-26, mockup v3; wiki:
  `resources/open-computer-use-for-pi-phone`): Pi reads and operates desktop apps on the owner's machines, through
  Computer use (ocu, the machine tool of PP-177), as phone control does Android apps.
  - **Transport:** one `ocu mcp` per control session, from its start to its end (ocu keeps each app's element numbers in
    its own memory), as `ssh <pi-env's sshArguments> sh -c '<script>'` with the machine's key: JSON-RPC lines over its
    stdin and stdout (`ocu-client.ts`, calls one at a time). The script checks the ocu wrapper
    (`~/.pi/mobile/tools/bin/ocu`), runs the machine's **desktop setup line** (Menu › Computer control, or Pi's
    `computer_control setup`, whose new line waits for the owner's card, PP-230; kept in `computer-control.json`: the
    owner never edits a file) and execs `ocu mcp`. ocu
    finds the desktop's display and buses itself; a virtual desktop's environment script goes in the setup line.
    Linux only for now: Windows' sshd runs in session 0, where UI Automation sees no window, so it waits for PP-179 (a
    task in the desktop session); the tools say so.
  - **Server** (`computer-control.ts`): sessions per machine (one at a time), kept in memory; a restart ends them (their
    ocu and window went with the server; `ended` says so) while the Never list and setup lines stay. Every call is
    checked before ocu gets it: the session's apps by name or window title (and, with `follow`, apps that appear in
    ocu's list right after Pi acted in a named one: one step, never the Never list); never pi-phone itself (its window's
    app name), the phone's two groups as desktop names (`NEVER_GROUPS`, matched in an app's name, id and window title)
    or the owner's own list (Menu only; adding one ends a session using it); no `set_value` into a `[password]`
    element, no `type_text` or character key while the focused element is one (ocu's outline, `computer-outline.ts`;
    pi-phone's ocu build refuses too); an element number only while ocu's newest read still has the same element there
    (the panel's reads renumber: Pi reads again when it moved); and nothing while the owner has taken it over.
  - **The window on the machine** (`SIGN`): a GTK 3 window through python3-gi (which ocu needs on Linux anyway), on
    top, never taking the focus, "Pi is using this computer until HH:MM" and Stop, its app named `pi-phone` (so never
    controlled). It is a second ssh process: `ready` when shown (the session starts only then, else nothing starts),
    `stop` when pressed; it goes when its input closes. Stop pressed while ocu still starts ends the session at once.
  - **Ends:** at its time, on Stop (the machine's window, the panel's foot, Menu › Computer control), `computer_control
    stop`, 20 s after Pi's run ends unless another starts (`runEnded`/`runStarted`, as phone control), a Never-list
    change, or ocu ending.
  - **Tools** (`extensions/computer.ts`, permission `computer.control`, not in the gateway's catalogue: owner only, not on
    the team server; plan mode blocks them): `computer_control` (start = a card, `form.type: "computer"`, machine, apps,
    the minutes Pi asks for, 5 to 60, required; stop; status, with a machine its apps; setup), `computer_screen` (ocu's
    outline and the time left), `computer_act` (click, double or right click by element or by a point of the window's
    picture, set_value, type_text, press_key, scroll, secondary_action, wait; answers with the window after it;
    set_value and type_text take `secret: "NAME"` instead of value or text, as `browser_type` does: the secrets
    module's hook checks the folder, machines and ask-first (`browserSecretNames` covers `computer_act`), the value goes
    to ocu alone with `allow_password_input: true`, and what Pi reads, the panel's status and the card say
    `[secret NAME]`. A password field takes only that: plain text or a character key there is refused before ocu,
    pointing to `secret` or the owner's Take over. A card for the owner to type into a field (as `browser_sign_in`) is
    not built yet),
    `computer_screenshot` (PNG, marks by element or area). ocu cannot start apps: Pi asks the owner to open one.
  - **The panel** (`web/computer-panel.js`), built from the browser panel's parts and classes (`pb-*`): the top bar's
    monitor button, docked where Files and the browser go (one panel at a time; `computerOpen`), covering the screen on
    phones with the small preview above the message box while Pi acts. Tabs are the session's windows; the status line
    is what Pi does; the picture is ocu's screenshot (`computer-frame` events to tabs that watch,
    `POST /api/computer/watch`), after each action and every 3 s while watched and Pi is not acting, with the box on
    the element Pi last acted on (`.cu-hit`, in fractions of the window); the foot has the session, minutes left and
    Stop. **Take over** (owner's choice B): Pi's calls are refused until Hand back; a tap on the picture is ocu's click
    at that point, text and keys (Enter, Backspace, Tab, Escape, arrows) go to the field in focus, a password field too
    (owner's decision 2026-10-27: the owner may type passwords there; Pi never types one as text). Only these calls
    send ocu `allow_password_input: true` (ocu 1.1.2-pp.2's per-call opt-out), so ocu's own guard stays for every
    other call. Each answer says whether the focus is in a password field; the panel's hidden field is then
    `type=password` (`autocomplete=new-password`), as the browser panel's. What the owner types is never logged, put
    on the panel's status or box, or kept. Routes: `GET /api/computer?session=`, `watch`, `tab`, `take-over`, `input`, `stop`.
  - **Menu › Computer control** (`web/sheets/computer-control.js`, phone control's parts): the setup steps, each machine
    (state, setup line with Save and Check, which lists what ocu reads, Stop), the Never list, how cards work.
    `GET /api/computer-control`, `never`, `prepare`, `check`, `stop`.
  - **Tests:** `test/support/fake-ocu.ts` answers ocu's MCP for a few apps (a demo window with a password field, an
    editor, 1Password, a ticker whose numbers move, a help viewer opened from the demo) and plays the window on the
    machine; `computer-control.test.ts` and `computer-tools.test.ts` (the tools through the app);
    `computer-control-ui.test.ts` (Chromium: the card, the panel, take over, the sheet).
- **Terminal** (`src/server/terminal.ts`, `web/terminal.js`): a shell in a pseudo-terminal through pi-env's
  `openTerminal`, on a machine over its connection or on the phone through a local daemon (pi-env's Android build;
  PiService sets `SHELL` to the bundled bash). Owner only, and only from the app's own page (`Origin`), at
  `/api/terminal`. A shell outlives its WebSocket (a phone drops it in the background): it waits 15 min with the
  last 256 KB of its output, and a socket with its `id` takes it up again; `close` ends it. Input sent before the
  shell is up is queued. Paste and Select (a finger cannot select in xterm.js) open a text box over the screen. xterm.js 6 (ES modules, served from
  `/vendor/`) in a full-screen sheet with a row of keys a phone lacks (Esc, Tab, sticky Ctrl, arrows). Opened from the
  session menu, the launcher, and a connected machine's row.
- **The session list** (`web/sessions.js`, after T3 Code's sidebar v2, MIT, owner's choices of 2026-10-19): a scope
  picker (`pocket.sessionScope` on the device: `all`, `group:<id>`, `folder:<cwd>`, `archived`) in place of the tabs;
  sections Pinned, Active (newest first; a group's `task` sessions under its `lead`), and Settled (folded; `open:settled`
  in `pocket.closedGroups`). `settledOf(session)`: never while busy or waiting; `SessionMeta.settle` `{state, at, reason}`
  settles until activity (`updatedAt` past `at` + 10 s), or keeps active (Un-settle); otherwise a day idle settles.
  Sessions get `group` (`{id, title, role}`) from an extension (`host.groupSession`: a project's team) and `settle` from
  the Settle action (`POST /api/sessions/<id> {settled}`), `session_settle`, or `host.settleSession` (a task run ended, a
  branch merged). Rows: where (project, folder, machine), pin, time or working time (`busySince`); title; task ref and
  branch, or why it settled; status on the right.
- **Self-hosting**: the agent works on a clone of this repo in `home/projects`, pushes, CI publishes a release, and
  the app updates from it (section 5).
- **Projects** (extension `extensions/projects.ts`, off by default; the store is `projects.ts`): project boards whose
  tasks people and Pi share. Tables `pocket_projects`, `pocket_project_members`, `pocket_tasks`, `pocket_task_links`,
  `pocket_task_comments`, `pocket_task_sessions`, `pocket_task_activity`, `pocket_board_sessions` in `pocket.sqlite`
  (so backups hold them). A project has a key (`PP`); tasks are numbered in it (`PP-12`).
  - **Shared and personal parts** (PP-38, `boards.ts`):
    - **Shared:** projects, members, tasks, links, comments, activity, and who worked on what. Everything reaches it
      through the async `Boards` interface. Here that's `localBoards` on the same store; on the team server it will be
      the gateway's board service (PP-39).
    - **Personal:** places, runs, board mode and main sessions stay on `Projects` itself.
    - **`Team`** takes both.
  - **Board rules for sharing** (PP-39), in the store, so the phone and the gateway apply the same:
    - **Roles:** members are lead, member or viewer (`pocket_project_members.role`); a board's owner and the app's
      owner lead it, and only leads manage members.
    - **Team boards:** `owner = TEAM`, managed by `Person.managesTeam`, with `open` letting everyone see them as
      viewers. `Person.seesAll` sees every board and changes none.
    - **Unsharing and leaving** give the person's tasks, and their Pi's (`pi:<id>`), back to nobody, with a comment.
      `forgetPerson` hands a gone account's boards to the team.
    - **Pi's actor** carries its session's `closer`, so "Pi never closes what it worked on" works without board mode.
- **The board service** (PP-39, `src/gateway/boards.ts`):
  - **Where it lives:** the team server keeps the shared part of every board in the gateway, on its own
    `/data/boards/pocket.sqlite`.
  - **How pi-phones call it:** `POST /internal/boards { method, args, pi? }` on the gateway's internal port (8081),
    which only their networks reach and Caddy never sends to. The owner token identifies the pi-phone (`boxByToken`).
  - **The actor** is made by the gateway from that pi-phone's person, never taken from the call. Rights are live,
    from the role: projects.create, projects.share, projects.delete, projects.team, and projects.view_all looks logged.
  - **Sessions** are kept as `<key>:<number>`.
  - **Personal fields** (folder, places, main session, autoRuns) are refused.
  - **Lookups:** the store's internal ones (taskById, projectById, allProjects, sessionsOf) only show what the
    person sees.
  - **Removing an account** calls `forgetPerson`.
- **Pi-phones on the board service** (PP-40, `remote-boards.ts`):
  - **The switch:** behind a gateway (`host.teamServer`: `PI_PHONE_GATEWAY_URL` from the controller, plus the owner
    token), `Boards` is `remoteBoards`, and every board call goes to the gateway.
  - **The mirror:** each pi-phone mirrors the boards its person sees into its own store (`Projects.mirror`), so the
    personal parts work unchanged. It follows in full on start (`sync`), after each write, and on the gateway's push
    (`POST /api/x/projects/changed`, which the gateway refuses from browsers). A board no longer seen is
    `unmirror`ed: its runs are stopped, and their sessions are told.
  - **Personal fields** are kept here only (`personalOf`, `setPersonal`) and laid over answers. `update` splits them
    off.
  - **Sessions:** the pi-phone's own come back as plain numbers; others' stay `<key>:<n>`.
  - **Pushes:** the gateway tells every running pi-phone about each change, so one taken off a board lets it go. A
    task given to someone's own Pi ("pi" from them becomes `pi:<id>`) starts their pi-phone, with its policy, and
    reaches only them.
  - **Runs** act as this pi-phone's own person (`Team.#person`). Queueing a run also gives the task to the person's own
    Pi on the gateway.
  - **Project wikis** (PP-42, `src/gateway/project-wiki.ts`): Pi's knowledge about a shared board's project.
    - **Storage:** pages by slug, in the gateway's `/data/boards/wiki.sqlite`, with FTS5 search. Queries become
      quoted word prefixes, so FTS syntax never comes from outside.
    - **Who may:** the board service decides: those who see the board read, leads and members write, and a Pi's
      writes are named "Pi (person)". Every write is pushed like a board change, and a deleted board takes its wiki.
    - **Pi's tools** (team server only, in board mode): `project_wiki_search`, `project_wiki_read`,
      `project_wiki_write`, `project_wiki_edit`. Pi's prompt lists the board's pages; plan mode allows the two reads.
    - **The Wiki tab's routes:** `projects/:key/wiki`, `wiki/:slug` (GET, PUT) and `wiki-search`.
  - **Board screens on the team server** (PP-43):
    - **Who's who:** `GET people` answers the gateway's teammates and `me` (`people`/`me` board-service calls), and
      `team: true`.
    - **Sharing:** the settings sheet's `TeamSharing` gives each teammate a standing (not on it, viewer, member,
      lead; `PUT members` with `roles`), plus "Everyone on the team can see it", Move to the team, and Leave.
    - **Making and listing:** New project offers "A team board" to those who manage them. The picker groups boards
      into Mine, Team and Shared with me.
    - **Elsewhere:** a "Mine" sheet (`GET mine`: given to you or your own Pi, every board), the Wiki view, and
      cards showing "Pi (person)". The gateway's `/auth/shared` page lists boards shared with you, each opening its
      settings in your pi-phone (`/#project:KEY`).
  - **Pi's team tools** (PP-45, `extensions/team.ts`, team server only): `team_people`, `team_invite`, `team_person`
    (role, reset two-factor, disable, enable, remove, always on), `team_roles`, `team_role_save`, `team_role_delete`,
    `team_audit`, `team_server` (idle minutes).
    - **How they reach the gateway:** `POST /internal/team { route, method, body }`, which runs the gateway's own
      `#gatewayRoute` as the pi-phone's person (`#teamCall`), so their role decides exactly as on the pages. Audits
      name the actor `pi:<id>`, shown as "Pi for X".
    - **Never:** an allow list (`TEAM_ROUTES`) keeps passwords, exports, backups and setup out.
    - **Cards and guests:** every change asks this pi-phone's person on an approval card. Guests never get them.
      Plan mode allows the reads.
  - **Documents** (PP-46): people's documents, in folders, as markdown pages, by scope.
    - **The store** (`doc-store.ts`, `DocumentStore`):
      - **Scopes:** `mine`, `team`, `project:<board id>`.
      - **Folders** nest, never inside themselves. A page's title is unique in its scope, so `[[Title]]` names one
        page.
      - **History:** every save is a version (history, restore).
      - **Deletes and links:** deletes are kept to restore, and backlinks come from `[[Title]]`/`[[Title|words]]`.
      - **Search:** FTS5, with queries as quoted word prefixes.
    - **Where they live** (`docs-access.ts`, `Docs`): a pi-phone keeps Mine (and, on the phone, its own boards'
      documents) in `documents.sqlite`. On the team server, the team's and shared boards' documents are in the
      gateway (`src/gateway/docs.ts`, `DocService`, `POST /internal/docs`).
    - **Who may:** team documents are read by anyone with `pi.use`, and written with `docs.team`. A project's follow
      the board's standing (`BoardService.standing`/`seen`).
    - **Names:** scopes travel by outside names (`project:<KEY>`). Deletes are audited, and a deleted board takes its
      documents (`BoardService.onRemoved`).
    - **The extension** (`extensions/docs.ts`): routes `scopes`, `call` and `search`, for this pi-phone's person only.
    - **Pi's tools** (PP-48): `doc_search`, `doc_list`, `doc_read`, `doc_history`, `doc_write` (with a folder path,
      made if missing), `doc_edit`, `doc_move`, plus `doc_delete` and `doc_restore` on a card.
      - **Place:** mine, team, or a board's key; the default is the session's board, else mine.
      - **Who:** only this pi-phone's person; Pi's saves are "Pi (person)".
      - **Plan mode** allows the reads. A prompt section keeps documents apart from the wikis.
    - **Search by meaning** (PP-49, `embeddings.ts`): each page is cut into passages (by heading, about 800 tokens,
      title and folder in front), kept in `doc_chunks` with a hash of model and text, and embedded on OpenRouter in
      batches of 32 after each save (`indexer`).
      - **Kept:** only changed passages are embedded again; a new model embeds everything again (`doc_meta.model`).
      - **Search:** keyword (FTS5) and cosine over the query's vector, merged by reciprocal rank fusion (k 60).
        By meaning, only pages within 0.1 of the best match count (`NEAR`): measured on the devbox with
        text-embedding-3-small, matches scored 0.25–0.55 and the rest 0.1 or more below; a fixed floor cut short queries.
        Pages saved before passages existed are cut when the store opens.
        Search uses meaning only when the stored vectors are of the current model (`embeddedWith`); right after a
        change it is by keyword and starts embedding again. The setting is "Embedding model for search" (wiki and Mine).
    - **Images** (PP-49): `doc_images` rows (bytes in SQLite, so backups and `forgetScope` include them); pages show
      one as `![name](image:<id>)` (`IMAGE_REF`).
      - **Clean:** `image-meta.ts` types a file by its bytes (PNG, JPEG, WebP, GIF, 10 MB) and drops metadata:
        PNG text/time/eXIf chunks; JPEG APPn but JFIF, ICC and Adobe, and comments, with a minimal Exif carrying only
        the orientation; WebP EXIF/XMP chunks (VP8X flags cleared); GIF comments and app blocks but looping ones.
      - **Described:** `describer` sends each image once to a vision model (`DESCRIBE_IMAGE`); a failure stores ""
        and waits for another model. The description replaces the image's markdown in what FTS and the passages
        read (`#searchable`), so the page is found by it; the pages that show it are indexed again.
      - **Models:** Mine uses `docs.imageModel` (config `docsImageModel`, a signed-in model that reads images,
        through `app.describeImage` and `completeSimple`; cost in Spend's "Wiki and documents"). The gateway uses
        `docs_vision` with the server key (OpenRouter chat completions), set on the Server page or by `team_server`.
      - **Sizes:** extension routes take `maxBytes` (up to 16 MB; docs' `call` takes 16 MB), and the gateway's
        `/internal/docs` reads up to 16 MB (64 KB elsewhere). The web shows images as data URLs, cached per tab.
      - **Pi:** `doc_image` reads a file where the session works (`host.envOf`) and answers the markdown to put in a page.
        A failed query embedding falls back to keyword search, with a log line.
      - **Mine:** the wiki's embedding model plus the person's OpenRouter key; cost through `Para.chargeEmbedding`.
      - **Team and projects:** the gateway's own model and key (`pp_setting` docs_model/docs_key), set on the
        Server page; spend per month in `docs_spend_<month>`. The key is never answered back nor audited. Pi may
        set the model (`team_server`) but never the key: `#teamCall` refuses `docsKey`.
  - **Each member's own environment** (PP-41):
    - **Places:** a member's places (their clone) are personal.
    - **Runs** stay in the runner's pi-phone, and are laid over the shared task there (`task.run`).
    - **Each step is shared:** `Projects.onRunChanged` leads to `recordRun`, a "run" activity of the gateway's with
      state, branch and `session: <key>:<n>` (`<key>:0` before a session exists).
    - **Names:** the gateway names whose pi-phone a session, comment or step is in (`by`).
    - **The task sheet** links your own sessions, names others' ("In Binh's pi-phone"), shows others' runs in the
      activity ("Binh's Pi ran it · on task/PP-12"), and shows a card while someone else's Pi works on it.
  - agent-board's five types and hierarchy (Epic → Story/Task/Bug; Story → Task/Bug/Sub-task; Task, Bug → Sub-task)
    and its eight states. The store keeps what must hold whatever a model does: who sees a project (the owner all;
    others the ones they own or are members of; viewers only read), the hierarchy (no circles), Done only after a
    person where `operatorReview` is set, after a Bug's `fixVerified`, and after a parent's children; Pi never moves
    to Done a task its own session set In Progress (that session is the task's `worker`), and never lifts
    `operatorReview`. `blocks` links show as "waiting on" (`waitingOn`) and never move a task or start work: the
    project's main session orchestrates (owner's decision of 2026-10-19), not a daemon.
  - **Board mode**: Pi uses a board only in sessions where the person said yes. `board_mode` asks once on an inline
    card (an approval with `tool: "board_mode"`, drawn by `BoardModeCard`); a no is kept and Pi does not ask again;
    `PUT /api/x/projects/board-mode/<session>` is the session's switch. Every other board tool except
    `project_list` refuses while it is off. Pi acts as the person it works for (`requesterOf`).
  - Routes under `/api/x/projects/` (`projects`, `projects/:key`, `projects/:key/tasks`, `projects/:key/members`,
    `tasks/:ref`, `tasks/:ref/comments`, `tasks/:ref/links`, `board-mode/:conversation`); changes are sent to
    open boards as the module's `changed` event. Tests: `test/projects.test.ts`.
  - Screens: the browser module `extensions/projects-web/` (`index.js`, `projects.css`). The page `projects`, with ACS's
    original board look in the app's tokens (column canvas lighter than the board, cards darker, near-square corners;
    light themes: grey columns, white cards), a column per state (16rem, the load fill on collapsed ones), and cards
    with type, priority, parent, waiting-on, progress, and a footer. Desktop: mouse drag between states, placed by
    position (the midpoint of its neighbours). Phone: the states as tabs over one full-width column at a time
    (scroll-snap), and a long press opens Move to. Sheets: `task`, `new-task`, `new-project`, `project` (name, folder,
    sharing, delete), `move`, `board-mode` (the session menu's "Board for this session").
  - **The agent team** (`project-runs.ts`, `Team`), owner's decisions of 2026-10-19: the project's main session
    orchestrates (no auto-unblock, no daemon). `POST projects/:key/team` starts the main session in the project's folder
    (`LEAD_RULES` in its prompt: plan, delegate, review; never implement). A task given to Pi (`onAssignedToPi`) is
    queued at once when the project runs tasks by itself (`autoRuns`), else the main session is told and asks with
    `task_run` (an approval card, "Run PP-12 now?"). Runs (`pocket_task_runs`: queued → starting → running → done,
    failed, stopped, or cancelled) start at the project's place with the most room under its cap (`places`, default
    the folder with 2); each gets a worktree `<repo>/.worktrees/<ref>` on `task/<ref>` from the repository's current
    branch (`.worktrees/` in `info/exclude`), made with commands at the place (`host.run`, Git Bash on Windows), and a
    task session there (`host.startSession`, as the project's owner) whose prompt has `taskRules`; the task goes In
    Progress. The session's end (`host.onSessionEvent`, the phone's events) is reported to the main session
    (`host.sendToSession`, after its current work): Review → done ("Done"), Blocked → "Needs the person", otherwise
    "Stopped"; failed → "Failed"; an approval → "Needs the person". `host.quietSessions` keeps task and main sessions'
    ends from the phone. `GET tasks/:ref/diff` (3-dot) and `POST tasks/:ref/merge` (`--no-ff` into the base, only when
    the repository is on it and clean; then the worktree and branch go, and the task is done where its rules allow).
    A restart fails runs cut off while starting; a running run's end that came while the server was down is not seen.
  - **A tool for every action** (AGENTS.md): `project_update` (folder, places, runs by itself), `project_share`,
    `project_team` (start the main session), `project_delete` and `task_delete` (a card first), `task_cancel_run`,
    `task_diff`, `task_merge` (a card first: merging is the person's call), `task_link_session`; `task_get` shows the run.
    Pi's sessions link themselves to the tasks they make, change, or comment on: the main session as `main`, others as
    `linked` (a task session that set In Progress stays `worker`).
  - A project's folder is typed or chosen with the app's folder picker: `pocket.pickFolder({ start, title })` (an
    extension API) opens `CwdSheet` in its `pick` mode (browse, make folders, here or on a machine) and answers the
    folder or null; it takes the sheet's place, so the sheet comes back with the choice (`new-project` keeps a draft).
  - Links: `/?page=<module>:<page>` opens an extension's page once its module is ready (`openPageWhenReady` in
    `extension-ui.js`: opened earlier, the module list would close it); `#task:PP-3` opens a task, from a link anywhere
    or the address (asked again until the sheet shows, as the linked page's opening closes sheets).
  - `pocket.openPageOf(module, page)` opens another module's page (never its sheets), once that module is ready. A
    board's Docs button uses it to open Documents on the board's place (PP-47).

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
