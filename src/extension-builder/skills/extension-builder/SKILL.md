---
name: extension-builder
description: "Make a pi-phone drop-in extension from a request: a tool Pi can call, a rail button with a page, a menu row with a sheet, or a tool and a page that share data. Usually with extension_create (a subagent writes it from a template; the owner's cards install it switched off, with versions to undo), or by hand with extension_install; then the owner turns it on, and you look at it in the live app. Use when the person asks for a new page, panel, widget, button, timer, tracker or tool in pi-phone itself, or to fix or change a drop-in."
---

# Making a pi-phone drop-in

A drop-in is the owner's own extension: `<data>/extensions/<name>.ts` (the server part), with `<name>.js` or a folder
`<name>/` holding `index.js` (the browser part, if it shows anything) and its other files. It runs inside pi-phone with
everything the app has, secrets included, so it lands switched off and only the owner switches it on.

## First, is a drop-in the answer?

- A setting the app has (`settings`), a theme or palette (`setting_change`), a one-off page or chart (`artifact`), or
  a form for this chat (an OpenUI answer): do that instead.
- A visual request that names no place means a page in the app, not an HTML file or an artifact.
- Choose the details yourself. Ask (`interview`) only when two readings would build different things.

## Through the Creator (the usual way)

Load `extension_create` and `extension_made` with `tool_search` when they are not offered.

1. `extension_create` (name, title, a one-paragraph brief, places): the owner sees a card and says Make it or Not
   now. On Make it, the subagent `made-<name>` writes it in `.made/made-<name>/` and its report ends
   `READY made-<name>: <note>`. Wait for that report; do not write the files yourself.
2. `extension_made` install: it checks the folder and installs it on the owner's card, switched off, as a version.
   Problems come back: send them to the subagent (`subagent` send), then install again after its next READY.
3. The owner switches it on (the progress card's button). Look at it as in step 6 below; fixes go to the subagent,
   and each install is a new version. Then `extension_made` checked, with a one-line note.
4. The owner keeps it, or undoes it, or restores a version (their buttons; `extension_made` keep, undo or restore
   on their word).

## Deliver a small working version first

What the subagent does (and you, making one by hand with `extension_install`):

1. Pick the template that matches (table below) and copy its files into the session folder as `<cwd>/<name>/`,
   renaming the files and the template's name inside them to `<name>`. A name is lowercase letters, digits and `-`,
   not a built-in module's; tools are `<name>_<verb>`, never a built-in tool's name.
2. Change it to do what was asked, and keep it small: one screen, one or two tools. Read `references/server-part.md`
   and `references/browser-part.md` for the APIs, and `references/practices.md` before tools, data or events.
   `extension_inspect` without a name lists what this app has now: `pocket`'s members, the icons, the theme's
   variables, and the tool and module names a drop-in may not take (load it with `tool_search` when it is not offered).
3. Check it: `node <this skill's folder>/scripts/check.mjs <cwd>/<name>` until it says `ok`. It parses the `.ts` as
   pi-phone runs it (erasable TypeScript only) and the `.js` as a module, and checks tool names and the UI rules.
4. Install it: `extension_install` with the folder `<cwd>/<name>` (a lone `.ts` would leave its browser part out). The
   owner reads it on a card. It lands switched off.
5. Have it turned on: ask the owner (Settings › Extensions), or `setting_change` `extensions.<name>.ts` `on` (the owner
   approves a card). Then `extension_inspect` with its name: loaded, failed or refused and why, what it added, and,
   once a tab loaded it, its page and sheet ids and any error of its browser part.
6. Look at it in the live app with the `screenshot` tool (Pi's browser never opens the app's own address): url
   `http://127.0.0.1:8787/?page=<name>:<page id>` (or `?sheet=<name>:<sheet id>`); for what a tap shows, a session's
   address with `?run=<name>:<row id>` (a session menu, menu or launcher row runs, as a tap would: an overlay it opens)
   or `?panelTab=<name>:<tab id>`, e.g. `http://127.0.0.1:8787/s/<session>?run=<name>:<row id>`; widths 390 and 1280,
   and trust the layout check's numbers. For a tool, call it. The installed drop-in is the preview: never a mock page,
   an HTML copy, or pictures of something else. In the Creator flow, then call `extension_made` `checked` with what
   you saw, so its card offers Keep.
7. Fix what you saw in the same files, check, install again (it replaces the old version and is switched off again:
   have it turned on), and look again. Stop when the request works; no variants or extras nobody asked for.
8. Say what it adds and where, how you checked it, and what you could not check (`references/verify.md`).

## Rules

- **Safety.** Never ask for a password, key or token in the chat: a value the drop-in needs is typed on a card with
  `host.ask` (it reaches only the drop-in) or kept in Settings › Secrets. Never write into `<data>/extensions` yourself
  or reach into the app's API, database or WebView: `extension_install`, `setting_change` and `app_action` (its
  `extensions.remove` takes a drop-in away) are the way
  in. A drop-in's data goes in `<host.dataDir>/extension-data/<name>/`, never in `<name>/`, which an update replaces.
- **The owner's UI rules** (the browser part): no emoji anywhere; line icons only, by the app's names (`pocket.Icon`,
  `icon:`); dropdowns are `pocket.Choice` and `pocket.MultiChoice`, never a system `<select>`; a state is
  `pocket.StateTag` (ok, warn, err, off), never a ✓ or ⚠ mark; sizes in whole pixels on a 4 px grid; labels in
  sentence case; colours from the theme's variables; every word shown goes through `t()`, with the drop-in's own
  Vietnamese and Chinese (`WORDS` in the templates).
- **One operation, two callers.** What a person can do on its page, Pi can do with its tool, and both call the same
  function on the server. What only a person may decide (spending, deleting much, granting access) asks on a card.
- **Server code.** TypeScript with erasable syntax only (no `enum`, `namespace`, parameter properties), no `any`,
  imports at the top, `export const pocketApi = 2`. It loads fast: no long waits while it loads.
- **Tool schemas.** `@earendil-works/pi-schema`, as the templates; a TypeBox `Type` is refused (Pi 1.5).

## Templates

Each is a real drop-in that loads as it is. Read its files, then copy them.

| Template | What it shows | Files in `templates/` |
|---|---|---|
| A tool | `zone_time`: one read-only tool, no browser part | `zone-time/zone-time.ts` |
| A rail page | a rail button with a badge, a page (a timer kept in the browser part), and a dock above the message box while it runs | `focus-timer/focus-timer.ts`, `focus-timer/focus-timer.js` |
| A sheet | a menu row and a launcher action that open a sheet; this browser's own storage; `pocket.compose` | `snippets/snippets.ts`, `snippets/snippets.js` |
| A tool and a page | routes, two tools on the same functions, an event to the page, its own stylesheet, how its calls show | `checklist/checklist.ts`, `checklist/checklist/index.js`, `checklist/checklist/checklist.css` |

## Read next

| For | File |
|---|---|
| The server part: files, `defineExtension`, tools, prompt sections, routes, events, `host` | `references/server-part.md` |
| The browser part: `pocket` (rail, menu, launcher, page, sheet, dock, overlay, panelTab, sessionMenu, theme, compose, notify, on, toolCall, pickFolder), the app's pieces, icons, theme variables, words | `references/browser-part.md` |
| Choosing tools, data, events and cards; what not to do | `references/practices.md` |
| Checking it in the live app, and what to report | `references/verify.md` |

Adapted in part from DeepSeek Harness's `cordis-plugin-development` skill (MIT, Copyright (c) 2026 DeepSeek; see
`third_party/deepseek-harness/` in pi-phone).
