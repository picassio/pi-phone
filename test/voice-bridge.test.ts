// The voice bridge (PP-187, src/server/voice-bridge.ts) against a fake OpenAI: the server joins a call by its id with
// the sign-in and sets its instructions (the session's context) and tools; ask_pi gives the session's Pi a message
// marked voice; Pi's words are spoken back a response at a time (two sentences first, then by paragraph); a tool Pi
// runs is a cue; OpenAI ending the call counts its minutes; "Pi thinks" sends what is said to Pi and reads Pi out; and
// Codex's own voice goes through the page's data channel in its delegation protocol.
import { type App, cleanUp, fakeTab, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { speakable, speechChunks } from "../src/server/voice-bridge.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";

test("Pi's text is spoken without code or Markdown: its first two sentences, then a paragraph at a time", () => {
    assert.equal(speakable("Run `npm test` in **web**:\n```sh\nnpm test\n```\nSee [the log](http://x)."), "Run npm test in web:\n (code) \nSee the log.");
    assert.deepEqual(speechChunks("Yes. It finished at 14:02. All green.\n\nOne thing: the route."), ["Yes. It finished at 14:02.", "All green.", "One thing: the route."]);
    assert.deepEqual(speechChunks("Done.\n\n- first\n- second"), ["Done.", "first second"]);
    assert.deepEqual(speechChunks("```\ncode only\n```"), ["(code)"]);
});

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("[voice] is the deploy done?")) {
        return fauxAssistantMessage([fauxText("Yes. It finished at 14:02. All green.\n\nOne thing: the `/api` route is old.")]);
    }

    if (role === "user" && text.includes("[voice] run the tests")) {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "echo 12 passed" } as never)], { stopReason: "toolUse" });
    }

    if (role === "toolResult" && text.includes("12 passed")) {
        return fauxAssistantMessage([fauxText("12 passed.")]);
    }

    if (role === "user" && text.includes("[voice] what time is it")) {
        return fauxAssistantMessage([fauxText("It is noon.")]);
    }

    if (role === "user" && text.includes("[voice] open the task")) {
        return fauxAssistantMessage([fauxText("Done: TL-41.")]);
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;
let openai: FakeOpenAI;
let clock = Date.now();
const logs: string[] = [];

before(async () => {
    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(route), join(root, "bridge-data"), () => clock, {
        log: (line) => logs.push(line),
        voice: { endpoints: openai.endpoints, auth: async () => ({ token: TOKEN, account: "acct-1" }) },
    });
    await app.voice.check();
});

after(async () => {
    await app?.close();
    await openai?.close();
    cleanUp();
});

/** Start a call by key in a session and post its offer as the page does; the sideband once the server joined. */
async function call(id: ConversationId) {
    const start = (await app.startVoiceCall(owner(app), id)) as { call: string; key: string; url: string };
    const posted = await fetch(start.url, { method: "POST", headers: { authorization: `Bearer ${start.key}`, "content-type": "application/sdp" }, body: "v=0\r\n" });
    const rtc = posted.headers.get("location")!.split("/").pop()!;

    app.voice.joined(owner(app).id, start.call, rtc);
    await until(() => openai.sidebands.get(rtc)?.received.some((event) => event.type === "session.updated" || event.type === "session.update") === true, "the server joined", 10_000);

    const side = openai.sidebands.get(rtc)!;
    const sent = (type: string) => side.received.filter((event) => event.type === type);
    const said = () =>
        sent("conversation.item.create")
            .map((event) => (event.item as { type: string; content?: { text: string }[]; output?: string }))
            .map((item) => (item.type === "message" ? item.content![0]!.text : `output: ${item.output}`));

    return { start, rtc, side, sent, said, push: (event: Record<string, unknown>) => openai.push(rtc, event) };
}

