// The voice view in a real browser (PP-188, PP-189; web/voice-call.js, web/voice-view.js) against a fake OpenAI, with
// stand-ins for WebRTC and the microphone (a headless browser has neither a peer nor a mic to call with): the message
// box's voice button starts a call, the page posts its offer with the short-lived key and names the call, the server
// joins it; the view is full screen on a phone and a panel at the right on a wide screen; the words heard and spoken,
// mute, hold to talk and End work; the session's voice mode is in the model menu; voice turns are marked in the
// transcript; the sign-in's token never reaches the page. With PHONE_SHOTS set to a folder, screenshots go there.
import { type App, cleanUp, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { createHandler } from "../src/server/http.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";
import { projectEntry } from "../src/server/projection.ts";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    return fauxAssistantMessage([fauxText(text.includes("[voice] check the deploy") ? "The deploy finished at 14:02." : `heard: ${text}`)]);
};
let app: App;
let server: Server;
let openai: FakeOpenAI;
let base = "";
let engine: ChromeEngine;
let cdp: Cdp;

async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

const text = (selector: string) => inPage<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
const click = (selector: string) => inPage(`document.querySelector(${JSON.stringify(selector)}).click()`);
const exists = (selector: string) => inPage<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`);
/** An event on the call's data channel, as OpenAI sends it to the page. */
const channel = (event: Record<string, unknown>) => inPage(`window.__voice.channel.onmessage({ data: ${JSON.stringify(JSON.stringify(event))} })`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

async function width(px: number): Promise<void> {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: px, height: px < 600 ? 844 : 800, deviceScaleFactor: 1, mobile: px < 600 });
}

const pageErrors: string[] = [];

/** A session's entries as tabs get them. */
async function entries(id: ConversationId): Promise<unknown[]> {
    const view = await (await app.conversation(id)).viewState(BACKGROUND_CONTEXT);

    try {
        return view.value.entries.map((entry) => projectEntry(entry)).filter((entry) => entry !== undefined);
    } finally {
        view.dispose();
    }
}

/** `until`, and on a timeout what the page said (its notices) and threw. */
async function seen(check: () => Promise<boolean> | boolean, what: string, ms = 10_000): Promise<void> {
    try {
        await until(check, what, ms);
    } catch (error) {
        const notices = await inPage<string>(`import("/store.js").then(({ store }) => JSON.stringify(store.state.notices.map((each) => each.message ?? each.text ?? each)))`).catch((failure: unknown) => String(failure));

        const call = await inPage<string>(`JSON.stringify({ offers: window.__voice.offers, sent: window.__voice.sent, remote: Boolean(window.__voice.pc?.remoteDescription), fetches: window.__voice.fetches.slice(-4) })`).catch((failure: unknown) => String(failure));

        throw new Error(`${(error as Error).message}\nnotices: ${notices}\ncall: ${call}\nerrors: ${pageErrors.join("\n")}`);
    }
}

async function open(id: number): Promise<void> {
    await cdp.send("Page.navigate", { url: `${base}/s/${id}` });

    try {
        await until(async () => (await exists("[data-part~=voice-button]").catch(() => false)), "the voice button", 20_000);
    } catch (error) {
        const state = await inPage<string>(
            `import("/store.js").then(({ store }) => JSON.stringify({ me: store.state.me?.role, voice: store.state.server?.voice !== undefined, rtc: typeof RTCPeerConnection, media: typeof navigator.mediaDevices?.getUserMedia, secure: isSecureContext, composer: document.querySelector("[data-part=composer]") !== null }))`,
        ).catch((failure: unknown) => String(failure));

        throw new Error(`${(error as Error).message}\npage: ${state}\nerrors: ${pageErrors.join("\n")}`);
    }
}

before(async () => {
    if (real.skip) {
        return;
    }

    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(route), join(root, "voice-ui"), undefined, {
        voice: { endpoints: openai.endpoints, auth: async () => ({ token: TOKEN }) },
    });
    await app.voice.check();
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => pageErrors.push(JSON.stringify((params as { exceptionDetails?: unknown }).exceptionDetails).slice(0, 600)));
    await width(390);
    // WebRTC and the microphone, stood in: what the page sends on the data channel and how its track is set are kept.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.__voice = { sent: [], tracks: [], offers: 0, closed: 0, responses: [] };
            const track = { enabled: true, stop() {}, kind: "audio" };
            window.__voice.track = track;
            navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] });
            window.RTCPeerConnection = class {
                constructor() { this.connectionState = "new"; window.__voice.pc = this; }
                addTrack(t) { window.__voice.tracks.push(t); }
                createDataChannel() { const c = { readyState: "open", send: (data) => window.__voice.sent.push(JSON.parse(data)), close() {} }; window.__voice.channel = c; return c; }
                async createOffer() { window.__voice.offers++; return { type: "offer", sdp: "v=0\\r\\no=- page offer\\r\\n" }; }
                async setLocalDescription(d) { this.localDescription = d; }
                async setRemoteDescription(d) { this.remoteDescription = d; this.connectionState = "connected"; }
                close() { window.__voice.closed++; }
            };
            window.AudioContext = undefined;
            // The browser's speech synthesis (the device's voice for Pi thinks): what it reads is kept.
            window.__voice.read = [];
            window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; this.lang = ""; } };
            Object.defineProperty(window, "speechSynthesis", { value: { speak: (utterance) => { window.__voice.read.push(utterance.text); setTimeout(() => utterance.onend && utterance.onend(), 50); }, cancel() {} }, configurable: true });
            // Every answer the app's API gives the page, to check the token is in none.
            const realFetch = window.fetch;
            window.__voice.fetches = [];
            window.fetch = async (input, init) => {
                const record = { url: String(input).slice(0, 80) };
                window.__voice.fetches.push(record);
                try {
                    const response = await realFetch(input, init);
                    record.status = response.status;
                    if (String(input).startsWith("api/") || String(input).includes("/api/")) {
                        response.clone().text().then((body) => window.__voice.responses.push(body));
                    }
                    return response;
                } catch (error) {
                    record.error = String(error);
                    throw error;
                }
            };
        `,
    });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await inPage<string>("location.pathname").catch(() => "")) === "/", "signed in", 20_000);
});

