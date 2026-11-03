// Edit on one's own queued message (PP-344, from pi-pocket #194): it leaves the queue and its words and files come back,
// for its sender only; and Pi's session_unsend does the same for a message its session sent with session_send.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { InboxDoc } from "@earendil-works/pi-durable";

/** "stream a long answer" streams for about 20 s at the scripted model's 2000 tokens a second; the rest echo. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    return fauxAssistantMessage([fauxText(text.includes("stream a long answer") ? "word ".repeat(40_000) : `echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

const queue = async (id: Parameters<App["isBusy"]>[0]) => (await app.harness.snapshot(InboxDoc, id, context))?.items ?? [];

test("a queued message taken back to edit gives its sender its words and files, and leaves the queue", async () => {
    const id = await newSession(app);
    const guest = app.config.addUser("Sam", "guest").user;
    const path = join(app.workspace.uploadDirectory(id), "lzx-1234abcd-notes (v2).txt");
    const file = { path, name: "notes (v2).txt", mime: "text/plain", size: 3 };

    writeFileSync(path, "abc");

    try {
        await app.commands.submit(id, owner(app), { text: "stream a long answer", requestId: "e-1" });
        await until(() => app.isBusy(id), "the run to start");
        const { submissionId } = await app.commands.submit(id, owner(app), {
            text: "first line\nsecond line",
            attachments: [file],
            mode: "followUp",
            requestId: "e-2",
        });

        await assert.rejects(app.commands.editQueued(id, guest, Number(submissionId)), /Only its sender/);
        assert.deepEqual(await app.commands.editQueued(id, owner(app), Number(submissionId)), {
            text: "first line\nsecond line",
            attachments: [file],
        });
        assert.equal((await queue(id)).length, 0);
        await assert.rejects(app.commands.editQueued(id, owner(app), Number(submissionId)), /already gone/);
        await assert.rejects(app.commands.editQueued(id, owner(app), 0), /Say which/);
    } finally {
        await app.commands.abort(id, owner(app));
        app.config.removeUser(guest.id);
    }
});

test("session_unsend takes back what this session sent, not someone else's, and the person cannot take Pi's", async () => {
    const sender = await newSession(app);
    const other = await newSession(app);
    const busy = await newSession(app);

    // Pi in a session acts for whoever wrote to it.
    await say(app, sender, "hello");
    await say(app, other, "hello");

    try {
        await app.commands.submit(busy, owner(app), { text: "stream a long answer", requestId: "u-1" });
        await until(() => app.isBusy(busy), "the run to start");

        const message = await app.sessionControl.send(sender, Number(busy), "check the build\nthen the tests", false, "u-2");

        assert.ok(Number.isInteger(message) && message > 0, "its number");
        await assert.rejects(app.sessionControl.unsend(other, Number(busy), message), /Only its sender/, "another session");
        await assert.rejects(app.commands.editQueued(busy, owner(app), message), /Only its sender/, "the person: Pi's message");
        assert.deepEqual(await app.sessionControl.unsend(sender, Number(busy), message), { text: "check the build\nthen the tests", attachments: [] });
        assert.equal((await queue(busy)).length, 0);
        await assert.rejects(app.sessionControl.unsend(sender, Number(busy), message), /already gone/);
    } finally {
        await app.commands.abort(busy, owner(app));
    }
});
