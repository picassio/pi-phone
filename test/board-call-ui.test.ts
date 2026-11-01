// pi-phone's Voice from the floating bubble (PP-290; web/board.js, ProgressBubble.java) in a real browser against a fake
// OpenAI, with stand-ins for the bubble's bridge (`PiBoard`), WebRTC and the microphone: a double tap opens the board in
// Voice, talking to the session Menu › Assistant names, the bubble's service told first; the dash makes it a chip that
// fits its window and mutes; the board shows Voice as a bar; ending the chip goes back to the bubble. The board's Voice
// line talks to another target; ending Voice in the panel goes back to the board; without the phone's digital assistant
// role it says so, with Android's Default apps a tap away. With PHONE_SHOTS, screenshots go there.
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
type Bridge = { starting: [number, string][]; told: string[]; pills: number[]; folds: number; expands: boolean[]; settings: number };
const bridge = () => inPage<Bridge>(`window.__bridge`);
const told = async () => (await bridge()).told.map((each) => JSON.parse(each) as { state: string; session: number });

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, "base64"));
}

/** The board as the bubble loads it; `call`: a double tap's; `assistant`: whether pi is the phone's digital assistant. */
async function openBoard(call: boolean, assistant = true): Promise<void> {
    await inPage(`sessionStorage.setItem("board-test-assistant", "${assistant}")`);
    await cdp.send("Page.navigate", { url: `${base}/?board=1${call ? "&call=1" : ""}` });
}

