# The browser part (`pocket`, API version 2)

The browser part is an ES module the app loads in the tabs of the people its `access` lets in. Its default export gets
`pocket` and may return a cleanup function. No build step and no imports of the app's files: everything comes through
`pocket`. Start it with `export const pocketApi = 2;`.

```js
export const pocketApi = 2;
const WORDS = { vi: { "Focus timer": "Hẹn giờ tập trung" }, "zh-CN": { "Focus timer": "专注计时" } };

export default function create(pocket) {
    const { html, useState, Icon, StateTag, t, language } = pocket;
    const say = (english, vars) => t(WORDS[language()]?.[english] ?? english, vars);
    pocket.rail({ id: "main", title: say("Focus timer"), icon: "clock", page: "main" });
    pocket.page({ id: "main", title: say("Focus timer"), component: () => html`<p>${say("Focus timer")}</p>` });
}
```

## What it can add

Each takes an object with an `id` (letters, digits, `. _ : -`, up to 64) and answers `{ update(patch), remove() }`.
Adding the same id again replaces it. All of it goes when the module reloads or is turned off.

| Call | Fields | Where it shows |
|---|---|---|
| `pocket.rail(spec)` | `title`, `icon` or `iconPath`, `badge` (a number: 0 shows none, over 99 shows 99+; or short text), and one of `page`, `sheet`, `panelTab`, `overlay`, `run` | a button in the rail, after the app's own |
| `pocket.menu(spec)` | `label`, `hint`, and one of `page`, `sheet`, `panelTab`, `overlay`, `run` | a row in the menu |
| `pocket.launcher(spec)` | `label`, `detail`, `icon`, `keywords` (words), and one of `page`, `sheet`, `panelTab`, `overlay`, `run` | an action in the launcher (Ctrl+K) |
| `pocket.page(spec)` | `title`, `component`, `escape: false` (keeps Esc), `swipe: false` (keeps sideways swipes) | the conversation's place, with a title and a close button |
| `pocket.sheet(spec)` | `title`, `component`, `wide`, `bare` (draws its own header) | a sheet (a bottom sheet on a phone) |
| `pocket.dock(spec)` | `component` (gets `{ pocket, sessionId }`), `sessions(sessionId)` (true where it shows; every session without it) | a strip one line (32 px) high right above the message box; at most two modules' docks show, the newest loaded |
| `pocket.overlay(spec)` | `title`, `component`, `width` (whole px, 160 to 480; 240) | a small panel floating over the app, dragged by its title, closed with ×; where it was put is kept in that browser; on a phone it stays above the message box and the keyboard |
| `pocket.panelTab(spec)` | `title`, `icon`, `component` (gets `{ pocket, sessionId, close }`) | a tab in the side panel beside Pi's browser and computer, opened from the top bar's panel button; on a phone the panel covers the screen, as Pi's browser does |
| `pocket.sessionMenu(spec)` | `label`, `hint`, `run(sessionId)` | a row in a session's menu (the top bar's title or ⋯) |

`page`, `sheet`, `panelTab` and `overlay` in a rail, menu or launcher spec are the ids of its own; `overlay` shows one
closed with × again (adding it again does too); `run` is a function. A component gets `{ pocket, close }` (and a sheet
the props it was opened with). A dock is one line: what does not fit is cut, so keep it to a few words and a button.

`pocket.theme({ "--accent": "#ff9e64", "--bg": "#101014" })` sets the app's colours while the module is on, over
Appearance's colours and the theme: only colour tokens (the palette's `--o-*` and the app's colours made from them;
`extension_inspect` lists them), each a CSS colour. Called again it replaces them; its answer's `remove()` takes them
away; they go when the module is turned off, and none apply in safe mode. When two modules set the same token, the
newest loaded wins, and `extension_inspect` says whose shows. Setting `--o-*` recolours everything made from them.

## Doing things

- `pocket.api(path, body?, { method? })`: calls its own routes (`/api/x/<name>/<path>`); no body gets, a body posts.
  Rejects with an Error holding the server's words: show it with `pocket.notify("error", error.message)`.
- `pocket.on(event, fn)`: hears `web.send(event, data)`; answers how to stop (return it from a `useEffect`).
- `pocket.notify(level, message)`: a notice, `info`, `warning` or `error` (5 in 5 s at most).
- `pocket.compose(text)`: puts text in the message box after what is there; the person sends it or not.
- `pocket.pickModel({ title?, sub?, value?, entries? })`: the app's model picker, as a session's model is picked (every
  signed-in account's models with their plan figures, search, favorites); answers `provider/id` (an account's provider
  is `provider~account`), the value of one of `entries` (`{ value, label, detail? }`, shown first), or null. It takes
  the sheet's place: open your sheet again after it answers.
- `pocket.pickFolder({ start?, title? })`: the app's folder picker; answers a path (`machine:<id>:<path>` on a
  machine) or null.
- `pocket.toolCall({ tool, label(args), subject?(args), summary?(args), icon? })`: how calls of its own tools show in
  the transcript.
