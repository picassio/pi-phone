// What the app's background service notifies the owner of: a session's run ending, with its answer.
import { type App, cleanUp, context, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a session's run ending reaches the phone's poll, with the end of its answer, and only what is new", async () => {
    const start = await app.phoneEvents.after(-1, new AbortController().signal);

    assert.deepEqual(start.events, []);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const polled = app.phoneEvents.after(start.seq, new AbortController().signal);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ping", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const { seq, events } = await polled;

    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "done");
    assert.equal(events[0]!.session, Number(id));
    assert.equal(events[0]!.text, "echo: ping");

    // Nothing new: the poll waits, and answers with nothing when asked to stop.
    const waiting = new AbortController();
    const next = app.phoneEvents.after(seq, waiting.signal);

    waiting.abort();
    assert.deepEqual((await next).events, []);
});
