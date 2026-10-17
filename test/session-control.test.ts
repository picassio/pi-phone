// Sessions controlling other sessions: as the person a session works for, with their rights; never themselves; what
// they read is fenced as data; the tools are there for Pi.
import { type App, cleanUp, context, lastText, modelTexts, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("list the sessions")) {
        return fauxAssistantMessage([fauxToolCall("sessions", {})], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `listed: ${text}` : `echo: ${text.slice(-40)}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function session(text: string): Promise<ConversationId> {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return id;
}

test("Pi lists the sessions with its tool", async () => {
    const id = await session("please list the sessions");
    const texts = (await modelTexts(app, id)).join("\n");

    assert.match(texts, new RegExp(`#${String(id)} `));
    assert.match(texts, /idle|working/);
});

test("a session starts another, messages it, waits for it, reads it, and stops it; never itself", async () => {
    const caller = await session("hello");
    const control = app.sessionControl;
    const { id } = await control.start(caller, { cwd: work, message: "first task", key: crypto.randomUUID() });
    const target = id as unknown as ConversationId;

    await app.commands.configure(target, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const waited = await control.wait(caller, id, 20_000, new AbortController().signal);

    assert.match(waited, /Its run ended/);
    assert.ok(control.list(caller).some((each) => each.id === id));

    await control.send(caller, id, "second task", false, crypto.randomUUID());
    await control.wait(caller, id, 20_000, new AbortController().signal);
    const read = await control.read(caller, id);

    assert.match(read, new RegExp(`\\[via session #${String(caller)} `));
    assert.match(read, /second task/);
    assert.match(read, /<session-transcript>[^]*<\/session-transcript>/);

    await assert.rejects(control.send(caller, Number(caller), "to myself", false, crypto.randomUUID()), /That is this session/);
    await control.stop(caller, id);
    assert.match(control.status(caller, id), /idle/);
    await assert.rejects(control.read(caller, 999_999), /no session #999999/);
});

test("a session works for its person with their rights: someone invited to one session reaches no other", async () => {
    const ownerSession = await session("the owner's");
    const { id: shared } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(shared, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const { user: guest } = app.config.addUser("Guest", "guest", [String(shared)]);
    const { submissionId } = await app.commands.submit(shared, guest, { text: "hi", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    assert.deepEqual(app.sessionControl.list(shared).map((each) => each.id), [Number(shared)]);
    await assert.rejects(app.sessionControl.read(shared, Number(ownerSession)), /not shared with you/);
    await assert.rejects(
        app.sessionControl.start(shared, { cwd: work, message: "x", key: crypto.randomUUID() }),
        /invited to one session/,
    );
});