- `pocket.openPage(id)`, `pocket.closePage()`, `pocket.openSheet(id, props?)`, `pocket.closeSheet()`,
  `pocket.openPageOf(module, id)` (another module's page).
- `pocket.style("look.css")`: a stylesheet from its own folder (the folder form, `<name>/index.js`).
- `pocket.onDispose(fn)`: runs when this version goes: stop timers and listeners there.
- `pocket.me()` (`{ id, name, role }`), `pocket.conversationId()` (the open session, or null), `pocket.module`,
  `pocket.title`, `pocket.version`.

A module that calls `pocket` without end, or opens pages and sheets without end, is stopped in that tab, as one that
failed to load: what it added goes, and a notice says why.

## Drawing with the app's pieces

`h`, `html` (htm), `Fragment`, and the hooks `useState`, `useEffect`, `useLayoutEffect`, `useRef`, `useMemo`,
`useCallback`, `useReducer` are the app's own Preact. Its pieces:

- `Icon` `{ name, size }`: a line icon by name; sizes 16 in rows and buttons, 20 in heads and the rail, 24 in empty
  states, stroke 2 (the app's scale, PP-403). The names: menu, pip, more, close, send, stop, play, pause, mic, voice, speaker, micoff, clip, plus,
  artifact, folder, file, diff, back, clock, chevron, minus, down, up, eye, search, shield, board, external, key, users,
  sparkle, chat, fork, command, sidebar, tiles, grid, pin, star, palette, pulse, keyboard, swatch, home, archive,
  unarchive, unread, check, logout, globe, reload, copy, undo, phone, tablet, monitor, upload, download, terminal, fit,
  compact, wheel. An unknown name draws a square of four. `extension_inspect` lists the names this app has now.
- `Choice` `{ value, options: [{ value, label, detail? }], onChange(value), label, disabled?, placeholder? }`: the
  app's dropdown. `MultiChoice` `{ options: [{ value, label, detail?, group?, disabled?, chosen? }], onAdd(values),
  label, placeholder? }`: tick several. Never a system `<select>`.
- `StateTag` `{ tone: "ok" | "warn" | "err" | "off", label, title? }`: a state as a word and a dot.
- `Switch` `{ on, onChange, label, disabled? }`, `Loader` `{ label }`, `Spinner` `{ label }`, `Markdown` `{ text }`.
- The app's classes: `button` (with `primary`, `ghost`, `small`), `icon-button` (with `small`; give it an
  `aria-label`), `field` with a `<span class="label">` above its input, `label`, `muted`, `small`, `empty`.

## The theme's variables

Colours and corners come from the theme, so the drop-in follows every theme and light or dark: never colours of its
own. `extension_inspect` lists every one; the ones to use:

- Text: `--text`, `--body`, `--muted`, `--faint`. Grounds: `--bg`, `--panel`, `--card`, `--card-2`, `--raised`,
  `--hover`, `--pressed`. Lines: `--line`, `--line-strong`, `--hair`, `--hair-2`.
- Accent: `--accent`, `--accent-ink` (text on it), `--accent-fill`, `--accent-soft`, `--accent-line`. States: `--ok`,
  `--ok-soft`, `--warn`, `--warn-soft`, `--warn-line`, `--err`, `--err-soft`, `--err-line`.
- Corners: `--r-tag`, `--r-row`, `--r-control`, `--r-card`, `--r-window`, `--r-sheet`. Type: `--sans`, `--mono`.
  Shadows: `--shadow`, `--pop`.

Sizes in whole pixels: type 12, 13, 14, 16, 20 or 24; padding, margins and gaps on the 4 px grid. Weights 400 to 600.
Labels in sentence case, without letter spacing; a count is a plain number after its label ("Open 3").

## Words

Every word it shows goes through `t()`: `t(sentence, { name })`, `tn(n, one, other)` for a count, `tx(sentence,
{ name: element })` for a sentence with elements in it. The app's catalog has the app's own words only, so the drop-in
brings its own Vietnamese and Chinese: a `WORDS` table by language (`language()` is `"en"`, `"vi"` or `"zh-CN"`) and
`say = (english, vars) => t(WORDS[language()]?.[english] ?? english, vars)`. Placeholders stay as they are
(`{n}`); the English sentence is the key.

## Links and safe mode

- `http://127.0.0.1:8787/?page=<name>:<page id>` and `?sheet=<name>:<sheet id>` open its page or sheet once it loads
  (for `screenshot`).
- `?noext=1` opens the app with no browser parts (safe mode), for as long as the tab stays open: Menu › Extensions
  turns them back on.
- A browser part that fails to load says so in a notice and in Settings › Extensions; a component that throws shows
  "<title> failed: why" in its own place, and the rest of the app goes on. Either way the tab tells the server, and
  `extension_inspect` with the drop-in's name shows the newest such error, with what the browser part added once it
  loaded (its rail, menu, launcher, page and sheet ids).
