// Voice with the owner's ChatGPT sign-in (PP-185, src/server/voice.ts): the settings and their checks, the live model
// check against a fake OpenAI (which way each model's calls are set up), settings checked live before they are kept,
// a call's set-up for each way, minutes in Spend and the daily limit, and the sign-in's token never reaching the page,
// the logs, or a refusal's words.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import { DEFAULT_VOICE, readVoice, storedVoice, withVoice, chatgptAccount, callSession, voiceInstructions } from "../src/server/voice.ts";
import { appSettings } from "../src/server/settings-registry.ts";
import type { User } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

test("a patch is checked key by key; only what differs from the defaults is kept", () => {
    assert.deepEqual(withVoice(DEFAULT_VOICE, { mode: "chat", turns: "hold" }), { ...DEFAULT_VOICE, mode: "chat", turns: "hold" });
    assert.equal(withVoice(DEFAULT_VOICE, { language: " VI " }).language, "vi");
    assert.equal(withVoice(DEFAULT_VOICE, { dailyLimit: 30 }).dailyLimit, 30);
    assert.throws(() => withVoice(DEFAULT_VOICE, { mode: "sing" }), /work, chat, or think/);
    assert.throws(() => withVoice(DEFAULT_VOICE, { cueSeconds: 1.5 }), /whole number of seconds/);
    assert.throws(() => withVoice(DEFAULT_VOICE, { dailyLimit: 0 }), /1 to 1440/);
    assert.throws(() => withVoice(DEFAULT_VOICE, { language: "vietnamese" }), /two-letter code/);
    assert.throws(() => withVoice(DEFAULT_VOICE, { dictationModel: "gpt-live-1.1-codex" }), /transcription model/);
    assert.throws(() => withVoice(DEFAULT_VOICE, { loud: true }), /no setting "loud"/);
    assert.equal(storedVoice(DEFAULT_VOICE), undefined);
    assert.deepEqual(storedVoice({ ...DEFAULT_VOICE, engine: "codex" }), { engine: "codex" });
    assert.deepEqual(readVoice({ engine: "codex", mode: "nonsense" }), { ...DEFAULT_VOICE, engine: "codex" });
    assert.equal(chatgptAccount(TOKEN), "acct-1");
});

test("a call's configuration: hands-free answers by itself, hold to talk waits, Pi thinks never answers", () => {
    const plan = { mode: "work" as const, instructions: voiceInstructions("work", "Deploy"), tools: [{ type: "function", name: "ask_pi" }] };
    const session = callSession({ ...DEFAULT_VOICE, language: "vi" }, plan) as { audio: { input: { turn_detection: unknown; transcription: unknown }; output: unknown }; tools?: unknown };

    assert.deepEqual(session.audio.input.turn_detection, { type: "semantic_vad", interrupt_response: true, create_response: true });
    assert.deepEqual(session.audio.input.transcription, { model: "gpt-4o-transcribe", language: "vi" });
    assert.deepEqual(session.audio.output, { voice: "marin" });
    assert.deepEqual(session.tools, plan.tools);
    assert.equal((callSession({ ...DEFAULT_VOICE, turns: "hold" }, plan) as { audio: { input: { turn_detection: unknown } } }).audio.input.turn_detection, null);
    assert.deepEqual(
        (callSession(DEFAULT_VOICE, { ...plan, mode: "think", tools: [] }) as { audio: { input: { turn_detection: { create_response: boolean } } }; tools?: unknown }).audio.input.turn_detection.create_response,
        false,
    );
    assert.match(voiceInstructions("work"), /ask_pi/);
    assert.match(voiceInstructions("think"), /Read aloud:/);
});

let app: App;
let openai: FakeOpenAI;
let server: Server;
let base = "";
let clock = Date.now();
const logs: string[] = [];