test("the server joins by the call's id with the sign-in, with the session's context and Pi's tools; ask_pi reaches Pi, Pi's words come back a response at a time", async () => {
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "We deployed AHA Test today", requestId: crypto.randomUUID() });
    await until(async () => (await modelTexts(app, id)).length >= 2, "the first answer");

    const live = await call(id);

    assert.equal(live.side.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(live.side.headers["chatgpt-account-id"], "acct-1");

    const update = live.sent("session.update")[0]!.session as { instructions: string; tools: { name: string }[]; model?: string };

    assert.match(update.instructions, /<startup_context>[\s\S]*Owner: We deployed AHA Test today/);
    assert.deepEqual(update.tools.map((tool) => tool.name), ["ask_pi", "stop_pi"]);
    assert.equal(update.model, undefined, "the model is the call's");
    assert.ok(!JSON.stringify(live.side.received).includes(TOKEN), "the token only in the header");

    // The owner asks; the live model hands it to Pi.
    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "Is the deploy done?" });
    live.push({ type: "response.created" });
    live.push({ type: "response.function_call_arguments.done", name: "ask_pi", call_id: "fc-1", arguments: JSON.stringify({ request: "is the deploy done?" }) });
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("[voice] is the deploy done?")), "Pi got the message, marked voice");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(live.sent("response.create").length, 0, "nothing asked for while the tool's response runs");
    // The response that called the tool ends: then the tool's answer, and the ack is asked for.
    live.push({ type: "response.done" });
    await until(() => live.said().some((text) => text.startsWith("output: Pi is on it")), "the tool's answer");
    assert.equal(live.sent("response.create").length, 1, "the ack is asked for");

    // Pi answered meanwhile: Pi's words wait for the ack to run and end.
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("It finished at 14:02")), "Pi's answer");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.ok(!live.said().some((text) => text.startsWith("Pi says:")), "nothing before the ack");
    live.push({ type: "response.created" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.ok(!live.said().some((text) => text.startsWith("Pi says:")), "nothing over the ack");
    live.push({ type: "response.done" });
    await until(() => live.said().includes("Pi says: Yes. It finished at 14:02."), "the first two sentences");
    live.push({ type: "response.created" });
    live.push({ type: "response.done" });
    await until(() => live.said().includes("Pi says: All green."), "then the rest of the paragraph");
    live.push({ type: "response.done" });
    await until(() => live.said().includes("Pi says: One thing: the /api route is old."), "then the next paragraph");

    // OpenAI ends the call: its minutes are counted.
    clock += 120_000;
    const before = app.spend.voiceSummary().today.call;

    openai.hangUp(live.rtc);
    await until(() => app.voice.calls().length === 0, "the call ended");
    await app.spend.voiceStored();
    assert.equal(app.spend.voiceSummary().today.call, before + 120);
    assert.ok(!logs.some((line) => line.includes(TOKEN)));
});

test("a tool Pi runs is a short cue, at most every cueSeconds; stop_pi stops Pi", async () => {
    const id = await newSession(app);
    const live = await call(id);

    clock += 60_000;
    live.push({ type: "response.function_call_arguments.done", name: "ask_pi", call_id: "fc-2", arguments: JSON.stringify({ request: "run the tests" }) });
    live.push({ type: "response.done" });
    await until(() => live.said().some((text) => text.startsWith("output: ")), "the tool's answer");
    live.push({ type: "response.created" });
    live.push({ type: "response.done" });
    await until(() => live.said().some((text) => text === "Pi is working: bash echo 12 passed"), "the cue", 10_000);

    const cue = live.sent("response.create").at(-1) as { response?: { instructions?: string } };

    assert.match(String(cue.response?.instructions), /what Pi is doing now/);
    live.push({ type: "response.done" });
    await until(() => live.said().includes("Pi says: 12 passed."), "then Pi's words");

    live.push({ type: "response.function_call_arguments.done", name: "stop_pi", call_id: "fc-3", arguments: "{}" });
    live.push({ type: "response.done" });
    await until(() => live.said().includes("output: Pi stopped."), "stopped");
    app.voice.end(live.start.call);
});

