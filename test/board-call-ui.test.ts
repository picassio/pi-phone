// A voice call from the floating bubble (PP-290; web/board.js, ProgressBubble.java) in a real browser against a fake
// OpenAI, with stand-ins for the bubble's bridge (`PiBoard`), WebRTC and the microphone: a double tap opens the board as
// a call's pill and calls the session Menu › Assistant names, the bubble's service told first; the pill fits its window,
// mutes, hides its captions and ends back to the bubble. On the board, the call line calls another target for this
// call, the call shows as a bar that folds to the pill; without the phone's digital assistant role it says so, with
// Android's Default apps a tap away. With PHONE_SHOTS, screenshots go there.
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

test("a double tap: the board as a call's pill, calling Menu › Assistant's session; it fits its window, mutes, and ends back to the bubble", real, async () => {
    const id = await newSession(app);

    await app.setAssistant(owner(app), { opens: "last" });
    await inPage(`localStorage.setItem("pi-phone.last-session", "${id}")`);
    await openBoard(true);
    await until(() => app.voice.calls().some((call) => call.session === id && call.rtc !== undefined), "a call in the last session", 20_000);
    await until(async () => exists(".pgb-call.pill [data-part=board-call-end]"), "the pill");
    assert.equal(await exists("[data-part=progress-board]"), false, "the pill alone, not the board");

    const heard = await bridge();

    assert.deepEqual(heard.starting.map(([session]) => session), [id], "the bubble's service first");
    assert.deepEqual((await told()).map((each) => [each.state, each.session]), [["start", id]]);
    assert.ok(heard.pills.length > 0 && heard.pills.at(-1)! > 30 && heard.pills.at(-1)! < 200, `the window fits the pill: ${String(heard.pills.at(-1))}`);
    await shot("board-call-pill-390");

    // Mute, and back.
    await inPage(`document.querySelector("[data-part=board-call-mute]").click()`);
    await until(async () => (await inPage<boolean>(`(async () => (await import("/store.js")).store.state.voiceCall?.muted === true)()`)), "muted");
    await inPage(`document.querySelector("[data-part=board-call-mute]").click()`);
    await until(async () => (await inPage<boolean>(`(async () => (await import("/store.js")).store.state.voiceCall?.muted === false)()`)), "unmuted");

    // A tap on it opens the board, with the call as a bar; folding makes it the pill again.
    await inPage(`document.querySelector(".pgb-calltext").click()`);
    await until(async () => exists("[data-part=progress-board] .pgb-call.bar"), "the board with the call's bar");
    assert.equal(await exists("[data-part=board-call-row]"), false, "no call line during a call");
    await shot("board-call-bar-390");
    await inPage(`globalThis.__piBoardFold()`);
    await until(async () => exists(".pgb-call.pill"), "the pill again");

    // End: the call goes, the bubble hears of it, and the pill folds back to the bubble.
    const folds = (await bridge()).folds;

    await inPage(`document.querySelector("[data-part=board-call-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");
    await until(async () => (await bridge()).folds > folds, "back to the bubble");
    assert.equal((await told()).at(-1)!.state, "end");
});

test("the board's call line: Menu › Assistant's target, another for this call; not the phone's assistant: it says so", real, async () => {
    const before = app.sessions().length;

    await app.setAssistant(owner(app), { opens: "last" });
    await openBoard(false);
    await until(async () => exists("[data-part=board-call-row] .choice"), "the call line", 20_000);
    await shot("board-call-row-390");

    // A new session for this call.
    await inPage(`document.querySelector("[data-part=board-call-row] .choice").click()`);
    await until(async () => exists(".choice-menu [role=option]"), "the targets");
    await inPage(`[...document.querySelectorAll(".choice-menu [role=option]")].find((each) => each.innerText.includes("A new session")).click()`);
    await inPage(`document.querySelector("[data-part=board-call]").click()`);
    await until(() => app.sessions().length === before + 1, "a new session");
    await until(() => app.voice.calls().length === 1, "a call", 15_000);
    assert.equal(app.voice.calls()[0]!.session, Math.max(...app.sessions().map((each) => each.id)), JSON.stringify({ calls: app.voice.calls().map((each) => each.session), ids: app.sessions().map((each) => each.id), starting: (await bridge()).starting }));
    await until(async () => exists("[data-part=progress-board] .pgb-call.bar"), "the call's bar on the board");
    await inPage(`document.querySelector("[data-part=board-call-end]").click()`);
    await until(() => app.voice.calls().length === 0, "ended");
    await until(async () => exists("[data-part=board-call-row]"), "the call line again, the board kept");

    // Not the phone's digital assistant: it says so, with Android's Default apps a tap away.
    await openBoard(false, false);
    await until(async () => exists("[data-part=board-call]"), "the call line", 20_000);
    await inPage(`document.querySelector("[data-part=board-call]").click()`);
    await until(async () => exists("[data-part=board-call-problem]"), "the problem");
    assert.match(await inPage<string>(`document.querySelector("[data-part=board-call-problem]").innerText`), /digital assistant/);
    assert.equal(app.voice.calls().length, 0);
    await inPage(`document.querySelector("[data-part=board-call-problem] button").click()`);
    assert.equal((await bridge()).settings, 1);
    await shot("board-call-problem-390");
});
