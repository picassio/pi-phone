// The phone's assistant sheet in a real browser (PP-146, web/assist.js), with a stand-in for the Android sheet's bridge
// (`PiAssistantSession.java`'s `PiPhoneApp`): it listens at once; the words show as heard; with "I tap Send" they wait
// in the box and go to the last session with "(From Chrome · …)", and its transcript takes the sheet; with "Send by
// itself" they go 3 seconds after the person stops, to a new session, without the app once its chip is dropped; no
// microphone sends the person to pi-phone; nothing heard says so; × closes the sheet. With PHONE_SHOTS set to a
// folder, screenshots at 390 px go there.
import { type App, cleanUp, lastText, modelTexts, newSession, openApp, owner, say, scriptedModel, until, work } from "./helpers.ts";
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

    return fauxAssistantMessage([fauxText(`heard: ${text}`)]);
};
let app: App;
let server: Server;
let base = "";
let engine: ChromeEngine;
let cdp: Cdp;

/** Run in the page and answer its JSON. */
async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

const pageErrors: string[] = [];

/** `until`, and on a timeout what the page threw, what the sheet shows, and the store's session. */
async function seen(check: () => Promise<boolean>, what: string): Promise<void> {
    try {
        await until(check, what, 15_000);
    } catch (error) {
        const state = await inPage<string>(
            `import("/store.js").then(({ store }) => JSON.stringify({ conversationId: store.state.conversationId, view: Boolean(store.state.view.conversation), connection: store.state.connection, path: location.pathname }))`,
        ).catch((failure: unknown) => String(failure));

        throw new Error(`${(error as Error).message}\nstore: ${state}\nsheet: ${await text(".assist").catch(() => "")}\npage errors: ${pageErrors.join("\n")}`);
    }
}

const text = (selector: string) => inPage<string>(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ""`);
/** What the Android recognizer would say (`Dictation.java`'s events). */
const hear = (event: Record<string, unknown>) => inPage(`window.__piPhoneSpeech(${JSON.stringify(event)})`);
const click = (selector: string) => inPage(`document.querySelector(${JSON.stringify(selector)}).click()`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 80 });

    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from(data, "base64"));
}

/** The sheet, as the Android sheet loads it, with the bridge standing in; `mic: false`: the microphone not allowed. */
async function openSheet({ mic = true, last }: { mic?: boolean; last?: number } = {}): Promise<void> {
    await inPage(`(() => {
        localStorage.setItem("pi-phone.last-session", ${JSON.stringify(last === undefined ? "" : String(last))});
        sessionStorage.setItem("assist-test-mic", ${JSON.stringify(String(mic))});
    })()`);
    await cdp.send("Page.navigate", { url: `${base}/?assist=1` });
    await until(async () => (await inPage<boolean>(`document.querySelector(".assist-sheet") !== null`).catch(() => false)), "the sheet", 20_000);
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    // What the page throws or logs as an error, said with a failure.
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.exceptionThrown", (params) => pageErrors.push(JSON.stringify((params as { exceptionDetails?: unknown }).exceptionDetails).slice(0, 600)));
    cdp.on("Runtime.consoleAPICalled", (params) => {
        const call = params as { type?: string; args?: { value?: unknown; description?: string }[] };

        if (call.type === "error") {
            pageErrors.push((call.args ?? []).map((each) => String(each.value ?? each.description ?? "")).join(" ").slice(0, 600));
        }
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    // The Android sheet's bridge: dictation on "Android's recognizer" (the test says what it hears), the app in front,
    // close, open, and allow the microphone in the app. Recorded for the test to read.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `
            window.__bridge = { started: [], stopped: 0, closed: 0, opened: [], allowMic: 0 };
            window.PiPhoneApp = {
                dictationAvailable: () => true,
                micAllowed: () => sessionStorage.getItem("assist-test-mic") !== "false",
                startDictation: (language) => { window.__bridge.started.push(language); setTimeout(() => window.__piPhoneSpeech({ type: "start" })); },
                stopDictation: () => { window.__bridge.stopped++; },
                abortDictation: () => {},
                from: () => JSON.stringify({ label: "Chrome", package: "com.android.chrome" }),
                close: () => { window.__bridge.closed++; },
                open: (id) => { window.__bridge.opened.push(id); },
                allowMic: () => { window.__bridge.allowMic++; },
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
    cleanUp();
});

