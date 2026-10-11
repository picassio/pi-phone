# pi-phone

A single-user pi agent for Android (Galaxy Z Fold 8). The agent runs in Termux on pi-durable and pi's experimental
client/server stack; a React Native app is the presentation. See UI.md for screens.

## 1. The experimental stack, as it is (pi checkout at `~/projects/pi`, 1.1.0)

```
coordinator   packages/coding-agent/src/experimental/coordinator.ts
              a detached process owning the public unix socket; routes bytes opaquely; a replaced server
              gets `server_replaced` and workers keep running
server        server.ts: startServer() -> SessionWorkerManager + server services + RadiusRelayHost
              services: SessionDirectory (replicated {revision, sessions[{serverId, sessionId, createdAt}]}),
              SessionManagement (create/remove/attach/detach), PresentationPlugins
session       session-worker.ts: one process per open Session; proper-lockfile on the Session dir;
worker        Harness over session.sqlite; retires when no attachment and no live task
              (WorkerLifecycle, 10 s initial / 30 s orphan grace); harness.resume() on open
              services: Transcript (ReplicatedState<ConversationView> of the root), AgentController
              (prompt/steer/followUp/cancelQueued/abort/compact/waitForPrompt), Models, SessionPlugins
protocol      pi-protocol CBOR frames (16 MB max), strict-JSON payloads; Chord carries service calls and
              replicated-state snapshots/updates; routes fenced by {serverId, sessionId, attachmentId}
client        pi-client (transport-neutral); services/connection.ts binds typed services (no node imports)
transports    unix (built in); Radius relay (WebSocket to earendil's gateway, host and client sides in
              radius-relay.ts; `pi client --connect radius://<serverId>`)
plugins       packages with src/session.ts (worker facet) and src/tui.ts, built by Chord's bundler, hot
              reload; plugin facets get services, not the Harness
