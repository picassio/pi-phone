# UI design (React Native)

What we take from pi-pocket (`~/tmp/pi-pocket/web/`, MIT) and how it maps to our stack: React Native app over
pi's experimental services (`Transcript`, `AgentController`, `Models`, `SessionDirectory`, `SessionManagement`).

Scope differs from pi-pocket: single user, one phone, root conversation first. No multiplayer, roles, invites,
webhooks, PiP, browser panel, Omarchy themes.

## 1. Data: a pure "turns" layer between the replica and the screen

pi-pocket's best structural idea: `web/turns.js` is pure functions with no imports that turn raw entries into what
the screen shows, tested in Node. The components (`transcript.js`) only draw.

Ours: `app/model/turns.ts`, pure TypeScript over the `ConversationView` replica we get from the `Transcript`
service (entries, `pi.live`, `pi.inbox`, `pi.agent`, `pi.usage`). Port from `turns.js`:

- `itemsOf(entries, partial)`: splits each assistant entry into **reply** items (text blocks) and **activity**
  groups (consecutive thinking + tool calls). A group that spans entries stays one group until a text block.
- `summarize(group)`: one line per group, verb per tool kind with counts and merging: "Thought, searched, read
  2 files, ran 1 command · 18s".
- `outcome(call, result)`: what a call came to, read from its output: `+12 -3` for edits, `n lines` for reads,
  `n matches` for grep, `48 passed · 3.1s` for test commands (`testOutcome`), exit code, "needs approval".
- `shortError`, `withoutNotes` (strip `<harness>` notes), `diffCounts`, `lineCount`, `matchCount`.
- Live derivation (`LiveLine`): from `pi.live`: `waiting for approval` > `retrying in Ns (attempt k, error)` >
  `working` (a tool runs or partial text streams) > `thinking` > idle, with elapsed time since the run started.

Keep these pure and unit-tested; they are the only part that needs to know pi-durable's entry shapes.

## 2. Screens and navigation

Stack: `expo-router`. Screens:

| Route | Content |
|---|---|
| `/` | Session list (pi-pocket's sidebar as a full screen on phones): rows grouped by day, each one line: folder color dot, title (bold when unread), right side: working mark, "!" when a call waits for approval, subagent count, time ago. Swipe row to archive with an undo toast. FAB: New session (folder picker). |
| `/s/[id]` | The conversation. Top bar: back, title with folder and git branch under it, model chip. Body: transcript. Bottom: bars (queue, approval, subagents), then composer. |
| `/s/[id]/c/[cid]` | Any conversation of the Session: a fork, a subagent. Same screen; the top bar shows the branch label and a parent chip; back returns to the parent. The Session remembers its current conversation. |
| sheets | Bottom sheets (`@gorhom/bottom-sheet`), each a back-stack layer: Places, Model picker, Session menu, Files, Changes, Find, Tasks (task graph), Settings. |

Back behaviour (from `back.js`): Android back closes the newest layer first (sheet, file over tree, panel), and only
then leaves the session to the list scrolled where it was. Implement as a `layers` stack in a store; a
`BackHandler` listener pops the top layer before letting the router go back.

Fold-aware (not in pi-pocket, which is web-only): `useWindowDimensions()`; width >= 700 shows the session list as a
left column with the conversation beside it (pi-pocket's wide "tiled" layout), and Files/Tasks dock as a right
column instead of a full screen. Folding mid-session keeps the same route.

## 3. The transcript

Column of turns, newest at the bottom, `FlashList` inverted, windowed at 60 rows with "Show earlier messages"
(pi-pocket `TRANSCRIPT_ROWS`). Earlier rows need the Transcript paging gap closed on the server (see DESIGN.md).

Rows:

- **User message**: filled row with a prompt mark in the accent, time. Tap: Edit and send again, Copy, Fork from
  here (later; forks are separate conversations).
- **Activity group**: one folded line from `summarize()` plus duration. Open: a timeline, a row per step: mark
  (done / failed / running / blocked), verb and target (`read src/app.ts`), outcome at the right. Tap a step:
  arguments and output; edits show a diff (line numbers, word-level changes); bash shows live output while it
  runs. Rule from pi-pocket: the newest turn's groups start open, earlier ones closed, until the user toggles.
- **Reply**: markdown (`react-native-markdown-display` or a custom renderer with syntax-colored code blocks and
  horizontally scrolling tables). Long press: Copy, Pin, Fork.
- **Approval card** at the end of its turn: the whole command, why it is held, Allow / Deny. Needs a guard
  extension on the server side (pi-pocket uses Lancet Guard; we start with a simple `beforeTool` hook that
  holds `bash`/`write`/`edit` outside the cwd or matching a deny list).
- **Live line** while busy: the state from section 1 and its elapsed time, with Stop.
- **Divider** on reset / compaction with the summary expandable.

Scrolling: stay pinned to the bottom while streaming only if the user was at the bottom; otherwise show a
"new reply" pill that jumps down.

## 4. The composer

From `composer.js`:

- One-line box that grows; a tap anywhere on the row focuses the text.
- While busy: a **Steer / Queue** toggle beside the model chip. Steer = `whenBusy: "steer"` ("Pi reads it now,
  between steps"); Queue = follow-up ("Pi reads it when this run ends"). Placeholder text says which.
- **Stop** replaces Send while busy and the box is empty.
- Queued messages show as rows above the box with Withdraw; count folds when they do not all fit.
- `@` mentions files from the session folder (list fetched once, fuzzy matched locally); `/` lists slash
  commands (model, thinking, compact, reset, plan) and prompt templates; `!cmd` runs a shell command and shows
  it as a row.
- Long paste (> 20 lines) folds into `[Pasted text #1 · 240 lines]`, expanded on send.
- Attach: images from the gallery or camera; share-sheet target (Android intent) drops text/links/images into
  the box of a chosen session.
- Dictation with the platform speech recognizer (`expo-speech-recognition`); the mic takes Send's place while
  busy; never sends by itself.
- Up arrow / history: a local list of sent messages per session.

## 5. Bars above the composer

Stacked, each one line, buttons whole, text truncated; the stack scrolls if it still does not fit and the
transcript keeps at least a quarter of the screen (pi-pocket's rule).

- Approval waiting (with Review).
- Subagents: a dot per subagent, how many work / are done, what the newest one does; tap for rows with Stop and
  Open. Needs keyed Transcript instances per conversation on the server (gap in DESIGN.md).
- Plan mode on, with Approve plan.
- Project trust question.

## 6. Status line under the composer

Context fill (percent of `contextWindow`, estimated after compaction until measured), cache hit rate, cost from
`pi.usage`, thinking level. Tap the model chip for the model picker: a searchable list with provider groups,
thinking levels under it, "Make default".

## 6b. Providers sheet

From Settings or the model picker's "Sign in to more providers". Subscribes to the `Providers` service.

- A row per provider: name, status ("Signed in via OAuth", "ANTHROPIC_API_KEY", "Not signed in"), model count.
  Tap: "Sign in with subscription" (when `oauthLabel`) and/or "Use API key", and "Sign out".
- A login flow renders the current `flows[flowId]` step:
  - `auth_url`: a button that opens the URL in a Custom Tab (`expo-web-browser`), the instructions text, and
    below it the paste field for the `manual_code` prompt when the callback does not arrive.
  - `device_code`: the user code large with Copy, a button to open `verificationUri`, expiry countdown.
  - `secret` / `text`: input (secure for `secret`); `select`: a list of options with descriptions.
  - `progress` / `info`: a status line; `info.links` as tappable links.
  - Cancel always visible; done shows success and refreshes the model list.
- Anthropic is the first row and the first-run path: with no provider signed in, the app opens this sheet with
  "Sign in with Claude subscription" as the primary button. Under the row: "Bill as Claude Code" toggle (on by
  default, one-line warning) and the Claude Code version string, with a hint when a request failed with
  `claude_code_version_too_old` (see DESIGN.md, Claude Code billing patch).

## 6c. Images and files

- **`read` of an image** (tool step): a thumbnail from `/image/:conversation/:entry/:index` in the step's
  expanded view, outcome text "image 1280x960". Tap: full-screen viewer (`expo-image`, pinch to zoom, share,
  save). A grey placeholder with the known aspect ratio while loading, so rows do not jump.
- **User message with images**: a row of thumbnails under the text, same viewer. Attached files show as chips
  with name and size; tap opens the file viewer.
- **Composer attach**: gallery and camera (`expo-image-picker`), clipboard paste (`expo-clipboard`
  `getImageAsync`), and the Android share sheet. Resize client-side to <= 2000 px, JPEG q85, before sending.
  Inline as `images[]` in `prompt()` when the model takes images; otherwise upload and put the path in the
  message with a note. Chips above the box show pending attachments with remove.
- **Non-image files**: upload, insert `@<path>`; the agent reads it. "Send contents along" sends text files
  (<= 100 KB) inline, as pi-pocket does.
- **File viewer sheet**: opened from paths in replies (`src/app.ts:42`), `@` mentions, read/write/edit cards,
  and Changes. Text with line numbers and syntax colors (Markdown rendered), images in the viewer above, folders
  browsable. "@ Mention" puts the path in the composer. On the unfolded screen it docks as the right column.

## 7. Sessions elsewhere

- **Running now** (pi-pocket's rail tool): everything live from `harness.taskGraph()`: answers, tool calls,
  subagents, compactions, with Stop. Ours: a Tasks sheet fed by `watchTaskGraph` exposed as a service.
- **Subagents**: the bar above the composer (section 5) opens a list; each row opens `/s/[id]/c/[cid]`, where
  the composer steers or queues to the child. The task sheet shows the Session's tree from `Conversations`.
- **Forks and the Tree sheet** (pi's session tree, on pi-durable): long-press a reply -> "Fork from here"
  creates a branch in the same Session and switches to it, no copy. "Edit and send again" and "Retry with
  another model" on a message are a fork just before it. In the transcript, a row where other branches diverge
  shows a small marker ("2 branches from here"); tap it to switch. The Tree sheet draws the Session's
  conversations as branches off their parent entry, with labels, busy marks, and subagents nested under the
  branch that owns them; tap to switch, long-press to label or archive the branch.
- **Peek tiles** (other sessions' last steps while you are in one): skip for v1; on the unfolded screen the
  session list column already shows working/waiting marks.
- **Notifications**: Android local notifications from the Termux process are not possible; the RN app's
  foreground service keeps a client attached and raises "Pi finished" / "needs approval" notifications from
  Transcript changes while the app is in the background.

## 7b. Storage sheet

Settings -> Storage. Header: total used, free space on the device, a bar. Rows per Session sorted by size:
title, folder, size, images, last active, archived mark; swipe or tap for Archive, Export Markdown, Remove
(confirm with the size). Below: Sweep now (shows what it would free: spill files, orphan uploads, image cache),
and the policies (remove archived after N days, warn above N MB, both off by default). Session list rows show
size in their tooltip-equivalent long-press menu, and the list header shows a warning chip when over the limit.

## 7c. Servers and machines

- **Servers** (Settings -> Servers): rows for local Termux, each Tailscale host (`ws://100.x.y.z:port` + token,
  or `wss://name.ts.net`), and Radius (`radius://<serverId>`), with a connection state dot. The session list
  groups sessions under a server header; "New session" asks which server when more than one is online.
- **Machines** (Settings -> Machines, and the session menu -> "Work on"): pi-env targets. "Add machine": host,
  user, port, default folder; then the host-key fingerprint shown for comparison with Accept / Cancel. In a
  session, "Work on" switches the conversation's target (folder picker browses the remote tree); the top bar
  shows `laptop:~/project` under the title. Subagent spawn takes a machine too.

## 7d. Assistant, memory, device

- **Assistant**: pinned first row of the session list and a floating button on every screen (pi-pocket's PiP);
  opens as a bottom sheet over whatever is open, with its own composer and mic. Its replies link the sessions
  they name; "Open as conversation" shows every step. Header: context fill and Compact.
- **Memory sheet**: lessons in two groups (this project, everywhere), each with source session and Edit /
  Forget; proposals waiting for approval on top with Approve / Discard, also shown under the model's `memory`
  call in the transcript. A Profile text box the user edits directly.
- **Schedules sheet**: upcoming and repeating messages with Cancel; `/schedule` from the composer.
- **Triggers sheet**: notification rules (app, keyword -> instruction), device events, repo watches; each
  with on/off and "From anyone" where relevant.
- **Device sheet**: the three control layers with state (Termux:API installed/granted, ADB paired, app
  services granted), per-tool allow/ask/deny, hourly send limits. Pairing and permission flows start here.

## 7e. Environment sheet (per session; session menu -> Environment)

What a session's tools run with. Every field maps to `configure()` on the conversation or to our documents.

- **Machine**: local / a pi-env machine (section 7c); changing it asks to confirm and re-resolves the folder.
- **Folder**: cwd with the folder picker (browses the chosen machine); **Branch** and **Worktree** rows from
  `Files.exec(git ...)` (switch, new worktree, remove).
- **Shell init**: `commandPrefix` for bash (`source .venv/bin/activate`, `nvm use 22`), plus a timeout and
  output-retention size. Stored in `pi.phone-env`.
- **Env vars**: name -> literal value or a secret reference (`{{secret:OPENAI_KEY}}`); applied to tool
  processes on this session only; secret-backed rows show a lock and never their value.
- **Tools**: toggles for read/write/edit/bash/subagent/phone.* on this session (`configure({ tools })`);
  **Model may call** narrows what the model is offered (`modelTools`); extensions on/off (`extensions`).
- **Instructions**: the session's standing instructions (`configure({ instructions })`), with a template
  picker.
- A footer shows the resolved agent (`conversation.agent()`): model, thinking, machine, folder, tool count.

## 7f. Project sheet (session menu -> Project)

- **Context files**: AGENTS.md and the other files pi loaded for this folder, each openable in the viewer and
  editable in place (writes through `Files`).
- **Skills**: the skills in force (global, `.agents/skills`, settings paths) with source and a short
  description; tap to read SKILL.md. The **trust** question for project skills with Review / Trust / Don't
  trust, as pi asks it; answers saved where pi's CLI keeps them.
- **Prompt templates**: pi's `prompts/*.md` as a list; tap inserts `/name` into the composer.
- **Memory for this project**: shortcut into the Memory sheet filtered to the project.

## 7g. Secrets sheet (Settings -> Secrets)

One screen over three stores, grouped:

- **Provider sign-ins** (`~/.pi/agent/auth.json`, via `Providers`): provider, kind (OAuth / API key /
  environment), source label, expiry for OAuth; Sign out. Values are never shown.
- **Connections** (app Keystore + `~/.pi-phone/`): server tokens per Server row, the Radius token, SSH keys per
  machine (fingerprint, Regenerate, Copy public key), ADB pairing state. Rotate / Forget.
- **Tool secrets** (`~/.pi-phone/secrets.json`, mode 600): name, created, used by N sessions, last used. Add
  (name + value, value field is secure), Reveal (biometric or device credential), Rotate, Delete (warns which
  sessions reference it). Used only through env-var references in the Environment sheet.
- A note at the top: what the model can and cannot see (tool secrets reach processes as env vars; their
  values are redacted from tool output; provider credentials never enter a conversation).

## 7h. Settings tree

```
Settings
  Appearance        theme (system/light/dark), accent, text size, reduce motion, mono font
  Servers           7c
  Machines          7c
  Providers         6b (sign-ins, Claude Code billing patch, default model + thinking)
  Secrets           7g
  Agent             compaction (reserve/keepRecent/background), steering + follow-up mode, tool execution
                    parallel/sequential, progress interval, image resize, retry policy, nested subagents,
                    default tools for new sessions, "send when cheap" default
  Guard             mode (ask outside cwd / ask everything / off), allow and deny lists, approval timeout,
                    phone tool policies and hourly send limits
  Device            7d (layers, pairing, permissions)
  Assistant         model, profile text, compaction threshold, spend limit, Memory and Triggers shortcuts
  Notifications     run ended, needs approval, subagent failed, assistant report, mentions; quiet hours;
                    show on lock screen
  Storage           7b
  Diagnostics       pi checkout commit and package versions, server/worker pids, logs tail, harness.inspect()
                    (blocked tasks), connection states, "Restart server", "Export logs"
```

Settings that the server reads live go to the settings document through a `Settings` facet; app-only ones
stay in `AsyncStorage`. Every row has a one-line description under its label, and dangerous ones (Guard off,
billing patch) carry a warning line.

## 7i. Screen map

```
Session list ---- New session (server, machine, folder, model) ---- Assistant sheet (everywhere)
   |
   +-- Conversation (session, conversation)
   |     |-- top bar: back, title/branch/machine, model chip, tasks badge, menu
   |     |-- transcript, bars, composer, status line
   |     |-- Places sheet: Files, Changes, Tree, Tasks, Find, Branch, Environment, Project, Export
   |     |-- Model picker, Providers (from the picker)
   |     |-- File viewer, Image viewer, Diff viewer
   |     |-- child conversation (subagent / fork), same screen
   |     \-- Session menu: rename, archive, remove, instructions, new context, worktree, storage row
   +-- Running now (all servers)
   \-- Settings tree (7h)
```

## 8. Gestures (from `gestures.js`)

- Swipe right on the conversation: back. Swipe left: Files. Swipe up from the composer: Places sheet.
- Drag a sheet down to close; a mark follows the finger and lights when letting go will act.
- Every control at least 44 dp; small text buttons (Copy on a code block) keep their look but take a wider tap.
- A second quick tap does not land on whatever just slid in (disable taps 200 ms after a layer opens).

Use `react-native-gesture-handler` + `reanimated`; respect reduce-motion.

## 9. Visual

JetBrains Mono for code and tool rows, system sans for prose. Dark/light follow the system. One accent color.
No shadows; 1 dp borders; square corners on tiles (pi-pocket's Omarchy look) are optional, keep it plain.

## Feature list by priority

v1: Providers sheet with Claude subscription login and the Claude Code billing patch, session list, new session with folder picker, transcript (groups, timeline, diffs, live output), composer
with steer/queue/stop, model and thinking picker, status line, abort, compact, reset with handoff note,
instructions, back stack, fold layout, foreground service + notifications, share target.

v2: approvals and a guard, subagents bar and views, Files and Changes review, `@` and `/` and `!`, dictation,
Find in session, export Markdown, pinned sessions, archive.

v3: forks and edit-and-resend, plan mode, scheduled messages, `/until`, memory.