test("Pi thinks: what is said goes to Pi as it is, and Pi's words are read out, not answered", async () => {
    const id = await newSession(app);

    await app.setSessionVoiceMode(id, owner(app), "think");

    const live = await call(id);
    const update = live.sent("session.update")[0]!.session as { tools?: unknown; audio: { input: { turn_detection: { create_response: boolean } } } };

    assert.equal(update.tools, undefined);
    assert.equal(update.audio.input.turn_detection.create_response, false);

    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "what time is it" });
    await until(() => live.said().includes("Read aloud: It is noon."), "read out");

    const read = live.sent("response.create").at(-1) as { response?: { instructions?: string } };

    assert.match(String(read.response?.instructions), /exactly as written/);
    assert.ok((await modelTexts(app, id)).some((text) => text.includes("[voice] what time is it")));
    app.voice.end(live.start.call);
});

test("Pi thinks with the device's voice as the reader: Pi's words go to the page to read out, never to the live model", async () => {
    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));

    app.attach(tab.client);
    await app.setSessionVoiceMode(id, owner(app), "think");
    await app.setVoice(owner(app), { reader: "device" });

    const live = await call(id);

    live.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "what time is it" });
    await until(() => tab.events.some((each) => each.event === "voice" && each.data.say === "It is noon."), "read out by the page");
    assert.equal((tab.events.find((each) => each.event === "voice" && each.data.say !== undefined)!.data as { call: string }).call, live.start.call);
    assert.ok(!live.said().some((text) => text.startsWith("Read aloud:")), "the live model reads nothing");
    assert.equal(live.sent("response.create").length, 0);
    app.voice.end(live.start.call);
    app.detach(tab.client);
    await app.setVoice(owner(app), { reader: "live" });
});

test("the session's voice mode changed during a call: the call's instructions, tools and turn-taking follow, without hanging up", async () => {
    const id = await newSession(app);
    const live = await call(id);

    await app.setSessionVoiceMode(id, owner(app), "chat");
    await until(() => live.sent("session.update").length === 2, "a second session.update");

    const update = live.sent("session.update")[1]!.session as { instructions: string; tools: unknown[] };

    assert.match(update.instructions, /You chat by voice/);
    assert.deepEqual(update.tools, []);
    assert.equal(app.voice.calls().find((each) => each.id === live.start.call)?.mode, "chat");
    app.voice.end(live.start.call);
});

test("the mode changed in a call whose turn-taking the page changed (PP-201): the update keeps the call's own, not Settings › Voice's", async () => {
    const id = await newSession(app);
    const live = await call(id);

    app.voice.mic(owner(app).id, live.start.call, { muted: true, by: "hold", turns: "hold" });
    await app.setSessionVoiceMode(id, owner(app), "chat");
    await until(() => live.sent("session.update").length === 2, "a second session.update");

    const update = live.sent("session.update")[1]!.session as { audio: { input: { turn_detection: unknown; noise_reduction: unknown } } };

    assert.equal(update.audio.input.turn_detection, null, "still hold to talk");
    assert.deepEqual(update.audio.input.noise_reduction, { type: "near_field" });
    app.voice.end(live.start.call);
});

test("Codex's own voice: the page passes the data channel; a delegation reaches Pi and Pi's words go to its context", async () => {
    await app.setVoice(owner(app), { model: "gpt-live-1.1-codex" });

    const id = await newSession(app);
    const tab = fakeTab(undefined, owner(app));

    app.attach(tab.client);

    const start = (await app.startVoiceCall(owner(app), id)) as { call: string; path: string };

    assert.equal(start.path, "codex");
    await app.voice.answer(owner(app).id, start.call, "v=0\r\noffer\r\n", await app.voicePlan(id));
    await until(() => app.voiceBridge.has(start.call), "joined through the page");
    await new Promise((resolve) => setTimeout(resolve, 300));
    app.voiceBridge.fromPage(app.voice.call(owner(app).id, start.call), [
        { type: "delegation.created", item: { type: "delegation", id: "del-1", target: "client", content: [{ type: "input_text", text: "open the task" }] } },
    ]);
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("[voice] open the task")), "Pi got it");
    await until(
        () =>
            tab.events.some(
                (each) =>
                    each.event === "voice" &&
                    JSON.stringify(each.data).includes('"delegation.context.append"') &&
                    JSON.stringify(each.data).includes("Done: TL-41."),
            ),
        "Pi's words to the delegation, through the page",
    );
    app.voice.end(start.call);
    app.detach(tab.client);
    await app.setVoice(owner(app), { model: "gpt-realtime-2" });
});