```

Exports we build on: `startServer`, `activateServer`, `runSessionWorkerWithHarness(args, createHarness)`,
`RunningServer.server` + `Server.accept(connection)`, `createRadiusClientTransportFactory` /
`RadiusClientByteTransport`, `createServerServiceSource` / `createSessionServiceSource`, the service contracts
in `services/*.ts`, `createCodingRegistry`, `createHarnessSettings`, `ExecutionEnvs`, `findInitialAgentModel`.

None of this is on npm (the `experimental/` tree is excluded from the package); `pi-server`, `pi-client`,
`pi-protocol`, `chord`, `pi-durable`, `pi-ai`, `pi-coding-agent` 1.1.0 are. The project depends on the checkout
for `experimental/` and tracks it.

## 2. What we write

```
pi-phone/
  server/        Node, runs in Termux
    main.ts      startServer({ workerEntryUrl }) + WebSocket listener + HTTP (images, files) + token
    worker.ts    runSessionWorkerWithHarness(args, createPhoneHarness)
    harness.ts   ModelRuntime Proxy (onPayload cc-patch), registry (CodingTools + pi prompt + subagents +
                 guard), settings doc, envs, images processor
    facets/      Providers, Files, Uploads, Storage, Conversations, PhoneTranscript (keyed, projected,
                 paged), PhoneAgent (keyed AgentController), Approvals
    cc-patch.ts  pure transform + ported tests
    status.ts    per-Session status.json written by the worker (busy, needsApproval, subagents, usage)
  app/           Expo (React Native)
    transport/   WebSocket ByteTransportFactory (direct) and Radius factory (remote)
    services/    bindings via services/connection.ts; connection pool keyed by Session
    model/       turns.ts (pure), live.ts, tree.ts; tests
    screens/     UI.md
  android/       foreground service, notifications, share target (Expo config plugin + Kotlin module)
```

### No changes to the pi checkout

Two things pi's stack does not allow from outside are done by the module hooks in `bin/resolver.mjs`, preloaded
through `NODE_OPTIONS` into every process pi spawns (coordinator, server, workers):

- pi's `SessionWorkerManager` spawns a fixed worker module. The resolve hook redirects that main entry to
  `server/worker.ts` (and rewrites `process.argv[1]` so pi's module does not take itself for the entry), which runs
  `runSessionWorkerWithHarness()` with our Harness and facets.
- pi-server's Unix listener publishes its socket with a hard link, which Android forbids in app data (tested: fails
  on every writable path). The load hook replaces that one line with `rename` (same atomic publish, same inode).

Each hook asserts the exact text or URL it expects and throws at startup if a pi update changes it. Worth
proposing upstream (a `workerEntryUrl` option; `rename` in the listener), but nothing here depends on that.

### Transport

- **Direct** (phone-only): `ws` server in `server/main.ts` on `127.0.0.1:<port>`; each socket becomes a
  `ByteConnection` passed to `runtime.server.accept()`; one CBOR frame per binary message, as the Radius relay
  does. A random token in `~/.pi-phone/token`, sent as a query parameter on upgrade. App side: the
  `RadiusClientByteTransport` pattern with RN's `WebSocket` (`binaryType = "arraybuffer"`).
- **Remote**: `createRadiusClientTransportFactory({ serverId, auth })` unchanged; the app stores a Radius token
  from `/login radius` done on the desktop or via the Providers sheet. Lets the phone drive a desktop pi server.
- Reconnect: `pi-client` never reconnects. Port `RadiusClientReconnect` (reconnect + reattach the last Session)
  to both transports; on app foreground, reconnect every pooled connection.
- HTTP on the same server: `GET /image/:session/:conversation/:entry/:index`, `GET /file?session=&path=`,
  `POST /upload`, token protected. Workers do not serve HTTP; the server reads images through a worker service
  call and streams the bytes, with a small LRU.

### Worker composition (`server/harness.ts`)

- `ModelRuntime.create()` wrapped in a Proxy whose `streamSimple` adds `onPayload: ccPatch` (section 4).
- Registry: `CodingTools` (with `createNodePhotonImages()` if Photon's WASM loads on Termux; else none),
  `createPiPrompt` (pi's system prompt sections), the background subagent extension (from
  `durable/test/examples/23-subagent-background.ts` and the vacation `research` pattern), the guard extension
  (`beforeTool` on bash/write/edit: outside cwd, deny list, or "ask" policy -> holds the call in an
  `Approvals` document until the app answers), the context-edit extension (section 3).
- Settings: `createHarnessSettings(settingsManager)` merged with a `pi.phone-settings` session document read
  through getters: `progress` 250 ms, `compaction`, `contextRetentionMs`/`documentRetentionMs` 120 s,
  `toolExecution`, `followUpMode`/`steeringMode`, images resize 1600 px, spill dir `~/.pi-phone/spill/`.
- `env`: `ExecutionEnvs` per cwd; `TMPDIR` set per worker so bash spills land in the spill dir.
- `conversationCreated`: creates our documents (`Approvals`, `Labels`, `Subagents`) for every conversation.
- `onReport` -> a `Notices` replicated state the app shows as toasts.
- `harness.closed` -> the worker exits; the server's manager respawns on next demand; `resume()` continues.

## 3. pi-durable features we use on purpose

- **`requestId` on every submit**: client UUID per send; retries after a dropped WebSocket find the same
  submission (`submit` returns the existing one). Same for `compact`, `reset`, approvals.
- **`whenBusy`**: `steer` / `followUp` from the composer toggle; `reject` for sends that must not queue.
- **`ContextEdit`** (`omit` / `replace` an earlier entry's model messages, written as an entry's `edits`):
  "Forget this output", "Drop this image from context", "Replace with a note". A write submission while busy
  (API footnote: raw appends during a run misplace system entries). Shows as a dimmed row with "hidden from
  the model".
- **`reset(note)`** for new context; **`compact(instructions)`** manual; automatic compaction via settings.
- **`deferred`** stream option (`{ window: "24h" }`) as a per-send "Send when cheap" mode where the provider
  supports it; `pi.live.generation.deferred` shows the poll state.
- **`fork(at)`**: shared history, no copy. **`parent`** on the record builds the tree.
- **Owned conversations** for subagents; **`background: true`** anchor tasks so a parent abort leaves them.
- **`taskGraph` / `watchTaskGraph`**: the Tasks sheet and the busy marks; **`inspect()`**: blocked tasks
  (missing extension) shown in Storage/diagnostics.
- **`usage()`** and `pi.usage` per conversation: cost in the status line; per subagent under its parent.
- **`subscribeCommits`** in the worker: notifications (run ended, approval needed) via `status.json` and the
  server's push to the app's foreground service.
- **`snapshotAsOf`** on rewindable documents for "what was the plan at this entry".
- **Replay-safe tools** (`replay: "safe"`) for our own tools (subagent spawn, uploads lookup); everything else
  gets an `interrupted` result after a crash.
- **`settings.progress`** raised, since every partial is a commit and the phone pays for each.
- **`watchEvents`** is not used by the app (the Chord view replica is the source of truth); it is the JSON
  mode for `pi-phone-server --print` debugging.

## 4. Login and providers

Login runs in the worker: `ModelRuntime.login(providerId, type, interaction)` drives each provider's flow and
writes `~/.pi/agent/auth.json`, shared with the `pi` CLI. The UI only sees `AuthInteraction`
(`packages/ai/src/auth/types.ts`): `prompt(text | secret | select | manual_code)` and
`notify(info | auth_url | device_code | progress)`.

`Providers` facet (modelled on pi-pocket `src/server/providers.ts`): `state` = per provider
`{ id, name, configured, source, hasApiKey, oauthLabel }`; `startLogin(providerId, type)` -> `flowId`, with the
interaction writing prompts and events into replicated `flows[flowId]`, so a reconnect resumes mid-flow;
`answer(flowId, promptId, value)`, `cancel(flowId)`, `logout(providerId)`. OpenAI Codex/ChatGPT needs
`getDeviceId` from pi settings.

Anthropic subscription: `packages/ai/src/auth/oauth/anthropic.ts` starts a callback server on
`127.0.0.1:53692`, emits `auth_url` with `redirect_uri=http://localhost:53692/callback`. Browser and Termux
share loopback on the phone, so the redirect lands without a paste; fallback is the `manual_code` prompt
(`code#state`). GitHub Copilot is `device_code`. API keys are one `secret` prompt.

### Claude Code billing patch (required: the main login path is the Claude subscription)

`picassio/pi-cc-patch` rewrites direct Anthropic OAuth payloads to look like Claude Code so Pro/Max quota is
billed: a `x-anthropic-billing-header` system block, pi's identity block removed, "pi" wording neutralised,
`metadata.user_id` added. It is a coding-agent `before_provider_request` extension; the durable stack loads no
coding-agent extensions and pi-durable's `beforeRequest` hook sees `Message[]`, not the wire payload. The hook
that works is pi-ai's `SimpleStreamOptions.onPayload` (coding-agent's `sdk.ts` adapts
`before_provider_request` to it). `server/cc-patch.ts` is the transform as a pure function with pi-cc-patch's
tests ported; the `ModelRuntime` Proxy adds `onPayload`. Gated on the OAuth identity block, so API-key, Bedrock,
and OpenRouter requests are untouched. On by default; toggle and `CLAUDE_CODE_VERSION` in the settings doc,
read on every request; `claude_code_version_too_old` in an error means bump it. This spoofs Claude Code identity
against Anthropic's third-party detection; the user accepts that risk. Verify live: Claude login on the phone,
one Opus prompt, no "Third-party apps now draw from your extra usage" error.

## 5. Images and files

pi-durable stores images inline as base64 `ImageContent`: a `read` of PNG/JPEG/GIF/WebP yields one image block
in the `pi.tool-result` entry (resized to `inputLimits.images.resize`, default 2000x2000 / 4.5 MB); a pasted
image is an image block in the `pi.user` entry (`AgentController.prompt({ images })`). The built-in `Transcript`
replicates `viewState()` as is, so images would bloat the replica and every reconnect snapshot.

`PhoneTranscript` facet (keyed by conversation id, root as default): a projection of the view where image blocks
become `{ type: "image", index, mimeType, width?, height? }` without `data`, long tool arguments and output are
clipped with a `clipped` marker, and `entry(id)` returns the full entry; `before(entryId, limit)` pages older
entries through `scanEntries` (closes the Transcript paging gap). Image bytes over HTTP (section 2). `Files`:
`list(path)`, `read(path, range?)` through the conversation's `ExecutionEnv` (`openDirReader`,
`openBinaryReader`), paths under the session cwd only; `exec(["git", ...])` for Changes and branch. `Uploads`:
`put(conversationId, name, mimeType, data)` under `~/.pi-phone/uploads/<session>/<conversation>/`, returns the
path. App side: images inline when the model takes images, else uploaded and referenced by path; non-image
files uploaded and inserted as `@path`, or their text sent along when small.

## 6. Sessions, conversations, threads, subagents

```
Server
\-- Session        one directory (meta.json + session.sqlite); one worker process while open
    \-- Conversation  a transcript: the root, forks (parent: {conversationId, at}), subagents (owner task)
        \-- Context   entries the model sees: since the newest reset or compaction head
```

- **Session** is the user's unit. The built-in `SessionDirectory` carries only ids and `createdAt`. Our worker
  writes `status.json` next to `meta.json` on every relevant commit (`busy`, `needsApproval`, `subagents
  { working, failed }`, `lastActiveAt`, `title`, `usage`), and the server serves a `PhoneDirectory` over
  HTTP/SSE merged from `meta.json` + `status.json` + `sizeBytes` + `workerPids`. No pi change; the SSE feed
  also drives notifications when the app is backgrounded.
- **Multi session**: a worker per attached Session; a run keeps its worker until it ends; the worker retires on
  its own when idle and detached. Soft cap on concurrent workers (default 3) enforced by the app (detach
  oldest idle). One attachment per connection: the app pools connections keyed by Session.
- **Conversations in a Session**: `PhoneTranscript` and `PhoneAgent` keyed by conversation id; a
  `Conversations` replicated state is the tree `{ id, kind: root | fork | subagent, parent, owner, label,
  busy, outcome }` from `scanConversations` + the task graph. Screen route `(sessionId, conversationId)`.
  `pi.phone-session` document holds `currentConversationId` and labels.
- **Threads/forks**: `Conversation.fork(at)`, shared history. Edit-and-resend and retry-with-another-model are
  `fork(entryBefore)` + `configure` + `submit`. "New context" is `reset(note)` in place. Task checkpoints are
  crash-recovery state; a user restore point is a fork at an entry.
- **Subagents**: background subagent extension: spawn, message (steer or follow-up), wait, stop, list;
  reports return as a follow-up card; restart-safe with request IDs; named; per-subagent model, thinking,
  tool allowlist; nested subagents off by default. Aborting the parent run does not stop them; Stop does.

## 6b. Remote: servers elsewhere, tools elsewhere

Two independent choices: where a Session's worker runs (server), and where a conversation's tools run (env).

**Servers over Tailscale or Radius.** `server/main.ts --listen <addr>:<port>`: `127.0.0.1` by default; the
tailnet address for a laptop or VM. The token stays required; optionally `tailscale whois <peer>` on upgrade
restricts to the owner's nodes. `tailscale serve` can add TLS and a stable hostname. Radius
(`radius://<serverId>`) covers the no-tailnet case through earendil's relay. The app keeps a Servers list
(local Termux, laptop, vm, radius) with one `SessionDirectory` each; the session list groups by server; the
connection pool is keyed by `(server, session)`. A dropped link leaves the remote worker running; reconnect
re-hydrates.

**Tools on another machine: `@earendil-works/pi-env` (1.1.0).** A Rust daemon on the remote, deployed over SSH
and SHA-verified, and `RemoteExecutionEnv`, a pi-durable `ExecutionEnv` whose results match `NodeExecutionEnv`
there. Linux, macOS, Windows, Termux; x86-64 and arm64. The worker, SQLite, and auth stay where the server is.
A `pi.phone-env` document per conversation holds the target: `{ kind: "local" } | { kind: "ssh", host, user,
cwd, hostKeyAlias }`; `Harness.open({ env })` resolves it per conversation on every call, cached per target.
So a conversation on the phone can work on the laptop, a subagent on a GPU VM, and the target can change
mid-conversation (shown as a divider). The `Files` facet and the cwd prompt section go through the same env, so
the file viewer shows the remote tree. The daemon kills its processes after 30 s without bytes, so a dropped
tailnet stops remote commands and the tool gets an error result. Needs `openssh` in Termux, a key, and a
one-time host-key acceptance (`scanHostKey` -> fingerprint shown -> `acceptHostKey`) as an "Add machine" flow.

## 6c. Phone control and the assistant

Skills and context files come from `createPiPrompt` (pi's `~/.pi/agent/skills`, project `.agents/skills`,
`settings.skillPaths`, AGENTS.md). Phone control is tools and skills on top, in three layers:

1. **Termux:API** (`termux-api` + the Termux:API app): typed tools `phone.notify`, `phone.sms`,
   `phone.contacts`, `phone.location`, `phone.photo`, `phone.open`, `phone.share`, `phone.speak`,
   `phone.clipboard`, `phone.battery`, `phone.dialog`, wrapping `termux-*`; a `phone` skill documents the rest
   for `bash`.
2. **Android shell** via wireless ADB paired to localhost or Shizuku (`android-tools`): `phone.screenshot`
   (image block, so the model sees the screen), `phone.tap/swipe/type`, `phone.launch`, `phone.intent`,
   `phone.dumpsys`. One-time pairing flow in the app.
3. **App-native**: NotificationListenerService (read, dismiss, reply), AccessibilityService (screen as a tree,
   tap by label), MediaProjection, calendar/contacts. Mechanism: the worker tool writes a `DeviceRequests`
   replicated entry and awaits the app's answer (request-ID idempotent, replay-safe), served by the foreground
   service. Selected notifications become triggers (inputs to the assistant, fenced as data).

**Assistant Session** (pi-pocket's PiP pattern): one pinned, persistent Session with its own prompt, a cheap
default model, local env, and tools: the phone layers, `sessions` (list/read/start/message/stop other Sessions
through the server), `remember`, `schedule`, `watch`. Coding work is delegated to a coding Session on the
right server and machine, followed, and reported back. Compacts itself aggressively, summaries excluding quoted
external data.

- **Memory** extension: short lessons scoped `everywhere` or per project, proposed by the model via a `memory`
  tool and approved by the user (anything read could plant a lesson), stored in a session-scoped document,
  rendered as a prompt section, capped per scope, edited from a Memory sheet. A user-written profile section
  (name, timezone, preferences) needs no approval.
- **Schedules**: durable tasks that `runtime.sleep` until a time, then submit a follow-up; restart-safe,
  never sent twice; `when.ts`-style grammar ported from pi-pocket.
- **Watches**: notification rules, device events, `gh` repo/PR watches; background tasks posting to the
  assistant with instructions first and the event fenced.
- **Voice**: dictation in the composer; `phone.speak` for answers.

## 6d. Environment and secrets

**Per-session environment** (`pi.phone-env` document, conversation scope, `fork: "current"`): machine target,
cwd, `commandPrefix`, bash timeout and retention, env vars (literal or `{{secret:NAME}}`), plus
`configure({ tools, modelTools, extensions, instructions })` for the tool set. `env()` builds the
`NodeExecutionEnv`/`RemoteExecutionEnv` with the resolved env vars; bash is installed per conversation through
an extension that wraps `createBashTool({ commandPrefix })` (pi-durable's same-name override, README "Tools").

**Secrets** live in three places, with one `Secrets` facet over them: provider credentials in pi's
`~/.pi/agent/auth.json` (never read by the app, only status via `Providers`); connection material in
`~/.pi-phone/` (server token, Radius token, SSH keys per machine, ADB pairing) with the app's copies in the
Android Keystore; tool secrets in `~/.pi-phone/secrets.json` (mode 600). Tool secrets reach tools only as
env vars by reference and never enter the transcript: a `hook(ToolTask, { afterTool })` redacts their values
from `output`, `structuredOutput`, and `details` (literal and base64 forms), and `beforeTool` blocks a bash
command that echoes `$NAME` or reads `secrets.json`. Reveal in the app needs biometric/device credential.

## 7. Approvals and safety

A guard extension with `hook(ToolTask, { beforeTool })`: allow-list of read-only commands, deny-list
(`rm -rf /`, `git push --force` by default), "ask" for bash/write/edit touching paths outside the cwd, and an
"ask for everything" mode. Phone tools: `phone.sms`, `phone.call`, `phone.share`, `phone.tap/type`,
`phone.intent` to payment/banking apps, and any `input`/`settings put` always ask; reads (`notify`, `location`,
`clipboard.get`, `screenshot`) are allowed; sends are rate-limited per hour; memory writes ask; the assistant
Session has a spend limit. External text (notifications, pages, files, other sessions) is fenced as data.
Layers 2 and 3 are off until paired/granted. An asked call is held: the hook awaits an `Approvals` document decision (committed
through a write submission from the app, request-ID idempotent), with a timeout that denies. Approvals are
answered from the transcript card, the notification, or the session list. Approval state survives restarts since
it is a document and the hook reruns on resume.

## 8. Storage: monitor, control, cleanup

pi-durable storage is append-only (`StorageWrite` has no delete; reset and compaction hide entries from the
model but keep them). Growth: entries (images inline), `pi.live` revisions, tasks, bash output spilled to tmp,
uploads. The Session directory is the cleanup unit (`SessionManagement.remove`).

- **Monitor**: `Storage` facet state refreshed every 30 s: per Session size (sqlite + wal), entries, image
  bytes, uploads, last active; totals and free space (`statfs`); `harness.inspect()` for blocked tasks.
- **Control**: settings above; `ContextEdit` to drop images from context (not from disk).
- **Cleanup**: remove Session (size shown, export Markdown offered); archive (`meta.json` flag; hidden, no
  worker); sweep (spill > 24 h, orphan uploads, orphan dirs, app image cache LRU > 200 MB) at start, daily, on
  demand. Optional, off by default: remove archived after N days; warn above N MB.
- **Gap**: nothing shrinks inside a Session. `VACUUM` on idle is cheap. Pruning needs an upstream storage write;
  propose after the monitor gives numbers, minding fork lineage.

## 9. Known gaps and risks

- API churn in `experimental/` and pi-durable ("API changes without notice"); pin the checkout commit and
  upgrade deliberately.
- `TODO_CONTEXT` is used across the experimental code; cancellation there is incomplete.
- Photon WASM on Termux untested; `read` of images degrades to "within limits only" without it.
- Chord replica memory on the phone for long conversations: paging keeps the active context bounded; the
  projection keeps entries small.
- Termux process lifetime: coordinator, server, workers are detached; need `termux-wake-lock`, a boot script,
  and the app's foreground service to keep Android from killing them. Battery: raised progress intervals, and
  workers retire when idle.
- Worker spawn uses `process.execPath --import source-resolver.ts`; fine on Termux Node 26; a bundled build later.

## 10. Prior art

- https://github.com/TannerMidd/pi-pocket: web app on pi-durable. UI patterns (UI.md), providers flow, Termux
  pitfalls (`termux-wake-lock`, ONNX fails on Android, `--ignore-scripts`). Its own HTTP+SSE stack and single
  database are what we replace with the experimental stack.
- https://github.com/badlogic/pi-subagent: pre-durable subagents in tmux; the UX to mirror.
- https://github.com/picassio/pi-cc-patch: the billing transform.
- `packages/coding-agent/src/experimental/{durable,vacation}`: the durable TUI and the background subagent
  pattern.

## 11. Plan

1. **Baseline** (done). Findings: `npm install --ignore-scripts` plus `npm run hydrate-model-data` in
   `packages/ai` are needed; Biome and TypeScript 7 have no Android binaries (type check on the laptop); tests
   run on the phone. Android forbids hard links, which pi-server's Unix listener used; patched at load time (see
   "No changes to the pi checkout"). Coordinator, server, worker spawn, lock, SQLite, model call, `-c` resume,
   and worker retirement all work under Termux.
2. **Server** (done). `bin/run.mjs` (preloads pi's resolver and `bin/resolver.mjs` through `NODE_OPTIONS`),
   `bin/resolver.mjs` (`pi-src/*` imports, worker redirect, listener patch), `server/main.ts`
   (`startForegroundServer` + `ws` listener on `127.0.0.1:7741/pi` + `/health` + `/admin/shutdown`, token in
   `~/.pi-phone/token`), `server/worker.ts` (`process.title` `pi-phone-worker`) + `server/harness.ts` (our
   composition, same as pi's for now), `client/ws-transport.ts` (runtime-neutral, for the app).
   `scripts/ws-smoke.ts` attaches over WebSocket, streams the Transcript, gets an answer from our worker.
   `npm test` covers token and transport.
3. **Login + billing**: `Providers` facet, `cc-patch.ts` + Proxy, tests. Verify Claude OAuth via loopback and
   one Opus prompt on the subscription. Blocks the app.
4. **App skeleton**: Expo, WS transport, bindings, connect, attach, raw Transcript view, send a prompt. Then
   `turns.ts` and the conversation screen (UI.md sections 3-6).
5. **Worker facets**: `PhoneTranscript` (projection, keyed, paging), `PhoneAgent`, `Conversations`, `Files`,
   `Uploads`, `status.json` + `PhoneDirectory`. Session list, images, file viewer.
6. **Agent features**: background subagents, guard + approvals, `ContextEdit`, forks + Tree sheet, deferred
   "send when cheap".
7. **Native**: foreground service (keeps the WS open, raises notifications from the SSE feed), share target,
   fold layout, Termux boot script + wake lock.
8. **Storage**: `Storage` facet, Storage sheet, sweep, settings. Measure; decide on the pruning proposal.
9. **Phone + assistant**: Termux:API tools and `phone` skill; Assistant Session with `sessions`, `remember`,
   `schedule`; memory sheet with approvals; notification triggers; then ADB/Shizuku layer and app-native
   `DeviceRequests`.
10. **Remote**: `--listen` on the tailnet, Servers list in the app (local / ws over Tailscale / radius://);
   `Machines` facet with pi-env targets per conversation, "Add machine" host-key flow, target picker in the
   session menu and for subagents.