test("I tap Send: it listens at once, shows the words as heard, and sends them to the last session with the app in front", real, async () => {
    const id = await newSession(app);

    await app.setAssistant(owner(app), { opens: "last", send: "tap" });
    await openSheet({ last: id });
    await until(async () => (await inPage<string[]>(`window.__bridge.started`)).length === 1, "listening at once");
    await until(async () => (await text("[data-part=assist-target]")).includes("last"), "the last session on the pill");
    assert.match(await text(".assist-from"), /From Chrome/);

    // Words as they come: the ones still changing are faint.
    await hear({ type: "partial", text: "what's the cheapest" });
    await until(async () => (await text(".assist-words")).includes("what's the cheapest"), "the words so far");
    assert.equal(await text(".assist-coming"), "what's the cheapest");
    await shot("assist-listening-390");

    // Stop: Android settles the words, and they wait in the box.
    await click(".assist-big");
    await hear({ type: "final", text: "what's the cheapest morning flight here" });
    await hear({ type: "end" });
    await until(async () => (await inPage<string>(`document.querySelector(".assist-box textarea")?.value ?? ""`)) === "What's the cheapest morning flight here", "the words in the box");
    assert.equal(await inPage<boolean>(`document.querySelector(".assist-countdown") === null`), true, "nothing goes by itself");
    await shot("assist-heard-390");

    await click(".assist-send");
    await until(async () => (await modelTexts(app, id)).some((each) => each.includes("heard: (From Chrome · com.android.chrome)") && each.includes("What's the cheapest morning flight here")), "the message in the session, with the app");
    // The session's transcript takes the sheet.
    // (The transcript's Markdown may curl the apostrophe.)
    await seen(async () => (await text(".assist-sheet .transcript")).includes("the cheapest morning flight here"), "the transcript in the sheet");
    await seen(async () => (await text("[data-part=assist-more]")).includes("Ask more"), "Ask more");
    assert.equal(await inPage<string>("location.pathname + location.search"), "/?assist=1", "the sheet's address kept");
    await shot("assist-sent-390");

    // Open goes to the session in the app; × closes the sheet.
    await click(".assist-head .icon-button");
    assert.deepEqual(await inPage<number[]>(`window.__bridge.opened`), [id]);
    await click(".assist-head .icon-button:last-of-type");
    assert.equal(await inPage<number>(`window.__bridge.closed`), 1);
});

test("Send by itself: 3 seconds after the person stops, to a new session, without the app once its chip is dropped", real, async () => {
    await app.setAssistant(owner(app), { opens: "new", folder: work, send: "auto" });
    await openSheet();
    await until(async () => (await text("[data-part=assist-target]")).includes("New session"), "a new session on the pill");

    // The chip dropped: the app is not said.
    await click(".assist-from button");
    await until(async () => inPage<boolean>(`document.querySelector(".assist-from").classList.contains("off")`), "the chip off");

    await hear({ type: "final", text: "remind me to call mum at six" });
    await hear({ type: "end" });
    const ended = Date.now();

    await until(async () => (await text(".assist-countdown")).includes("Sending in"), "the countdown");
    await until(async () => (await inPage<string>(`localStorage.getItem("pi-phone.last-session") ?? ""`)) !== "", "a new session", 10_000);
    assert.ok(Date.now() - ended >= 2500, `sent after ${Date.now() - ended} ms`);

    const made = Number(await inPage<string>(`localStorage.getItem("pi-phone.last-session")`));

    await until(async () => (await modelTexts(app, made as never)).some((each) => each.includes("heard: Remind me to call mum at six")), "the message in the new session");
    assert.ok(!(await modelTexts(app, made as never)).some((each) => each.includes("From Chrome")), "the app is not said");
});

