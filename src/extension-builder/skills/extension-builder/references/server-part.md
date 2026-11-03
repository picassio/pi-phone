# The server part

## Files

A drop-in in the owner's drop-in folder (`<data>/extensions/`, which you never write: `extension_install` puts it
there):

- `<name>.ts`: the module, loaded by the server. `<name>` is letters, digits, `_` and `-` (no dots), and not a built-in
  module's name.
- `<name>.js` (or `.mjs`), or a folder `<name>/` with `index.js` and the files it loads: the browser part, named by
  `web.client`. The folder is served as is (`.js`, `.css`, `.json`, `.svg`, images, `.woff2`), never `.ts`.
- Anything else under `<name>/` belongs to it too. A package is at most 5 MB and 1000 files. Install the folder you
  wrote it in (`<cwd>/<name>/`, its top holding `<name>.ts`): files there not named `<name>.*` or `<name>/` are left out.

The module imports the packages the server runs (`@earendil-works/pi-schema`, `@earendil-works/pi-durable`,
`@earendil-works/pi-ai`, `node:*`); nothing is installed with npm. Node runs it with type stripping: erasable TypeScript only, imports at the top.

## The module

```ts
/** One sentence: what it does. (The Extensions sheet shows the doc comment's first sentence.) */
import { obj, num, opt, str } from "@earendil-works/pi-schema";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

export const pocketApi = 2;

export default function create(host: Host, web: Web) {
    web.client("<name>.js");            // only with a browser part
    return defineExtension({ name: "<name>", tools: [...], sections: [...] });
}
```

- The default export gets `host` and `web` and returns its extension(s); it may be async. A module that only adds a
  browser part returns nothing. One that returns nothing and adds nothing is refused.
- Type `host` and `web` with small local types of the parts it uses, as the templates do (`type Web = { client(entry:
  string): void }`): pi-phone ships no type file for drop-ins.
- An extension's `name` is the drop-in's own: never `pocket-…` or `coding-tools`.

## Tools

```ts
const tool = defineTool({
    name: "<name>_<verb>",                 // never a built-in tool's name (extension_inspect lists them)
    description: "What it does, for Pi.",
    parameters: obj({ text: str({ description: "…" }), count: opt(num()) }),
    replay: "safe",                        // only when running it twice is harmless (it only reads)
    execute: async (args, api, context) => ({ output: [{ type: "text", text: "…" }] }),
});
const readOnly = Object.assign(tool, { annotations: { readOnlyHint: true } }); // plan mode lets it run
```

- An error is `{ output: [{ type: "text", text: "what is wrong and how to put it right" }], isError: true }`.
- `api.conversationId`, `api.taskId`, `api.callId` say where it runs (for `host.ask`).
- Build `parameters` with `@earendil-works/pi-schema`: `obj`, `str`, `num`, `int`, `bool`, `arr`, `union`, `lit`, and
  `opt(...)` for a property that may be left out. `obj` is closed (no other properties); `obj(props, { open: true })`
  lets others through. Pi Durable checks the arguments against it before `execute` runs.
- `oneOf(["add", "remove"])` for an action; related actions may share one tool.
- Never TypeBox: no `Type` from `@earendil-works/pi-ai` (Pi 1.5 no longer has it) and no `typebox` import. pi-phone
  refuses such a drop-in on load, and `scripts/check.mjs` says so first.

## Prompt sections

`section("<key>", (input) => "text" | undefined)` in `sections: [...]` adds text to every session's system prompt
while the drop-in is on. Each costs every request: keep it to a sentence or two, and only when Pi must know it
without a tool description saying it.

## Routes, the browser part, events, commands (`web`)

- `web.route(method, path, handler, { access?, maxBytes? })`: answers `/api/x/<name>/<path>` (`GET`, `POST`, `PUT`,
  `PATCH`, `DELETE`; a part `:id` matches one part, in `request.params.id`). The handler gets `{ method, params,
  query, body, user, signal }` (`body` is the JSON object sent) and returns a value sent as JSON. `throw
  web.error(400, "words")` answers with that status and words; any other throw is a 500.
- `web.client(entry, { access? })`: the browser part, a `.js` beside the module or a folder with `index.js`.
- `access`: `"owner"` (the default), `"steer"` (people who can drive a session) or `"view"`. Keep the default unless
  others must use it.
- `web.send(event, data, { to? })`: an event to the browser part (`pocket.on(event, …)` there), to everyone it loads
  for or one person (`to`: their id). It never throws.
- `web.command(name, { description, args?, scope, handler })`: a `/name` command in the message box (`name` has a
  `-`, like `zone-now`); `scope: "conversation"` for whoever drives the session, `"global"` for the owner. The handler
  gets `(args, { user, conversationId, cwd, signal })` and returns `{ type: "toast", level, message }` or
  `{ type: "card", output }`.
- `web.onDispose(fn)`: runs when this version goes (an edit, turned off, the server stopping): stop timers there.
- Register routes, the client and commands while the module loads, not later.

## The host

- `host.dataDir`: the app's data folder. Keep the drop-in's data in `join(host.dataDir, "extension-data", "<name>")`.
- `host.ask({ conversationId, id, taskId, callId?, title, text?, fields?, submit? }, context)`: a card in the session
  for the person Pi works for; up to 6 fields `{ name, label, secret?, placeholder?, autocomplete? }`. The answer is
  `{ answered: true, by, values }` or `{ answered: false, by }`, and the values go only to the drop-in, never to Pi or
  the transcript. `id` is `${api.taskId}:${api.callId}`. Never keep the values in a document or a memo.
- `host.hide({ value, label, conversationId? })`: hides a value (4 to 4096 characters) from what Pi and people read; it
  shows as `[label]`. Returns how to stop: pass it to `web.onDispose`.
- `host.commandEnv((run) => ({ NAME: "value" }) | undefined)`: adds variables to the commands sessions run (`run`:
  `{ conversationId, command, cwd }`). Returns how to stop: pass it to `web.onDispose`.
- `host.notice(level, message, conversationId?)`: a notice to the log and the open tabs.
- `host.browser` is pi-pocket's and pi-phone does not have it: a drop-in that needs it is refused.

## Why a drop-in is refused or fails

- A tool with a built-in tool's name: refused whole, naming the tools. Rename them.
- It returned nothing and added nothing (or looked for a host member pi-phone lacks): refused, naming it.
- A file with a built-in module's name: never loaded.
- A syntax error, `enum`, a missing import, a throw while it loads, or a load longer than the limit: it fails, with the
  error, and stays off until fixed and turned on again.
