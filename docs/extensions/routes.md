# Routes

A route is a function on the server that answers requests from your browser module. Keys and other secrets stay on the server, in the route.

## Add a route

`web.route(method, path, handle, { access })` adds a route at `/api/x/<module>/<path>`.

```typescript
web.route("GET", "items/:id", ({ params }) => {
    const item = items.get(params.id);

    if (item === undefined) {
        throw web.error(404, "No such item");
    }

    return item;
});
```

- `method` is `GET`, `POST`, `PUT`, `PATCH`, or `DELETE`.
- `path` is relative to the module's own address, for example `"status"` or `"items/:id"`. A part written `:id` matches any one part of the address.
- Each other part has letters, digits, and `.`, `_`, `~`, and `-`, but is not `.` or `..` alone.
- When two paths match, the more specific one answers, in any order of registration: a fixed part wins over a `:name` part, from the left. So `items/new` wins over `items/:id`.

## The request

`handle(request)` gets `{ method, params, query, body, user, signal }`:

- `params`: the `:name` parts of the path.
- `query`: the query string, as `URLSearchParams`. For example, `pocket.api("usage?days=7")` sends `days`.
- `body`: the JSON object that the browser sent. It is empty for `GET` and `DELETE`.
- `user`: who asked, as `{ id, name, role }`.
- `signal`: aborted when the browser stops waiting.

What the handler returns goes back as JSON. `undefined` goes back as `{}`.

## Errors

- To answer with an error, throw `web.error(status, message)`, with a status from 400 to 599. The person who asked gets the status and the message as they are. This includes guests and viewers, when the route is for them. Do not put in the message what you would not show them.
- Any other error is a 500, also an error that has a `status` of its own, as a provider's SDK gives. Such words can quote a key. The owner sees its message; other people see only that the extension failed. The server log has all of it.

## The app's own checks

The app checks each request before your route gets it:

- The person must be signed in.
- The request must have the `X-Pocket` header. A link or a form on another site cannot send it. Your routes need it for `GET` too, so no other site can make a `GET` to them. `pocket.api` always sends it. Anything else that calls your routes must send it too, for example `curl -H 'X-Pocket: 1'`. Without the header, Pi Pocket looks up nothing.

## Text from outside

A `:name` part is text from outside. Pi Pocket decodes the address before it splits it. So it answers 400 for a part that decodes to `..` (for example `..%2F`), or that has a `\` or a NUL in it. A `.` or `..` written as it is never gets to your route: the address resolves it first. But still check a part before you make a file path from it.

## Time

A route has no time limit. A handler that waits keeps its request open until it answers, or until the browser stops waiting, which aborts `signal`. Give `signal` to what the handler waits for.

## Who may use it

Routes and the browser module are for the owner alone, unless their `access` says more:

| `access`            | Who                                                  |
| ------------------- | ---------------------------------------------------- |
| `"owner"` (default) | The owner                                            |
| `"steer"`           | The owner, and guests who can steer every session    |
| `"view"`            | The owner, guests, and viewers who see every session |

- A person invited to one session never may use them: these parts belong to the whole app.
- Each route checks its own `access`. So a browser module for everyone can have a route for the owner alone.
- `access` is the same for each method. A `POST` route open to `"view"` lets viewers change something through it, though they cannot steer a session. Give a route that changes things `"owner"` or `"steer"`.
- A browser module runs with the rights of the person whose tab loads it. So it can do nothing in a guest's tab that the guest cannot do.

To other people, a route is not there. They get the same 404 as for a path that the module does not have, and a 405 names only the methods that they may use. So another route whose path matches can answer them: `items/:id` answers `items/new`, with `id` `"new"`. Give routes whose paths overlap the same `access`, or check `user.role` in the handler.