after(async () => {
    cdp?.close();
    await engine?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    await openai?.close();
    cleanUp();
});

test("on a phone: the voice button starts a call by key, full screen; words, mute, hold to talk and End work; the token never reaches the page", real, async () => {
    const id = await newSession(app);

    await width(390);
    await open(id);
    await click("[data-part~=voice-button]");
    await seen(async () => exists("[data-part=voice-panel]"), "the voice view");
    await seen(() => app.voice.calls().some((call) => call.rtc !== undefined), "the call named");

    const call = app.voice.calls()[0]!;
    const posted = [...openai.calls.values()].at(-1)!;

    assert.match(posted.by, /^ek_test_/, "the page posted its own offer with the key");
    assert.equal(posted.offer, "v=0\r\no=- page offer\r\n");
    await until(() => openai.sidebands.has(call.rtc!), "the server joined");
    assert.equal(await inPage<string>(`document.querySelector("[data-part=voice-panel]").getAttribute("role")`), "dialog", "full screen over the chat");
    await until(async () => (await text("[data-part=voice-status]")).includes("Listening"), "listening");

    // What is heard, then what the voice says.
    await channel({ type: "input_audio_buffer.speech_started" });
    await channel({ type: "conversation.item.input_audio_transcription.delta", delta: "check the " });
    await channel({ type: "conversation.item.input_audio_transcription.delta", delta: "deploy" });
    await until(async () => (await text("[data-part=voice-words]")).includes("check the deploy"), "your words");
    await shot("voice-listening-390");
    await channel({ type: "response.created" });
    await channel({ type: "response.output_audio_transcript.delta", delta: "On it." });
    await until(async () => (await text("[data-part=voice-status]")).includes("Speaking"), "speaking");
    await until(async () => (await text("[data-part=voice-words]")).includes("On it."), "the voice's words");
    await shot("voice-speaking-390");
    await channel({ type: "response.done" });

    // Mute (PP-201): a wide button in words; the call stays, the mic sends nothing, the server knows.
    assert.match(await text("[data-part=voice-mute]"), /Mute/);
    await click("[data-part=voice-mute]");
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), false);
    await until(async () => (await text("[data-part=voice-status]")).includes("Muted"), "muted");
    assert.match(await text("[data-part=voice-mute]"), /Mic off/);
    assert.equal(await inPage<string>(`document.querySelector("[data-part=voice-mute]").dataset.mic`), "off");
    assert.ok(await inPage<number>(`document.querySelector("[data-part=voice-mute]").getBoundingClientRect().width`) > 300, "as wide as the view");
    await until(() => app.voice.calls()[0]?.muted === true && app.voice.calls()[0]?.micBy === "you", "the server knows");
    await shot("voice-muted-390");
    await click("[data-part=voice-mute]");
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), true);
    await until(() => app.voice.calls()[0]?.muted === false, "the server knows it is on");

    // Tap to talk (PP-201): closed until a tap; the turn's end closes it again.
    await inPage(`[...document.querySelectorAll(".voice-turns button")].find((each) => each.innerText.includes("Tap to talk")).click()`);
    await until(async () => (await text("[data-part=voice-mute]")).includes("Tap to talk"), "tap to talk");
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), false);
    await until(() => app.voice.calls()[0]?.turns === "tap", "the server knows the turns");
    await shot("voice-tap-390");
    await click("[data-part=voice-mute]");
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), true);
    await until(async () => (await text("[data-part=voice-mute]")).includes("Listening"), "listening for the turn");
    await channel({ type: "input_audio_buffer.speech_started" });
    await channel({ type: "input_audio_buffer.speech_stopped" });
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), false, "closed after the turn");
    await until(async () => (await text("[data-part=voice-status]")).includes("tap to talk"), "waiting for the tap");

    // Hold to talk: no turn detection; pressing clears, letting go commits and asks for an answer.
    await inPage(`[...document.querySelectorAll(".voice-turns button")].find((each) => each.innerText.includes("Hold to talk")).click()`);
    await until(async () => exists("[data-part=voice-hold]"), "the hold button");
    assert.deepEqual(await inPage<unknown>(`window.__voice.sent.findLast((each) => each.type === "session.update")?.session.audio.input.turn_detection`), null);
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), false, "silent until held");
    await shot("voice-hold-390");
    await inPage(`document.querySelector("[data-part=voice-hold]").dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }))`);
    assert.equal(await inPage<boolean>("window.__voice.track.enabled"), true);
    await inPage(`document.querySelector("[data-part=voice-hold]").dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))`);
    assert.deepEqual(
        await inPage<string[]>(`window.__voice.sent.map((each) => each.type).slice(-4)`),
        ["response.cancel", "input_audio_buffer.clear", "input_audio_buffer.commit", "response.create"],
    );

    // End: the call ends on the server; its minutes count.
    await click("[data-part=voice-end]");
    await until(() => app.voice.calls().length === 0, "the call ended");
    await until(async () => !(await exists("[data-part=voice-panel]")), "the view closed");
    assert.ok(!(await inPage<string[]>("window.__voice.responses")).some((body) => body.includes(TOKEN)), "the token never reached the page");
});