const call = async (path: string, body?: unknown) => {
    const response = await fetch(`${base}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();

    return { status: response.status, text, json: text === "" ? {} : (JSON.parse(text) as Record<string, unknown>) };
};

before(async () => {
    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(), join(root, "voice-data"), () => clock, {
        log: (line) => logs.push(line),
        voice: { endpoints: openai.endpoints, auth: async () => ({ token: TOKEN, account: "acct-1" }) },
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    await openai?.close();
    cleanUp();
});

test("the model check finds each live model's way (key, through pi-phone, Codex's), hides the rest, and keeps it", async () => {
    const answer = await call("voice/check", {});

    assert.equal(answer.status, 200, answer.text);

    const check = app.config.voiceCheck!;

    assert.deepEqual(check.live, [
        { id: "gpt-realtime-2", path: "key" },
        { id: "gpt-realtime-1.5", path: "server" },
        { id: "gpt-realtime-mini", path: "key" },
        { id: "gpt-live-1.1-codex", path: "codex" },
    ]);
    assert.deepEqual(check.dictation, ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
    assert.deepEqual(check.hidden, ["gpt-realtime"]);

    const saved = JSON.parse(readFileSync(app.config.file, "utf8")) as { voiceCheck?: { live: unknown[] } };

    assert.equal(saved.voiceCheck?.live.length, 4, "kept in config.json");
    // The check went with the sign-in's account, as Codex sends it.
    assert.equal(openai.requests[0]!.headers["chatgpt-account-id"], "acct-1");

    const hello = (await app.hello(owner(app))) as { server: { voice?: { check: unknown; settings: unknown } } };

    assert.deepEqual(hello.server.voice?.check, check);
    assert.deepEqual(hello.server.voice?.settings, DEFAULT_VOICE);
});

test("a model, voice or language is checked with OpenAI before it is kept, and a refusal says why", async () => {
    await assert.rejects(app.setVoice(owner(app), { model: "gpt-realtime-9" }), /gpt-realtime-9 is not a live model for your sign-in: The model `gpt-realtime-9` does not exist/);
    await assert.rejects(app.setVoice(owner(app), { voice: "nobody" }), /has no voice "nobody": Invalid voice/);
    await assert.rejects(app.setVoice(owner(app), { language: "xx" }), /does not take the language "xx"/);
    assert.deepEqual(app.config.voice, DEFAULT_VOICE, "nothing refused is kept");

    // Through Pi's settings tools: the same checks, the same method.
    const registry = appSettings(app);
    const model = registry.settings.find((each) => each.id === "voice.model")!;

    await model.apply(owner(app), "gpt-realtime-mini", undefined);
    assert.equal(app.config.voice.model, "gpt-realtime-mini");
    assert.deepEqual(await model.choices?.(), ["gpt-realtime-2", "gpt-realtime-1.5", "gpt-realtime-mini", "gpt-live-1.1-codex"]);
    await registry.settings.find((each) => each.id === "voice.language")!.apply(owner(app), "vi", undefined);
    await registry.settings.find((each) => each.id === "voice.dailyLimit")!.apply(owner(app), "45 min", undefined);
    assert.equal(app.config.voice.dailyLimit, 45);
    await assert.rejects(Promise.resolve(registry.settings.find((each) => each.id === "voice.mode")!.apply(owner(app), "shout", undefined)), /work, chat, or think/);

    const guest: User = { id: "guest-1", name: "Gina", role: "guest" } as User;

    await assert.rejects(app.setVoice(guest, { mode: "chat" }), /Only the owner/);
    await app.setVoice(owner(app), { model: "gpt-realtime-2", language: "auto", dailyLimit: null });
    assert.deepEqual(app.config.voice, DEFAULT_VOICE);
});

test("a session has its own voice mode, or Settings › Voice's", async () => {
    const id = await newSession(app);

    assert.equal(app.voiceModeOf(id), "work");
    assert.equal((await call(`c/${id}/voice`, { mode: "chat" })).status, 200);
    assert.equal(app.voiceModeOf(id), "chat");
    assert.equal(app.sessionMeta(id)?.voiceMode, "chat");
    assert.equal((await call(`c/${id}/voice`, { mode: "loud" })).status, 400);

    const setting = appSettings(app).settings.find((each) => each.id === "sessions.voiceMode")!;

    await setting.apply(owner(app), "inherit", String(id));
    assert.equal(app.sessionMeta(id)?.voiceMode, undefined);
    assert.equal(await setting.read(String(id)), "inherit (work)");
});

test("a call by key: the page gets a short-lived key with the whole configuration in it, never the token; minutes go to Spend", async () => {
    const id = await newSession(app);
    const started = await call(`c/${id}/voice/call`, {});

    assert.equal(started.status, 200, started.text);
    assert.ok(!started.text.includes(TOKEN), "the token stays on the server");

    const start = started.json as { call: string; path: string; key: string; url: string; model: string };

    assert.equal(start.path, "key");
    assert.match(start.key, /^ek_test_/);
    assert.equal(start.url, `${openai.endpoints.api}/realtime/calls`);

    const minted = openai.keys.get(start.key) as { model: string; instructions: string; audio: { output: { voice: string } } };

    assert.equal(minted.model, "gpt-realtime-2");
    assert.equal(minted.audio.output.voice, "marin");
    assert.match(minted.instructions, /ask_pi/);

    // The page posts its offer with the key (as web/voice-call.js does), then names the call.
    const posted = await fetch(start.url, { method: "POST", headers: { authorization: `Bearer ${start.key}`, "content-type": "application/sdp" }, body: "v=0\r\n" });
    const rtc = posted.headers.get("location")!.split("/").pop()!;

    assert.equal((await call(`voice/calls/${start.call}/joined`, { rtc: "not-an-id" })).status, 400);
    assert.equal((await call(`voice/calls/${start.call}/joined`, { rtc })).status, 200);
    assert.equal(app.voice.calls()[0]?.rtc, rtc);

    clock += 90_000;
    assert.equal((await call(`voice/calls/${start.call}/end`, {})).status, 200);
    await app.spend.voiceStored();
    assert.equal(app.spend.voiceSummary().today.call, 90);
    assert.equal(app.voice.calls().length, 0);

    const spend = (await call("spend")).json as { voice?: { today: { call: number }; month: { call: number } } };

    assert.equal(spend.voice?.today.call, 90);
    assert.equal(spend.voice?.month.call, 90);
});

test("a call through pi-phone: the server posts the page's offer with the sign-in and gives back only the answer", async () => {
    await app.setVoice(owner(app), { model: "gpt-realtime-1.5" });

    const id = await newSession(app);
    const start = (await call(`c/${id}/voice/call`, {})).json as { call: string; path: string; key?: string };

    assert.equal(start.path, "server");
    assert.equal(start.key, undefined);

    const answered = await call(`voice/calls/${start.call}/sdp`, { sdp: "v=0\r\no=- offer\r\n" });

    assert.equal(answered.status, 200, answered.text);
    assert.match(String(answered.json.sdp), /^v=0/);
    assert.ok(!answered.text.includes(TOKEN));

    const made = [...openai.calls.values()].at(-1)!;

    assert.equal(made.by, "sign-in");
    assert.equal(made.offer, "v=0\r\no=- offer\r\n");
    assert.equal(app.voice.calls().find((each) => each.id === start.call)?.rtc?.startsWith("rtc_test"), true);
    app.voice.end(start.call);
    await app.setVoice(owner(app), { model: "gpt-realtime-2" });
});

test("the daily limit refuses a call once today's minutes are used, and a refusal never quotes the token", async () => {
    await app.setVoice(owner(app), { dailyLimit: 1 });

    const id = await newSession(app);
    const refused = await call(`c/${id}/voice/call`, {});

    assert.equal(refused.status, 429);
    assert.match(String(refused.json.error), /Today's voice minutes \(1\) are used up/);
    await app.setVoice(owner(app), { dailyLimit: null });

    // OpenAI quoting the request back: the token is taken out of what the page reads.
    const quoted = await call("settings", { voice: { model: "quote-me" } });

    assert.equal(quoted.status, 400);
    assert.match(quoted.text, /No model quote-me for Bearer \[token\]/);
    assert.ok(!quoted.text.includes(TOKEN));
    assert.ok(!logs.some((line) => line.includes(TOKEN)), "never in the logs");
});

test("Codex dictation: a key for a transcription session with the dictation model and language; its seconds are counted", async () => {
    await app.setVoice(owner(app), { engine: "codex", language: "vi" });

    const answer = await call("voice/dictation", {});

    assert.equal(answer.status, 200, answer.text);
    assert.ok(!answer.text.includes(TOKEN));

    const dictation = answer.json as { dictation: string; key: string; model: string };
    const session = openai.keys.get(dictation.key) as { type: string; audio: { input: { transcription: unknown } } };

    assert.equal(session.type, "transcription");
    assert.deepEqual(session.audio.input.transcription, { model: "gpt-4o-transcribe", language: "vi" });

    const before = app.spend.voiceSummary().today.dictation;

    clock += 12_000;
    assert.equal((await call(`voice/dictation/${dictation.dictation}/end`, {})).status, 200);
    assert.equal(app.spend.voiceSummary().today.dictation, before + 12);
    await app.setVoice(owner(app), { engine: "android", language: "auto" });
});

test("voice is the owner's: another person cannot call on the owner's sign-in", async () => {
    const id = await newSession(app);
    const guest: User = { id: "guest-2", name: "Gus", role: "guest" } as User;

    await assert.rejects(app.startVoiceCall(guest, id as ConversationId), /only the owner can call/);
});
