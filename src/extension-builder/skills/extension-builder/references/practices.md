# Drop-in practices

Adapted for pi-phone from DeepSeek Harness's `cordis-plugin-development` skill (`references/practices.md` and
`references/user-actions.md`; MIT, Copyright (c) 2026 DeepSeek). These follow from how pi-phone loads drop-ins.

## Principles

1. **The weakest mechanism that does it.** A tool before a prompt section; a page before a sheet only when it is used
   for long; a menu row before a rail button for something used now and then. A prompt section costs every request
   in every session: add one only when Pi must know something no tool description says.
2. **Registrations belong to the module's version.** What the server part registers (routes, the client, commands) and
   what the browser part adds (rail, pages, sheets, tool-call looks) go when the module reloads or is turned off. A
   timer, a watcher or a listener you start yourself does not: stop it in `web.onDispose` (server) or
   `pocket.onDispose` (browser).
3. **The app draws; the drop-in computes.** Draw with `pocket.html` and the app's pieces in a page or sheet. Never write
   to `document.body`, never draw outside its own component, and never serve an HTML page to show in a frame: a frame
   gets neither the theme nor the language.
4. **Its UI is part of the app's UI.** People see one app: the theme's variables, the app's pieces and classes, the
   app's words in their language, and the layout of a page of the same kind (a list like Settings' lists, a page like
   the Boards page). Choose where it shows (rail page, sheet, menu, launcher) before writing any view.
5. **Its data is its own.** Keep it in `<host.dataDir>/extension-data/<name>/` as JSON, written whole (a temporary
   file, then a rename). A missing file is empty; a file that cannot be read is an error, said as it is. Never another
   module's files, the app's database, or `<data>/extensions/`.

## One operation, two callers

1. Write each operation that changes its data once, on the server: it returns the result or throws an Error whose words
   say what is wrong.
2. The page calls it through a route (`pocket.api`) and shows the failure (`pocket.notify("error", …)`).
3. Pi calls it through a tool with the same meaning and parameters (related operations may share one tool with an
   `action`), and gets the same failure as the tool's error.
4. After a change, `web.send("changed", …)` so an open page shows it, whoever made it.

Pure view changes (a tab, a folded section) need no tool. What grants or confirms authority (approving something,
answering a question Pi asked, loosening a rule, spending money, deleting much) stays the person's: on a card
(`host.ask`) or on the page only, never a tool Pi can run alone. Check it: do the operation through the tool alone,
and compare what changed with the page's action.

## Tools

- One clear job each, named `<name>_<verb>`, with a description that says when to use it. Never a built-in tool's name
  (the drop-in is refused whole).
- A tool that only reads says so (`annotations: { readOnlyHint: true }`): plan mode lets it run. `replay: "safe"` only
  when running it twice is harmless.
- Its answer is short text Pi can act on: what changed, or what is wrong and how to put it right.

## Values people type

Never ask for a password, key or token in the chat, and never put one in a file you read back or in the drop-in's
source. A value the drop-in needs is typed on a card (`host.ask` with a `secret: true` field: it reaches only the
drop-in), or kept by the owner in Settings › Secrets and given to commands by name. Hide a value the drop-in holds
from what Pi reads with `host.hide`.

## Performance

- The module loads fast: read files and start timers lazily, never wait for the network while it loads.
- The browser part draws on change, not on a timer faster than it needs (a clock: once a second). Updating a rail
  badge to the same value costs nothing; an update loop without end gets the module stopped.
- Send events with small data; an event is at most 256 KB, and 100 a second.