test("Pi thinks with the device's voice: what you say goes to Pi, and Pi's answer is read out by the device, not the live model", real, async () => {
    const id = await newSession(app);

    await app.setSessionVoiceMode(id, owner(app), "think");
    await app.setVoice(owner(app), { reader: "device" });
    await width(390);
    await open(id);
    await click("[data-part~=voice-button]");
    await seen(() => app.voice.calls().some((call) => call.rtc !== undefined), "the call named");

    const rtc = app.voice.calls()[0]!.rtc!;

    await until(() => openai.sidebands.has(rtc), "joined");
    openai.push(rtc, { type: "conversation.item.input_audio_transcription.completed", transcript: "what time is it" });
    await until(async () => (await inPage<string[]>("window.__voice.read")).some((each) => each.includes("heard: [voice] what time is it")), "read out by the device");
    assert.ok(
        !openai.sidebands.get(rtc)!.received.some((event) => event.type === "conversation.item.create" || event.type === "response.create"),
        "the live model reads nothing",
    );
    await click("[data-part=voice-end]");
    await until(() => app.voice.calls().length === 0, "ended");
    await app.setVoice(owner(app), { reader: "live" });
    await app.setSessionVoiceMode(id, owner(app), "inherit");
});

test("on a wide screen the call is a panel at the right; the session's voice mode is in the model menu; voice turns are marked", real, async () => {
    const id = await newSession(app);

    await width(1280);
    await open(id);

    // The voice mode in the model chip's menu: this session's own.
    await click("[data-part=model-chip]");
    await until(async () => exists("[data-part=voice-mode-row]"), "the voice row");
    await inPage(`[...document.querySelectorAll("[data-part=voice-mode-row] button")].find((each) => each.innerText.includes("Chat only")).click()`);
    await until(() => app.voiceModeOf(id) === "chat", "chat only");
    await shot("voice-mode-1280");
    await inPage(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
    await app.setSessionVoiceMode(id, owner(app), "work");

    await click("[data-part~=voice-button]");
    await until(async () => exists("[data-part=voice-panel]"), "the panel");
    await seen(() => app.voice.calls().some((call) => call.rtc !== undefined), "named");
    assert.equal(await inPage<string | null>(`document.querySelector("[data-part=voice-panel]").getAttribute("role")`), null, "beside the chat");
    assert.ok(await exists("[data-part=composer]"), "the chat stays");

    // A spoken request reaches Pi, marked voice; the ack is a voice row.
    const rtc = app.voice.calls()[0]!.rtc!;

    await until(() => openai.sidebands.has(rtc), "joined");
    openai.push(rtc, { type: "response.created" });
    openai.push(rtc, { type: "response.function_call_arguments.done", name: "ask_pi", call_id: "fc-1", arguments: JSON.stringify({ request: "check the deploy" }) });
    openai.push(rtc, { type: "response.done" });
    await until(() => openai.sidebands.get(rtc)!.received.some((event) => JSON.stringify(event).includes("function_call_output")), "the tool's answer");
    openai.push(rtc, { type: "response.created" });
    openai.push(rtc, { type: "response.output_audio_transcript.done", transcript: "On it, asking Pi." });
    openai.push(rtc, { type: "response.done" });
    await until(async () => (await modelTexts(app, id)).some((each) => each.includes("The deploy finished")), "Pi answered");
    await until(async () => (await text("[data-part=voice-mark]")).includes("voice"), "the message marked voice", 10_000);
    await until(async () => JSON.stringify(await entries(id)).includes("On it, asking Pi."), "the voice row kept", 10_000);
    await seen(async () => (await text(".transcript [data-part=voice-entry]")).includes("On it, asking Pi."), "the voice row shown");
    await until(async () => (await text("[data-part=voice-recent]")).includes("The deploy finished"), "Pi's words in the panel");
    await shot("voice-panel-1280");
    await click("[data-part=voice-end]");
    await until(() => app.voice.calls().length === 0, "ended");
});
