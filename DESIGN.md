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
Guard (ONNX), Web Push, the share target, the launcher (access modes, tunnels, QR), and the repo extras (docs
site, nix, lint config).

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
  accept it, "Install and connect" (deploys the daemon to `~/.pi/mobile/tools` on the machine). `ready(id)` refuses a
  machine not connected yet, so the agent can never trigger a deployment. Tested against the bundled `sshd`.
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
  - **Pi's tools instead:** `machine_run` (one command on a named machine, through `host.envOf`; secrets as in bash,
    their values redacted, output kept to its last 30,000 characters) and `machine_copy` (one file of up to 100 MB,
    phone to machine, machine to phone, or between machines: `<machine>:<path>`). Or a session on the machine.
  - **The prompt:** the phone prompt names the machines (alias, address, id) and these tools, and says its bash has no
    ssh.
  - **The guard:** the secrets module (required) refuses Pi's `read`, `write`, `edit`, and `bash` on the app's key
    stores (`<data>/ssh`, `pocket.sqlite`, `secrets.json`; `ssh-add` and `SSH_AUTH_SOCK` in commands), and treats
    `machine_run` as bash for secrets.
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
  - **Install:** the machine downloads each itself (curl or wget), checks the sha256 (sha256sum or shasum) before
    keeping anything, into `~/.pi/mobile/tools/<tool>/<version>/`, and a wrapper `~/.pi/mobile/tools/bin/<command>`
    (marked `# pi-phone-tool <id> <version>`, written by a quoted heredoc) runs it with what it needs (OfficeCLI: no
    self-update, no self-install; Termux's OpenSSL on Android). Older versions are removed. OfficeCLI's skills are copied
    with it (`<version>/skills/`, a tar from the phone's `third_party/`).
  - **Where it shows:** adding a machine lists the tools, ticked, under "Install and connect"; after connecting, the
    ticked ones the machine has a build of (and, for rg and fd, has none of) are installed. A connected machine has
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
