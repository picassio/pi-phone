// Sessions controlling other sessions: as the person a session works for, with their rights; never themselves; what
// they read is fenced as data; the tools are there for Pi.
import { type App, cleanUp, context, lastText, modelTexts, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

/** The session the rescue tools act on (PP-99), set by each test. */
let stuck = 0;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("list the sessions")) {
        return fauxAssistantMessage([fauxToolCall("sessions", {})], { stopReason: "toolUse" });
    }

    const rescue: Record<string, [string, Record<string, unknown>]> = {
        "fork the stuck one": ["session_fork", { session: stuck, message: 1, reason: "its last message fails every request" }],
        "new context there": ["session_new_context", { session: stuck, reason: "start it fresh" }],
        "compact it": ["session_compact", { session: stuck, focus: "the task", reason: "its context is full" }],
    };

    for (const [ask, [tool, args]] of Object.entries(rescue)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
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

/** Ask Pi in `caller`, answer the card it raises (`allow`), and answer what it said then. */
async function rescue(caller: ConversationId, ask: string, allow: boolean): Promise<string> {
    const { submissionId } = await app.commands.submit(caller, owner(app), { text: ask, requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(caller).length > 0, "the card");
    const card = app.approvals.forConversation(caller)[0]!;

    await app.answerApproval(card.id, allow, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return `${card.tool}: ${card.subject}\n${(await modelTexts(app, caller)).at(-1)!}`;
}

const peopleSaid = async (id: ConversationId) =>
    (await app.transcripts.allEntries(id, false)).flatMap((entry) => (entry.kind === "user" ? [entry.text] : []));

test("Pi gets another session past what stops it: fork before a message, a new context, a compaction, each on a card (PP-99)", async () => {
    const caller = await session("the rescuer");
    const target = await session("first task");

    await app.sessionControl.send(caller, Number(target), "the message that fails", false, crypto.randomUUID());
    await app.sessionControl.wait(caller, Number(target), 20_000, new AbortController().signal);
    stuck = Number(target);
    const before = app.sessions(owner(app)).length;

    // No: nothing changes.
    const refused = await rescue(caller, "fork the stuck one", false);

    assert.match(refused, /^session_fork: Fork #\d+ .* before the person's message \(the latest\)/);
    assert.match(refused, /said no: nothing was forked/);
    assert.equal(app.sessions(owner(app)).length, before);

    // Yes: a new session that ends before the message, which sent nothing.
    const forked = await rescue(caller, "fork the stuck one", true);
    const fork = Number(/as #(\d+)/.exec(forked)![1]) as unknown as ConversationId;

    assert.deepEqual(await peopleSaid(fork), ["first task"]);
    assert.equal((await peopleSaid(target)).length, 2, "the session itself stays as it was");

    // New context: Pi there sees nothing of before; people still do.
    assert.match(await rescue(caller, "new context there", true), /Started a new context in #/);
    const view = await (await app.harness.conversation(target, context))!.context(context);

    assert.ok(!JSON.stringify(view.messages).includes("first task"), "not in what the model gets");
    assert.equal((await peopleSaid(target)).length, 2, "still in the history");

    // Compact: on a card too, with what the summary should keep.
    const compacted = await rescue(caller, "compact it", true);

    assert.match(compacted, /^session_compact: Compact the context of #\d+ .*, keeping: the task/);
    assert.match(compacted, /Compacting #\d+/);
});

test("the rescue tools refuse this session and sessions the person cannot drive, before any card (PP-99)", async () => {
    const caller = await session("myself");
    const control = app.sessionControl;

    await assert.rejects(control.checkRescue(caller, Number(caller), false), /That is this session/);
    await assert.rejects(control.fork(caller, Number(caller), 1), /That is this session/);
    await assert.rejects(control.newContext(caller, Number(caller)), /That is this session/);
    await assert.rejects(control.compact(caller, Number(caller), undefined), /That is this session/);
    await assert.rejects(control.checkRescue(caller, 999_999, true), /no session #999999/);

    const other = await session("one message");

    await assert.rejects(control.fork(caller, Number(other), 5), /has 1 message from people/);
    assert.equal(app.approvals.forConversation(caller).length, 0, "no card was raised");
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

test("the limit on messages to other sessions: the owner's for all, a session's own, or none", async () => {
    const caller = await session("limits");
    const target = await session("the one messaged");
    const control = app.sessionControl;
    const send = () => control.send(caller, Number(target), "again", false, crypto.randomUUID());

    assert.deepEqual(control.limitOf(caller), { limit: 30, own: false });
    await app.setSessionSendLimit(owner(app), 2);
    await send();
    await send();
    await assert.rejects(send(), /sent or started 2 times in the last hour, the most a session may/);
    assert.equal(control.used(caller), 2);

    // Its own: none, then a number of its own, then the setting again.
    await app.setSendLimit(caller, owner(app), null);
    await send();
    await app.setSendLimit(caller, owner(app), 3);
    await assert.rejects(send(), /the most it may/);
    await app.setSendLimit(caller, owner(app), "inherit");
    assert.deepEqual(control.limitOf(caller), { limit: 2, own: false });

    await assert.rejects(app.setSendLimit(caller, owner(app), 0), /whole number from 1 to 10000/);
    const { user: guest } = app.config.addUser("Someone", "guest");

    await assert.rejects(app.setSessionSendLimit(guest, null), /Only the owner/);
    await app.setSessionSendLimit(owner(app), null);
    assert.deepEqual(control.limitOf(caller), { limit: null, own: false });
    await app.setSessionSendLimit(owner(app), 30);
});
