# web

`web` is the second argument of a module's default export. With it, a module adds to the app what a tool cannot: routes on the server, a browser module, and commands for the message box. [Adding to the app](../app.md) tells you how the parts work together.

Register routes, the browser module, and commands while the module loads. After that, these calls throw. What you register goes when this version of the module goes: an edit replaces it, or the owner turns the module off.

The types are `Web` and the types that it uses, in [types/pocket.d.ts](../../../types/pocket.d.ts).

## About the module

### `api`

```ts
readonly api: number;
```

Since 0.14.0 · Stable

The version of the extension API. [API versions](api-versions.md) tells you when it changes.

### `module`

```ts
readonly module: string;
```

Since 0.14.0 · Stable

The module's name: the name of its file without `.ts`. The routes of `server-status.ts` are under `/api/x/server-status/`.

## Registering

### `route`

```ts
route(method: WebMethod, path: string, handle: WebHandler, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Adds a route at `/api/x/<module>/<path>`. `handle` answers its requests.

- `method` is a [`WebMethod`](#webmethod).
- `path` is relative to the module's routes: `"status"`, or `"items/:id"`. A part written `:name` matches any one part of the address. [Names](names.md#routes) gives the characters that a part can have.
- When paths overlap, the most specific path answers, whatever the order of registration. From the left, a fixed part comes before a `:name` part: `items/new` comes before `items/:id`.
- `access` says who can use the route. The default is `"owner"`. See [`WebAccess`](#webaccess).
- A method and a path of the same shape can have only one route.

[Routes](../routes.md) tells you about the checks that come before a handler, errors, and what to check in a handler.

### `client`

```ts
client(entry: string, options?: { access?: WebAccess }): void;
```

Since 0.14.0 · Stable

Sets the module's browser module. A module has one browser module at most.

- `entry` is the name of a file or folder immediately beside the module. It must not be a link. [Names](names.md#browser-modules) gives the characters that it can have.
- A `.js` or `.mjs` file is served alone.
- A folder must have an `index.js`, which loads first and can import the other files of the folder.
- `access` says whose tabs load it. The default is `"owner"`. See [`WebAccess`](#webaccess).

[Browser modules](../browser-modules.md) tells you which files a folder serves, and when tabs load a new version.

### `command`

```ts
command(name: string, command: Command): void;
```

Since 0.14.0 · Stable

Adds the command `/name` to the message box, for the people who can run it. The command runs on the server, and it does not ask Pi.

- [Names](names.md#commands) gives the rules for `name`.
- [Command context](command-context.md) gives the fields of `command` and what its handler gets and returns.
- [Slash commands](../commands.md) tells you who can run a command, how a run is kept, and how a person stops it.

## Sending and answering

### `send`

```ts
send(event: string, data?: unknown, options?: { to?: string }): void;
```

Since 0.14.0 · Stable

Sends an event to the browser module. There, `pocket.on(event, run)` gets it.

- `data` is a value that JSON can hold.
- Without `to`, the event goes to the tabs of all the people that the browser module's `access` lets in. With `to`, it goes only to the tabs of the person with that id.
- Send events only after the module has loaded, and only from a module that has a browser module. Other events go nowhere.
- `send` never throws, because modules call it mostly from timers. When it cannot send an event, it writes the reason to the server's log, one time for each kind of mistake in a version.

[Events](../events.md) tells you about the limits, and about tabs that fall behind.

### `error`

```ts
error(status: number, message: string): Error;
```

Since 0.14.0 · Stable

Makes an error for a route or a command handler to throw: `throw web.error(404, "No such item")`. The person who asked gets `status` and `message` as they are. `status` is from 400 to 599.

Do not put text in `message` that this person must not see. Any other error that a handler throws gives a status of 500, and only the owner sees its words.

### `onDispose`

```ts
onDispose(dispose: () => unknown): void;
```

Since 0.14.0 · Stable

Runs `dispose` when this version of the module goes: an edit replaces it, the owner turns it off, or the server stops. Stop timers and close connections there. `dispose` can return a promise. [Cleanups](../cleanups.md) tells you how long a stopping server waits for it.

## Requests

### `WebHandler`

```ts
type WebHandler = (request: WebRequest) => unknown;
```

Since 0.14.0 · Stable

Answers the requests of a route. The value that it returns goes back as JSON, and `undefined` goes back as `{}`. It can be async.

### `WebRequest`

```ts
interface WebRequest {
    readonly method: WebMethod;
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    readonly body: Readonly<Record<string, unknown>>;
    readonly user: Person;
    readonly signal: AbortSignal;
}
```

Since 0.14.0 · Stable

What a handler gets.

- `method`: the request's method.
- `params`: the values of the path's `:name` parts, by name. They are text from outside: check a value before you make a file path from it.
- `query`: the query string. `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for GET and DELETE.
- `user`: the person who asked, as `{ id, name, role }`.
- `signal`: it aborts when the browser stops waiting for the answer. Give it to the work that the handler waits for.

### `WebMethod`

```ts
type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
```

Since 0.14.0 · Stable

The methods that a route can have.

## Access

### `WebAccess`

```ts
type WebAccess = "owner" | "steer" | "view";
```

Since 0.14.0 · Stable

Who can use a route, or whose tabs load a browser module.

- `"owner"`, the default: the owner alone.
- `"steer"`: the owner, and guests who can steer all sessions.
- `"view"`: the owner, guests, and viewers who can see all sessions.

A person invited to one session never can, because these parts belong to the whole app. Each route has its own `access`, so a browser module for everyone can call a route for the owner alone.

`access` is the same for all methods. A POST route with `"view"` lets viewers change something through it, though they cannot steer a session. Give `"owner"` or `"steer"` to a route that changes things.

To a person that its `access` does not let in, a route is not there. The person gets the same 404 as for a path that the module does not have. Thus another route whose path matches can answer the person. Give the same `access` to routes whose paths overlap, or check `user.role` in the handler.
