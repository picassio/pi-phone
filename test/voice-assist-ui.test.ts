// Voice from the side key and from home (PP-192; web/assist.js, web/voice-view.js, PiAssistantSession.java) in a real
// browser against a fake OpenAI, with stand-ins for the sheet's bridge, WebRTC and the microphone: the sheet starts a
// call when Menu › Assistant says so, or from its waveform button; the call's controls take its foot and the window hears
// of it (`voiceCall`); when the sheet goes, the call is handed over (ended here, the notification kept), and the app's
// window starts it again in the same session (`/s/:id?voice=start`); without the microphone the sheet sends the person
// to pi-phone; home's Voice makes a session named Voice and calls in it. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { createHandler } from "../src/server/http.ts";
import { FakeOpenAI, TOKEN } from "./support/fake-openai.ts";

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

const exists = (selector: string) => inPage<boolean>(`document.querySelector(${JSON.stringify(selector)}) !== null`).catch(() => false);
const text = (selector: string) => inPage<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
const told = () => inPage<{ state: string; session: number; handOver?: boolean }[]>(`(window.__bridge?.told ?? []).map((each) => JSON.parse(each))`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

/** The sheet, as the Android sheet loads it; `mic: false`: pi has no microphone. */
async function openSheet(last: number, mic = true): Promise<void> {
    await inPage(`(() => { localStorage.setItem("pi-phone.last-session", "${last}"); sessionStorage.setItem("assist-test-mic", "${mic}"); })()`);
    await cdp.send("Page.navigate", { url: `${base}/?assist=1` });
    await until(async () => exists(".assist-sheet"), "the sheet", 20_000);
}

before(async () => {
    if (real.skip) {
        return;
    }

    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(), join(root, "voice-assist-ui"), undefined, {
        voice: { endpoints: openai.endpoints, auth: async () => ({ token: TOKEN }) },
    });
    await app.voice.check();
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            const track = { enabled: true, stop() {}, kind: "audio" };
            navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] });
            window.RTCPeerConnection = class {
                addTrack() {}
                createDataChannel() { return { readyState: "open", send() {}, close() {} }; }
                async createOffer() { return { type: "offer", sdp: "v=0\\r\\no=- offer\\r\\n" }; }
                async setLocalDescription(d) { this.localDescription = d; }
                async setRemoteDescription() {}
                close() {}
            };
            window.AudioContext = undefined;
            if (location.search.includes("assist=1")) {
                window.__bridge = { started: 0, told: [], closed: 0, allowMic: 0 };
                window.PiPhoneApp = {
                    dictationAvailable: () => true,
                    micAllowed: () => { window.__bridge.micAsked = (window.__bridge.micAsked ?? 0) + 1; return sessionStorage.getItem("assist-test-mic") !== "false"; },
                    startDictation: () => { window.__bridge.started++; setTimeout(() => window.__piPhoneSpeech && window.__piPhoneSpeech({ type: "start" })); },
                    stopDictation: () => {},
                    abortDictation: () => {},
                    from: () => "",
                    close: () => { window.__bridge.closed++; },
                    open: () => {},
                    allowMic: () => { window.__bridge.allowMic++; },
                    voiceCall: (json) => window.__bridge.told.push(json),
                };
            }
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