test("tapping the words stops the countdown; nothing heard says so; no microphone sends the person to pi-phone", real, async () => {
    await app.setAssistant(owner(app), { opens: "last", send: "auto" });
    const id = await newSession(app);

    await openSheet({ last: id });
    await hear({ type: "final", text: "book a table" });
    await hear({ type: "end" });
    await until(async () => (await text(".assist-countdown")).includes("Sending in"), "the countdown");
    // The person's tap on the words, as its focus event (a headless page may not hold the focus).
    await inPage(`document.querySelector(".assist-box textarea").dispatchEvent(new FocusEvent("focus"))`);
    await until(async () => inPage<boolean>(`document.querySelector(".assist-countdown") === null`), "the countdown stopped");
    await new Promise((resolve) => setTimeout(resolve, 3500));
    assert.ok(!(await modelTexts(app, id)).some((each) => each.includes("Book a table")), "nothing was sent");

    // Nothing heard.
    await click(".assist-row .button");
    await hear({ type: "error", error: "no-speech" });
    await hear({ type: "end" });
    await until(async () => (await text(".assist-notice")).includes("Didn't catch that"), "said so");
    await shot("assist-nospeech-390");

    // The microphone not allowed: the sheet cannot ask; pi-phone can.
    await openSheet({ last: id, mic: false });
    await until(async () => (await text(".assist-notice")).includes("pi can't use the microphone yet"), "no microphone");
    assert.equal((await inPage<string[]>(`window.__bridge.started`)).length, 0, "it did not try to listen");
    await shot("assist-nomic-390");
    await inPage(`[...document.querySelectorAll(".assist-foot .button")].find((each) => each.innerText.includes("Allow in pi-phone")).click()`);
    assert.equal(await inPage<number>(`window.__bridge.allowMic`), 1);
});

test("the pill's picker finds any session by its search; the chosen session's history shows while it listens", real, async () => {
    await app.setAssistant(owner(app), { opens: "last", send: "tap" });
    const first = await newSession(app);
    const other = await newSession(app);

    await say(app, other, "an earlier note about the flights");
    await openSheet({ last: first });
    await until(async () => (await text("[data-part=assist-target]")).includes("last"), "the last session on the pill");
    await click("[data-part=assist-target]");
    await until(async () => inPage<boolean>(`document.querySelector(".assist-search") !== null`), "the picker");
    await inPage(`(() => { const input = document.querySelector(".assist-search"); input.value = "#${other}"; input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
    await until(async () => (await text("[data-part=assist-menu]")).includes(`#${other} ·`), "the session found");
    await shot("assist-picker-390");
    await inPage(`[...document.querySelectorAll("[data-part=assist-session]")].find((each) => each.innerText.includes("#${other} ·")).click()`);
    await until(async () => (await text("[data-part=assist-target]")).includes(`#${other}`), "the session on the pill");

    // Its history, before anything is sent; what is heard shows under it.
    await seen(async () => (await text(".assist-sheet .transcript")).includes("an earlier note about the flights"), "the session's history");
    await hear({ type: "partial", text: "and the hotels" });
    await until(async () => (await text(".assist-foot .assist-words")).includes("and the hotels"), "the words under the history");
    await shot("assist-history-390");
});

test("Menu › Assistant: the choices change the server's settings", real, async () => {
    await app.setAssistant(owner(app), { opens: "last", send: "tap", from: true });
    await cdp.send("Page.navigate", { url: `${base}/?sheet=assistant` });
    await until(async () => (await text(".assistant-sheet")).includes("Hold the side key"), "the sheet", 20_000);
    await inPage(`[...document.querySelectorAll("[data-part=assistant-send] button")].find((each) => each.innerText.includes("Send by itself")).click()`);
    await until(() => app.config.assistant.send === "auto", "send: auto");
    await inPage(`document.querySelector("[data-part=assistant-from] [role=switch]").click()`);
    await until(() => app.config.assistant.from === false, "from: off");
    await shot("assistant-sheet-390");
});
