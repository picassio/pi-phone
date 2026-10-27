// Voice turns in the transcript (PP-188): what was said in a call and did not go to Pi as a message is kept as a row
// marked voice (the owner's words and the voice's); a request handed to Pi is the owner's message marked voice instead,
// not twice; what the voice says for Pi (Pi's words read back) is not kept again; in "Chat only" Pi gets the talk with
// the next message, as a note, and otherwise never.
import { type App, cleanUp, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { projectEntry, type ClientEntry } from "../src/server/projection.ts";
import { transcriptMarkdown } from "../src/server/export.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

let app: App;
let openai: FakeOpenAI;

before(async () => {
    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(), join(root, "turns-data"), undefined, {
        voice: { endpoints: openai.endpoints, auth: async () => ({ token: TOKEN }) },
    });
    await app.voice.check();
});

after(async () => {
    await app?.close();
    await openai?.close();
    cleanUp();
});

async function entries(id: ConversationId): Promise<ClientEntry[]> {
    const view = await (await app.conversation(id)).viewState(BACKGROUND_CONTEXT);

    try {
        return view.value.entries.map((entry) => projectEntry(entry)).filter((entry): entry is ClientEntry => entry !== undefined);
    } finally {
        view.dispose();
    }
}

async function call(id: ConversationId) {
    const start = (await app.startVoiceCall(owner(app), id)) as { call: string; key: string; url: string };
    const posted = await fetch(start.url, { method: "POST", headers: { authorization: `Bearer ${start.key}`, "content-type": "application/sdp" }, body: "v=0\r\n" });
    const rtc = posted.headers.get("location")!.split("/").pop()!;

    app.voice.joined(owner(app).id, start.call, rtc);
    await until(() => openai.sidebands.get(rtc)?.received.some((event) => event.type === "session.update") === true, "joined", 10_000);

    return { start, push: (event: Record<string, unknown>) => openai.push(rtc, event) };
}

test("Pi works: small talk is a voice row for people only; a request handed to Pi is the owner's message marked voice, and the ack a voice row", async () => {
    const id = await newSession(app);
    const live = await call(id);

    // Small talk: the voice answers itself.
    live.push({ type: "response.created" });
    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "Can you hear me?" });
    live.push({ type: "response.output_audio_transcript.done", transcript: "Yes, loud and clear." });
    live.push({ type: "response.done" });
    await until(async () => (await entries(id)).some((entry) => entry.kind === "voice"), "the voice row");

    const row = (await entries(id)).find((entry) => entry.kind === "voice") as Extract<ClientEntry, { kind: "voice" }>;

    assert.deepEqual(row.turns, [
        { speaker: "you", text: "Can you hear me?" },
        { speaker: "voice", text: "Yes, loud and clear." },
    ]);
    assert.equal(row.chat, false);
    assert.equal(row.live, "gpt-realtime-2");

    // A request: to Pi as the owner's message; the owner's words are not kept twice, the ack is.
    live.push({ type: "response.created" });
    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "Check the deploy please" });
    live.push({ type: "response.function_call_arguments.done", name: "ask_pi", call_id: "fc-1", arguments: JSON.stringify({ request: "check the deploy" }) });
    live.push({ type: "response.done" });
    await until(() => [...openai.sidebands.values()].at(-1)!.received.some((event) => event.type === "conversation.item.create" && JSON.stringify(event).includes("function_call_output")), "the tool's answer");
    live.push({ type: "response.created" });
    live.push({ type: "response.output_audio_transcript.done", transcript: "On it." });
    live.push({ type: "response.done" });
    await until(async () => (await entries(id)).filter((entry) => entry.kind === "voice").length === 2, "the ack's row");

    const all = await entries(id);
    const message = all.find((entry) => entry.kind === "user") as Extract<ClientEntry, { kind: "user" }>;

    assert.equal(message.text, "[voice] check the deploy");
    await until(() => app.sessionMeta(id)?.title !== undefined, "a title");
    assert.ok(!app.sessionMeta(id)!.title!.includes("[voice]"), "the title is the words, not the voice mark");
    assert.ok(!JSON.stringify(all).includes("Check the deploy please"), "the owner's words went to Pi as the request");
    assert.deepEqual((all.filter((entry) => entry.kind === "voice")[1] as Extract<ClientEntry, { kind: "voice" }>).turns, [{ speaker: "voice", text: "On it." }]);

    // Pi's words read back by the voice are Pi's, in the transcript already.
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("echo: [voice] check the deploy")), "Pi answered");
    await until(() => [...openai.sidebands.values()].at(-1)!.received.some((event) => JSON.stringify(event).includes("Pi says: echo")), "Pi's words sent to be spoken");
    live.push({ type: "response.created" });
    live.push({ type: "response.output_audio_transcript.done", transcript: "Pi says the deploy is fine." });
    live.push({ type: "response.done" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal((await entries(id)).filter((entry) => entry.kind === "voice").length, 2, "not kept again");

    // Pi never had the voice rows.
    assert.ok(!(await modelTexts(app, id)).some((text) => text.includes("loud and clear")));
    assert.match(transcriptMarkdown({ title: "t", cwd: "/", exportedAt: new Date(), entries: await entries(id), authors: {} }), /_Voice:_ Yes, loud and clear\./);
    app.voice.end(live.start.call);
});

test("Chat only: the talk is a voice row, and Pi gets it as a note with the next message", async () => {
    const id = await newSession(app);

    await app.setSessionVoiceMode(id, owner(app), "chat");

    const live = await call(id);

    live.push({ type: "response.created" });
    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "What does a Front Door route do?" });
    live.push({ type: "response.output_audio_transcript.done", transcript: "It sends requests for a path to an origin." });
    live.push({ type: "response.done" });
    await until(async () => (await entries(id)).some((entry) => entry.kind === "voice"), "the row");
    assert.equal(((await entries(id)).find((entry) => entry.kind === "voice") as Extract<ClientEntry, { kind: "voice" }>).chat, true);
    app.voice.end(live.start.call);

    await app.commands.submit(id, owner(app), { text: "Now fix our route", requestId: crypto.randomUUID() });
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("echo: Now fix our route")), "Pi answered");

    const context = await modelTexts(app, id);
    const note = context.findIndex((text) => text.includes("[voice chat, before this message]") && text.includes("Voice: It sends requests for a path to an origin."));

    assert.ok(note >= 0, "Pi had the talk");
    assert.ok(note < context.findIndex((text) => text.includes("Now fix our route")), "before the message");
});
