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
- Extension points for people's values from 0.22.0 (PP-167): 46d7353 and 8fe0121, with the hidden-value parts of the
  review fixes cdef41e and c5d649f (a message's `@` files, subagents, the `!` refusal, the provider's 5 s and its
  abort listener). Ported: `hidden.ts` (`HiddenValues`, `CommandEnvs`, the stream), `ask` and `checkValues` from
  `extension-points.ts`, `host.hide`, `host.commandEnv`, `host.ask` with their types, the ask card (`AskCard`, its
  CSS with pi-phone's `--hair`), `decided`, the live line's "Waiting for your answer", and tests adapted from
  `test/extension-points.test.ts`. Differs: hidden values go through pi-phone's own Secrets redaction
  (`Secrets.redact/guard` given a session, the secrets extension's `afterTool`), not a core hook and `wrapEnv`, which
  pi-phone keeps beside its native Secrets and Pi's browser sign-in cards; the ask is approval form `{ type: "ask" }`
  answered by `POST /api/asks/<id>` (pi-pocket: any `form`, through `POST /api/approvals/<id>` with `values`); the
  phone hears "Pi asks you: …" as a phone event, not `alerts.ts`; what the caller sets in a command's env wins over a
  provider. Not taken: `host.browser` (pi-phone's browser is its own), `types/pocket.d.ts` and the docs
  (`docs/extensions/people-values.md`, `reference/host.md`: pi-phone has neither), the peek tile change (pi-phone's
  tiles already open any card with a form).
- Drop-ins (PP-171): pi-pocket's drop-in folder is wired again (`prepareDropInFolder`, as its `app.ts` does; not
  `linkTypes`, as pi-phone has no `types/pocket.d.ts`). Differs: pi-phone refuses a drop-in that adds nothing, saying
  which host members it looked for that pi-phone lacks, and lists refusals and file-name clashes in the Extensions
  sheet; its built-in tool list is pi-phone's own. The gallery stays out. Test fixtures: picassio's
  pi-pocket-secrets (f69dce8), pi-pocket-browser-sign-in (82b838b) and pi-pocket-browser-runs (ee9fcdf), unchanged,
  with their licenses (`test/fixtures/gallery/`); since Pi 1.5 (PP-378) their tool schemas use pi-schema.
- Pi 1.5 from 0.28.0 (PP-378, pi-pocket's release/0.28.0 of 2026-11-02): 8d9193a (packages to 1.5.0, pi-schema
  added; pi-phone pins `ws` to 8.21.0, chord 1.5's peer), 714b247 (tool schemas with pi-schema, `tool-schema.ts`'s
  `literal` and `record`; ported by a codemod over pi-phone's own tools, with `literal` for numbers too), 25bd905
  (`onReport` gets a report, `interrupted` runs fail, a compaction's `trigger`; pi-phone's codemode needed no hook
  change), 27ab7ce (one-call watch listeners, `observeCommits`, `watchTaskGraph`), 0b85e98 and ca9fe5a (a room keeps
  the active transcript from `Conversation.context()`; the voice call follows the view's window), 297d024 (a big image
  may go as JPEG), f0c9222 and 0aeb95b (the data is one way: README and DESIGN.md). Not taken: bd03d97 and 21a0bc2
  (drop-ins get TypeBox's `Type` and `StringEnum` on pi-ai through a compat module): the owner's decision of
  2026-11-03 keeps one way, so pi-phone refuses a TypeBox drop-in instead (`typeBoxUse` in `reload.ts`); 977a1e7
  (PiP's artifact schema): pi-phone has no PiP.
- Codemode's Only mode and the prompt budget from 0.27/0.28 (PP-379): f6fd8e8 (the mode, the `wraps` getter,
  `host.toolNames`, a subagent given a script-only tool gets codemode), da646ed (Only hides every tool but the declared
  few, the waiting ones too), c9eb90c (the tools whose cards read their call stay declared: pi-phone's list, as it has
  no ask or memory), 9181570 (the guide: a tool the prompt names is called from a script), eec05c5 (its test), 47a9e57
  (plan mode reads `agent.callable` too), 838f43a and de6d0c1 (what Only covers: pi-phone has no tool search of its own,
  so in Only mode tool_search is hidden with its note and scripts use `searchTools()`), ca33f6b (a section looks in
  `callable` too: pi-phone has no section that checks for a tool, so only the Extension builder's reference says it);
  c3ad1d7 and d623bff (the budget test: pi-phone's measured part, 95,269 characters, became 83,695 once its codemode
  section stopped repeating every tool, and the limit is 85,000). Differs: the mode is a pi-phone setting
  (`codemode.mode`, Menu › Compact context), not an extension setting, and the codemode extension is Pi Durable's tool
  with pi-phone's section. Not taken: adeb991 (a guard for a live reload before the host has `toolNames`: pi-phone's
  built-in modules do not reload live), 35ac7c8 and the texts of d623bff (pocket's own sections and tools; pi-phone's
  differ).
- Sessions an extension starts from 0.28.0 (PP-380): 4886743, 0abf34e, a4ef5cf, 51ca85a, 7e11259, 65030c7, 794133a,
  18f31e0, 7ce5424 and a962d17 as `extension-sessions.ts` (one key one session, keys apart, a repeat for the first
  call's person, a refused first message makes nothing, thinking lowered, records pruned, the race's message sent
  once) and the tests of `test/extension-sessions.test.ts`. Differs: pi-phone has no pi-pocket `linkedSessions` or its
  calls document, so the records are in `ExtensionSessionCallsDoc`; `Commands.createSession` gained `model`,
  `thinkingLevel` and `init`; `host.sessions` was pi-phone's session tools, so their `start` (Pi's session_start) is
  now `startLinked`; the docs are the Extension builder's `server-part.md`. Not taken: 7fb3337 (PiP's test: pi-phone
  has no PiP), 0cef8d4 (pocket's version marks and docs site), the `types/pocket.d.ts` and docs-site parts.
- Agents in their person's language from 0.28.0 (PP-354): merge 6709a10 (d01a97b) as three lines of pi-phone's prompt
  (the subagents and sessions guides, and the guidelines for a `[via session …]` message): pi-phone never had pocket's
  ASD-STE100 rules for agent messages, so nothing is replaced; agent-teams and linked sessions are pocket's, not here.
  Not taken: merge 36d33c7 (2628427d, `pip.md`'s language: PiP), and the PiP parts of d01a97b.
- `host.roleOf` from 0.27 (PP-343): merge 1023cf5 (d2454d6), its `roleOf` and test (as a drop-in's route). Not taken:
  `snapshot().scroll` of `host.browser`, which pi-phone does not have; `types/pocket.d.ts` and the docs (the Extension
  builder's `server-part.md` instead).
- A session waiting on its linked sessions from 0.28.0 (PP-337): merge 040e2fc (7141664), `atWork` and `linkedAtWork`
  for the row's square and `data-state`, with a test in `linked-sessions-ui.test.ts`. Not taken: the Priority tab's
  Working group (pi-phone's list has no Priority tab).
- A linked session's message as an agent's card from 0.28.0 (PP-352): merge 35fc9eb (1030306), as `LinkedMessage` for
  pi-phone's `[via session #N “title”]` marker, on the app's report card with three small rules (no new theme parts),
  the name from the session list, and its row deps. Not taken: `LinkedSessionPeersDoc` and `linkedPeers` (pi-phone's
  marker has the session's id; the list says whether this person can see it), pocket's own card styles.
- A subagent's own spend from 0.28.0 (PP-339): merge 5fa8872 (5655371), `conversationSpent` and its test, as it was.
- Reply to a passage (PP-345): #204 (merge 9f6c06fc: 50ee710), #209 (merge 7c064d81: cb1b142), and from
  release/0.28.0 da1b81a and 64e5abe (the button's look, inside the scrolling area). Differs: the switch is kept with
  the person (`User.appearance`, setting `appearance.quoteReply`), not per browser, so Pi can change it; on a touch
  screen the button docks at the conversation's edge, clear of Android's selection toolbar, not under the selection;
  sizes on the 4 px grid. Not taken: f36e6b5 (math quoted as TeX): pi-phone's math has no `data-tex`.
- A read's picture once (PP-341): #191 (merge c57e0d24: 975d9fc), with its UI test widened to 390 px and to a call
  that brings a new picture (`fetch_content`); pi-phone's screenshot tools (`screenshot`, `browser_screenshot`,
  `phone_screenshot`, `computer_screenshot`) bring new pictures, so they stay under the line.
- Code in people's messages (PP-351): #201 (merge 9a1be60e) and #200's commits on release/0.28.0: 19d1aba, 96731d5
  (its UI test, widened to 390 px and a quoted reply). Differs: sizes as pi-phone's `.md code` and `.md pre` (13 px, on
  the 4 px grid), not em.
