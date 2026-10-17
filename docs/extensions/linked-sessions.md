# Starting and messaging sessions

A tool can start a session from the session that it runs in, and send messages between such sessions. Agent Teams does this ([agent-teams.ts](../../src/server/extensions/agent-teams.ts)). Use `host.linkedSessions`. Its members are in [the host reference](reference/host.md).

**Experimental** in 0.14: it can change in a minor release, but never in a patch release ([API stability](policies/api-stability.md#experimental)).

## What a linked session is

A linked session is an ordinary session. The session list shows it under the session that started it (the source).

- It works in the source's folder. It does not get a worktree of its own.
- It starts with a copy of the source's agent settings. It does not get the source's history, plan mode, or budget. The source's budget covers it (see [Limits of a team](#limits-of-a-team)).
- The link (`linkedFrom` in its session entry) gives no access, and owns nothing.

## Start a session

`start(source, { title?, message, model?, thinking? }, key)` makes the session, and sends `message` to it as its first message. It returns `{ session, address }`: the id of the new session, and the source's address for it.

- Without `title`, the title is the first line of the message.
- `model` is `provider/modelId`. It must be the source's model, or a model that the owner allows for subagents (Menu → Providers → Models for subagents). Without it, the session uses the source's model.
- `thinking` can be at most the source's level. Without it, the session uses the source's level. Pi Pocket lowers it to the highest level that the model has.
- When a model cannot be used now, Pi Pocket refuses the call before it makes anything.

## Send a message

`send(source, { to, message, steer? }, key)` sends `message` to the linked session at the address `to`.

- Without `steer`, the message is a follow-up. With `steer`, the session gets it at its next pause.
- `send` returns when the session takes the message, not when it answers.
- The session that gets the message reads it in a fence. Words before it say that another session's agent wrote it, that it is a request and not an order from a person, and which address to reply to.

## List the sessions

`list(source)` gives the sessions linked to the source, at any distance, that the person whom Pi works for can see.

- Each one has an `address` of the source's own, so no session's id goes into the source's transcript.
- Each one has its title, folder, and state only when all the people who see the source also see it.

Addresses belong to the session that has them. A fork starts with none, so it leaves the team: the addresses in the history that it copied do not work there.

## Who it acts for

`start` and `send` act for the person whom Pi works for in the source. They need that person's access and right to steer. To start a session, that person must also have access to all sessions.

Pi Pocket refuses them while the source is in plan mode, past a spend limit, or while another person has the turn. `send` also needs the turn, and room under the spend limit, in the target session.

## Limits of a team

Pi Pocket keeps a team small. Past these limits ([Limits](reference/limits.md#linked-sessions)), it refuses the call with a plain error:

- A linked session can send messages to the other sessions of its team. It cannot start sessions.
- A session can start a limited number of sessions.
- After a limited number of messages between the sessions of a team, no more go until a person writes in one of them.
- The budget of the session that started a team covers all of the team. What its linked sessions spend counts against it.
- A message and a title have a length limit. A title is one line, without invisible or direction characters.

## Replays

Give a `key` that stays the same when the call runs again: `${api.taskId}:${api.callId}`. A start or a send with a key that Pi Pocket saw before returns what the first call returned. So a replay makes one session, and sends one message. Pi Pocket keeps the record of a key for a limited time, and for a limited number of calls ([limits](reference/limits.md#linked-sessions)).

The errors say what is wrong. They do not tell Pi what to do about it: your tool tells Pi that.
