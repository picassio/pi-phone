// Settings › Voice, Codex dictation and voice minutes in Spend in a real browser (PP-190; web/sheets/voice.js,
// web/codex-dictation.js, web/sheets/spend.js) against a fake OpenAI, with WebRTC and the microphone stood in: the live
// models the check found with the way each is set up; a choice there changes the server's settings (checked live);
// Check again asks OpenAI again; Settings › Dictation's engine; the message box's mic with Codex writes what the
// transcription session hears into the box; minutes show in Spend. With PHONE_SHOTS set to a folder, screenshots go there.
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
let clock = Date.now();

async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

const text = (selector: string) => inPage<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
const press = (selector: string, label: string) =>
    inPage(`[...document.querySelectorAll(${JSON.stringify(`${selector} button`)})].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click()`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

async function sheet(type: string): Promise<void> {
    await cdp.send("Page.navigate", { url: `${base}/?sheet=${type}` });
    await until(async () => (await inPage<boolean>(`document.querySelector(".sheet") !== null`).catch(() => false)), `the ${type} sheet`, 20_000);
}

before(async () => {
    if (real.skip) {
        return;
    }

    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(), join(root, "voice-settings-ui"), () => clock, {
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
            window.__voice = { sent: [] };
            const track = { enabled: true, stop() { window.__voice.stopped = true; }, kind: "audio" };
            navigator.mediaDevices.getUserMedia = async () => ({ getTracks: () => [track], getAudioTracks: () => [track] });
            window.RTCPeerConnection = class {
                addTrack() {}
                createDataChannel() { const c = { readyState: "open", send: (data) => window.__voice.sent.push(JSON.parse(data)), close() {} }; window.__voice.channel = c; return c; }
                async createOffer() { return { type: "offer", sdp: "v=0\\r\\no=- dictation offer\\r\\n" }; }
                async setLocalDescription(d) { this.localDescription = d; }
                async setRemoteDescription(d) { this.remoteDescription = d; window.__voice.connected = true; }
                close() {}
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

test("Settings › Voice: the checked live models with their way, choices that change the server's settings, and Check again", real, async () => {
    await sheet("voice");
    await until(async () => (await text("[data-part=voice-models]")).includes("gpt-live-1.1-codex"), "the live models");

    const models = await text("[data-part=voice-models]");

    assert.match(models, /gpt-realtime-2\s+short-lived key/);
    assert.match(models, /gpt-realtime-1\.5\s+through pi-phone/);
    assert.match(models, /gpt-live-1\.1-codex\s+Codex's own · private/);
    assert.match(await text("[data-part=voice-check]"), /Not for this sign-in: gpt-realtime/);
    await shot("voice-settings-390");

    await inPage(`[...document.querySelectorAll("[data-part=voice-model]")].find((each) => each.innerText.includes("gpt-realtime-mini")).click()`);
    await until(() => app.config.voice.model === "gpt-realtime-mini", "the live model");
    await press("[data-part=voice-mode-default]", "Chat only");
    await until(() => app.config.voice.mode === "chat", "the mode for new sessions");
    await press("[data-part=voice-turns-default]", "Hold to talk");
    await until(() => app.config.voice.turns === "hold", "turn-taking");
    await press("[data-part=voice-progress]", "Only the answer");
    await until(() => app.config.voice.progress === "answer", "progress");
    // Hearing in noise (PP-195): the mic's noise reduction, and how soon hands-free takes your turn as ended.
    await press("[data-part=voice-noise]", "Speaker or table");
    await until(() => app.config.voice.noise === "far_field", "far-field noise reduction");
    await press("[data-part=voice-eagerness]", "Waits longer");
    await until(() => app.config.voice.eagerness === "low", "low eagerness");
    await shot("voice-hearing-390");
    await app.setVoice(owner(app), { noise: "near_field", eagerness: "auto" });

    // Turn detection by loudness (PP-201): how loud you must be, and the pause before it answers.
    await press("[data-part=voice-vad]", "By loudness");
    await until(() => app.config.voice.vad === "server", "by loudness");
    await until(async () => inPage<boolean>(`document.querySelector("[data-part=voice-vad-threshold]") !== null`), "the loudness slider");
    assert.equal(await inPage<boolean>(`document.querySelector("[data-part=voice-eagerness]") === null`), true, "eagerness is semantic's");
    for (const [part, value] of [["voice-vad-threshold", "0.85"], ["voice-vad-silence", "800"]] as const) {
        await inPage(`(() => { const box = document.querySelector("[data-part=${part}]"); box.value = "${value}"; box.dispatchEvent(new Event("input", { bubbles: true })); box.dispatchEvent(new Event("change", { bubbles: true })); })()`);
    }
    await until(() => app.config.voice.vadThreshold === 0.85 && app.config.voice.vadSilenceMs === 800, "the threshold and the pause");
    await inPage(`document.querySelector("[data-part=voice-vad-threshold]").scrollIntoView({ block: "center" })`);
    await shot("voice-vad-390");
    await app.setVoice(owner(app), { vad: "semantic", vadThreshold: 0.7, vadSilenceMs: 500 });

    // The mic in a call (PP-201): tap to talk for new sessions, the quiet, the mute key, proximity.
    await press("[data-part=voice-turns-default]", "Tap to talk");
    await until(() => app.config.voice.turns === "tap", "tap to talk");
    // Typed, then left (the field keeps what is typed until it changes, as a person's typing does).
    await inPage(`(() => { const box = document.querySelector("[data-part=voice-auto-mute]"); box.value = "10"; box.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await inPage(`document.querySelector("[data-part=voice-auto-mute]").dispatchEvent(new Event("change", { bubbles: true }))`);
    await until(() => app.config.voice.autoMuteSeconds === 10, "mute after 10 quiet seconds");
    await press("[data-part=voice-mute-key]", "Volume keys");
    await until(() => app.config.voice.muteKey === "volume", "the volume keys");
    await inPage(`document.querySelector("[data-part=voice-proximity] [role=switch]").click()`);
    await until(() => app.config.voice.proximityMute, "mute unless at the ear");
    await inPage(`document.querySelector("[data-part=voice-mute-key]").scrollIntoView({ block: "center" })`);
    await shot("voice-mic-settings-390");
    await app.setVoice(owner(app), { autoMuteSeconds: 0, muteKey: "headset", proximityMute: false });

    // Who reads Pi's answers in Pi thinks (PP-193): the device's own voice, which this browser has.
    await press("[data-part=voice-reader]", "This device's voice");
    await until(() => app.config.voice.reader === "device", "the device's voice");
    await until(async () => (await text("[data-part=voice-reader-note]")).includes("reads Pi's words"), "what it does");
    await press("[data-part=voice-reader]", "The live model");
    await until(() => app.config.voice.reader === "live", "the live model again");
    await inPage(`document.querySelector("[data-part=voice-limit] [role=switch]").click()`);
    await until(() => app.config.voice.dailyLimit === 60, "a daily limit");

    const before = openai.requests.length;

    await press("[data-part=voice-check]", "Check again");
    await until(() => openai.requests.length > before, "asked OpenAI again");
    await app.setVoice(owner(app), { model: "gpt-realtime-2", mode: "work", turns: "hands-free", progress: "text", dailyLimit: null });
});

test("Codex dictation: Settings › Dictation picks it; the mic opens a transcription session and writes what it hears into the box; minutes in Spend", real, async () => {
    await sheet("dictation");
    await press("[data-part=dictation-engine]", "Codex");
    await until(() => app.config.voice.engine === "codex", "the Codex engine");
    await shot("voice-dictation-390");

    const id = await newSession(app);

    await cdp.send("Page.navigate", { url: `${base}/s/${id}` });
    await until(async () => (await inPage<boolean>(`document.querySelector(".composer-mic") !== null`).catch(() => false)), "the mic", 20_000);
    await inPage(`document.querySelector(".composer-mic").click()`);
    await until(async () => inPage<boolean>("window.__voice.connected === true"), "the transcription session connected");

    const offer = [...openai.calls.values()].at(-1)!;

    assert.match(offer.by, /^ek_test_/, "the page posted its offer with the dictation key");
    assert.equal([...openai.keys.values()].at(-1)!.type, "transcription");

    const event = (each: Record<string, unknown>) => inPage(`window.__voice.channel.onmessage({ data: ${JSON.stringify(JSON.stringify(each))} })`);

    await event({ type: "conversation.item.input_audio_transcription.delta", item_id: "item-1", delta: "check the " });
    await until(async () => (await inPage<string>(`document.querySelector("[data-part=composer] textarea").value`)).includes("Check the"), "words as they come");
    await event({ type: "conversation.item.input_audio_transcription.completed", item_id: "item-1", transcript: "check the deploy" });
    await until(async () => (await inPage<string>(`document.querySelector("[data-part=composer] textarea").value`)) === "Check the deploy", "settled");

    clock += 30_000;
    await inPage(`document.querySelector(".composer-mic").click()`);
    await until(async () => inPage<boolean>("window.__voice.stopped === true"), "the mic stopped");
    await until(() => app.spend.voiceSummary().today.dictation >= 30, "its seconds counted");
    assert.ok(!(await inPage<string>(`document.documentElement.outerHTML`)).includes(TOKEN));

    await sheet("spend");
    await until(async () => (await text("[data-part=spend-voice]")).includes("Dictation (Codex)"), "voice in Spend");
    assert.match(await text("[data-part=spend-voice]"), /today 1 min/);
    await shot("voice-spend-390");
    await app.setVoice(owner(app), { engine: "android" });
});