before(async () => {
    if (real.skip) {
        return;
    }

    openai = await new FakeOpenAI().start();
    app = await openApp(scriptedModel(), join(root, "board-call-ui"), undefined, {
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
            if (location.search.includes("board=1")) {
                window.__bridge = { starting: [], told: [], pills: [], folds: 0, expands: [], settings: 0 };
                window.PiBoard = {
                    open: () => {},
                    openApp: () => {},
                    fold: () => { window.__bridge.folds++; },
                    expand: (on) => { window.__bridge.expands.push(on); },
                    pill: (height) => { window.__bridge.pills.push(height); },
                    micAllowed: () => true,
                    assistantHeld: () => sessionStorage.getItem("board-test-assistant") !== "false",
                    openAssistantSettings: () => { window.__bridge.settings++; },
                    callStarting: (session, title) => { window.__bridge.starting.push([session, title]); },
                    voiceCall: (json) => { window.__bridge.told.push(json); },
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

test("a double tap: the board in Voice, to Menu › Assistant's session; the dash makes it a chip; the board shows it as a bar; ending the chip goes back to the bubble", real, async () => {
    const id = await newSession(app);

    await app.setAssistant(owner(app), { opens: "last" });
    await inPage(`localStorage.setItem("pi-phone.last-session", "${id}")`);
    await openBoard(true);
    await until(() => app.voice.calls().some((call) => call.session === id && call.rtc !== undefined), "Voice in the last session", 20_000);
    await until(async () => exists("[data-part=board-voice] [data-part=voice-status]"), "Voice in the panel, with the app's controls");
    assert.ok(await exists("[data-part=board-voice] [data-part=voice-mode]"), "its voice mode");
    assert.equal(await exists("[data-part=progress-board]"), false, "Voice, not the list");

    const heard = await bridge();

    assert.deepEqual(heard.starting.map(([session]) => session), [id], "the bubble's service first");
    assert.deepEqual((await told()).map((each) => [each.state, each.session]), [["start", id]]);
    await shot("board-voice-390");

    // The dash: a chip that fits its window; its mic mutes and back.
    await inPage(`document.querySelector("[data-part=board-voice-small]").click()`);
    await until(async () => exists(".pgb-call.pill [data-part=board-call-end]"), "the chip");
    await until(async () => ((await bridge()).pills.at(-1) ?? 0) > 30, "the window fits the chip");
    assert.ok((await bridge()).pills.at(-1)! < 120, `a chip's height: ${String((await bridge()).pills.at(-1))}`);
    assert.match(await inPage<string>(`document.querySelector(".pgb-call.pill").innerText`), /Voice/);
    await shot("board-voice-chip-390");
    await inPage(`document.querySelector("[data-part=board-call-mute]").click()`);
    await until(async () => inPage<boolean>(`(async () => (await import("/store.js")).store.state.voiceCall?.muted === true)()`), "muted");
    await inPage(`document.querySelector("[data-part=board-call-mute]").click()`);
    await until(async () => inPage<boolean>(`(async () => (await import("/store.js")).store.state.voiceCall?.muted === false)()`), "unmuted");

    // A tap on the chip opens Voice; pi's mark shows the board, Voice a bar over it that opens Voice again.
    await inPage(`document.querySelector(".pgb-calltext").click()`);
    await until(async () => exists("[data-part=board-voice]"), "Voice again");
    await inPage(`document.querySelector("[data-part=board-voice-board]").click()`);
    await until(async () => exists("[data-part=progress-board] .pgb-call.bar"), "the board with Voice's bar");
    assert.equal(await exists("[data-part=board-call-row]"), false, "no Voice line while Voice runs");
    await shot("board-voice-bar-390");
    await inPage(`document.querySelector(".pgb-call.bar .pgb-calltext").click()`);
    await until(async () => exists("[data-part=board-voice]"), "Voice from the bar");

    // Folding (a tap outside, pi-phone in front) makes it the chip; End there goes back to the bubble.
    await inPage(`globalThis.__piBoardFold()`);
    await until(async () => exists(".pgb-call.pill"), "the chip again");

    const folds = (await bridge()).folds;

    await inPage(`document.querySelector("[data-part=board-call-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");
    await until(async () => (await bridge()).folds > folds, "back to the bubble");
    assert.equal((await told()).at(-1)!.state, "end");
});

test("the board's Voice line: Menu › Assistant's target, another for this time; ending in the panel goes back to the board; not the phone's assistant: it says so", real, async () => {
    const before = app.sessions().length;

    await app.setAssistant(owner(app), { opens: "last" });
    await openBoard(false);
    await until(async () => exists("[data-part=board-call-row] .choice"), "the Voice line", 20_000);
    assert.match(await inPage<string>(`document.querySelector("[data-part=board-call]").innerText`), /Voice/);
    await shot("board-voice-row-390");

    // A new session this time.
    await inPage(`document.querySelector("[data-part=board-call-row] .choice").click()`);
    await until(async () => exists(".choice-menu [role=option]"), "the targets");
    await inPage(`[...document.querySelectorAll(".choice-menu [role=option]")].find((each) => each.innerText.includes("A new session")).click()`);
    await inPage(`document.querySelector("[data-part=board-call]").click()`);
    await until(() => app.sessions().length === before + 1, "a new session");
    await until(() => app.voice.calls().length === 1, "Voice", 15_000);
    assert.equal(app.voice.calls()[0]!.session, Math.max(...app.sessions().map((each) => each.id)));
    await until(async () => exists("[data-part=board-voice] [data-part=voice-end]"), "Voice in the panel");
    await inPage(`document.querySelector("[data-part=board-voice] [data-part=voice-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");
    await until(async () => exists("[data-part=board-call-row]"), "back to the board");

    // Not the phone's digital assistant: it says so, with Android's Default apps a tap away.
    await openBoard(false, false);
    await until(async () => exists("[data-part=board-call]"), "the Voice line", 20_000);
    await inPage(`document.querySelector("[data-part=board-call]").click()`);
    await until(async () => exists("[data-part=board-call-problem]"), "the problem");
    assert.match(await inPage<string>(`document.querySelector("[data-part=board-call-problem]").innerText`), /digital assistant/);
    assert.equal(app.voice.calls().length, 0);
    await inPage(`document.querySelector("[data-part=board-call-problem] button").click()`);
    assert.equal((await bridge()).settings, 1);
    await shot("board-voice-problem-390");
});