test("the sheet starts a call when it opens; its controls take the foot; it hands the call over when it goes, and the window starts it again", real, async () => {
    const id = await newSession(app);

    await app.setAssistant(owner(app), { opens: "last", talk: "call" });
    await openSheet(id);
    await until(() => app.voice.calls().some((call) => call.session === id && call.rtc !== undefined), "a call in the last session", 15_000);
    await until(async () => exists(".assist-sheet [data-part=voice-status]"), "the call's controls in the sheet");
    assert.equal(await exists("[data-part=assist-stop]"), false, "not dictating");
    assert.deepEqual((await told()).map((each) => [each.state, each.session]), [["start", id]], "the window heard of it");
    await shot("voice-assist-call-390");

    // The sheet goes: the call ends here and is handed over, the notification kept for the window's call.
    await inPage(`globalThis.__piVoiceHandOver()`);
    await until(() => app.voice.calls().length === 0, "the sheet's call ended");
    const last = (await told()).at(-1)!;

    assert.deepEqual([last.state, last.session, last.handOver], ["end", id, true]);

    // The app's window starts it again in the same session.
    await cdp.send("Page.navigate", { url: `${base}/s/${id}?voice=start` });
    await until(() => app.voice.calls().some((call) => call.session === id && call.rtc !== undefined), "the call again, in the app", 15_000);
    await until(async () => exists("[data-part=voice-panel]"), "the voice view");
    assert.equal(await inPage<string>("location.search"), "", "the link's word is gone");
    await inPage(`document.querySelector("[data-part=voice-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");
    await app.setAssistant(owner(app), { talk: "dictate" });
});

test("the sheet's waveform starts a call while it listens; without the microphone it sends the person to pi-phone", real, async () => {
    const id = await newSession(app);

    await openSheet(id);
    await until(async () => (await inPage<number>("window.__bridge.started")) === 1, "listening");

    try {
        await until(async () => exists("[data-part=assist-call]"), "the waveform");
    } catch (error) {
        throw new Error(`${(error as Error).message}\nfoot: ${await text(".assist-sheet")}\nvoice: ${await inPage<string>(`import("/store.js").then(({ store }) => JSON.stringify({ voice: store.state.server?.voice != null, me: store.state.me?.role, rtc: typeof RTCPeerConnection }))`)}`);
    }

    await inPage(`(() => { window.__errors = []; addEventListener("unhandledrejection", (event) => window.__errors.push(String(event.reason?.stack ?? event.reason))); addEventListener("error", (event) => window.__errors.push(String(event.message))); })()`);
    await inPage(`document.querySelector("[data-part=assist-call]").click()`);

    try {
        await until(() => app.voice.calls().some((call) => call.session === id), "a call", 15_000);
    } catch (error) {
        const page = await inPage<string>(`import("/store.js").then(({ store }) => JSON.stringify({ notices: store.state.notices, call: store.state.voiceCall, conversation: store.state.conversationId, sessions: store.state.sessions.length, foot: document.querySelector(".assist-foot")?.innerText, mic: sessionStorage.getItem("assist-test-mic"), errors: window.__errors ?? [], bridge: window.__bridge }))`);

        throw new Error(`${(error as Error).message}\npage: ${page}\ncalls: ${JSON.stringify(app.voice.calls())}`);
    }

    // Ended at once, while it is still being set up: nothing is left on the server.
    await inPage(`document.querySelector("[data-part=voice-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");

    // Without the microphone (the sheet cannot ask for it), a call the sheet opens for says so and sends the person to
    // pi-phone, as dictation does.
    await app.setAssistant(owner(app), { talk: "call" });
    await openSheet(id, false);
    await until(async () => (await text(".assist-notice")).includes("pi can't use the microphone yet"), "no microphone");
    assert.equal(app.voice.calls().length, 0);
    assert.equal(await exists("[data-part=assist-call]"), false, "no call to start without it");
    await app.setAssistant(owner(app), { talk: "dictate" });
});

test("Menu › Assistant: When the sheet opens: Start a voice call", real, async () => {
    await cdp.send("Page.navigate", { url: `${base}/?sheet=assistant` });
    await until(async () => exists("[data-part=assistant-talk]"), "the choice", 20_000);
    await inPage(`[...document.querySelectorAll("[data-part=assistant-talk] button")].find((each) => each.innerText.includes("Start a voice call")).click()`);
    await until(() => app.config.assistant.talk === "call", "talk: call");
    await shot("voice-assistant-sheet-390");
    await app.setAssistant(owner(app), { talk: "dictate" });
});

test("home's Voice makes a session named Voice and calls in it, beside New", real, async () => {
    await cdp.send("Page.navigate", { url: `${base}/` });
    await until(async () => exists(".sessions-head [data-part=voice-new]"), "Voice beside New", 20_000);
    await shot("voice-home-390");
    await inPage(`document.querySelector(".sessions-head [data-part=voice-new]").click()`);
    await until(() => app.voice.calls().length === 1, "a call", 15_000);

    const call = app.voice.calls()[0]!;

    assert.equal(app.sessionMeta(call.session as never)?.title, "Voice");
    assert.equal(call.mode, "work");
    await until(async () => exists("[data-part=voice-panel]"), "the voice view");
    await inPage(`document.querySelector("[data-part=voice-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");

    // The desktop's home has it beside New session too.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await cdp.send("Page.navigate", { url: `${base}/` });
    await until(async () => exists(".splash-actions [data-part=voice-new]"), "Voice on the desktop home", 20_000);
    await shot("voice-home-1280");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
});
