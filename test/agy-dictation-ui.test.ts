// Google Antigravity in the app's sheets and the message box (PP-556, PP-557), in a real browser with Chrome's fake
// microphone: Settings › Dictation offers Antigravity only once it is signed in; with it, the message box's mic records
// 16 kHz pcm16 and posts it to the server, which streams it to Google's dictation (stood in on a local HTTP/2 server)
// and writes what is heard into the box, settled when the mic stops; Menu › Images lists Antigravity's image model on
// its plan; Menu › Audio offers its transcription. With PHONE_SHOTS set to a folder, screenshots go there.
import { type App, cleanUp, cleanUpAll, fakeTab, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AGY_PROVIDER } from "../src/server/antigravity.ts";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { createHandler } from "../src/server/http.ts";
import { cloudCode, dictationServer, signedInGoogle } from "./support/fake-agy.ts";

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
let google: Awaited<ReturnType<typeof dictationServer>>;
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
const press = (selector: string, label: string) =>
    inPage(`[...document.querySelectorAll(${JSON.stringify(`${selector} button`)})].find((each) => each.innerText.trim() === ${JSON.stringify(label)}).click()`);
const box = () => inPage<string>(`document.querySelector("[data-part=composer] textarea")?.value ?? ""`);

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

    google = await dictationServer();
    const { send } = cloudCode(signedInGoogle);

    app = await openApp(scriptedModel(), join(root, "agy-dictation-ui"), undefined, {
        antigravity: { send, platform: { osType: "linux", arch: "amd64" } },
        agyMedia: { send, dictationUrl: google.url, idleMs: 300 },
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Chrome's fake microphone (a beep) stands in for a person speaking.
    engine = new ChromeEngine(chrome!, ["--no-sandbox", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await inPage<string>("location.pathname").catch(() => "")) === "/", "signed in", 20_000);
});

after(() =>
    cleanUpAll(
        () => cdp?.close(),
        () => engine?.close(),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => google?.close(),
        () => cleanUp(),
    ),
);

test("Antigravity in Dictation, Images and Audio once signed in; its dictation writes what Google hears into the box", real, async () => {
    // Signed out: Dictation offers Android's recognizer and Codex only.
    await sheet("dictation");
    await until(async () => (await text("[data-part=dictation-engine]")).includes("Codex"), "the engines");
    assert.equal(await inPage<boolean>(`document.querySelector("[data-part=dictation-agy]") === null`), true, "no Antigravity before it is signed in");

    // Sign in, as the Providers card does.
    const user = owner(app);
    const tab = fakeTab(undefined, user);

    app.attach(tab.client);
    const flowId = app.providers.startLogin(user, AGY_PROVIDER, "oauth");

    await until(() => tab.last("auth")?.step === "prompt", "the sign-in method");
    app.providers.answerLogin(user, flowId, tab.last("auth")!.promptId as string, "google");
    await until(() => tab.last("auth")?.step === "prompt" && (tab.last("auth")!.prompt as { type: string }).type === "manual_code", "the code prompt");
    app.providers.answerLogin(user, flowId, tab.last("auth")!.promptId as string, "4/0Aean-code");
    await until(() => tab.last("auth")?.step === "done", "the sign-in to finish");

    await sheet("dictation");
    await until(async () => inPage<boolean>(`document.querySelector("[data-part=dictation-agy]") !== null`), "Antigravity offered", 20_000);
    await press("[data-part=dictation-engine]", "Antigravity");
    await until(() => app.config.voice.engine === "antigravity", "the Antigravity engine");
    await until(async () => (await text("[data-part=dictation-engine]")).includes("audio goes to Google"), "what it does");
    assert.match(await text("[data-part=dictation-language]"), /hears the language you speak/);
    await shot("agy-dictation-390");

    // The message box's mic: the beep goes to the server and on to Google; what it heard shows, then settles.
    const id = await newSession(app);

    app.setAppearance(user, "micButton", true);
    await cdp.send("Page.navigate", { url: `${base}/s/${id}` });
    await until(async () => (await inPage<boolean>(`document.querySelector(".composer-mic") !== null`).catch(() => false)), "the mic", 20_000);
    await inPage(`document.querySelector(".composer-mic").click()`);
    await until(async () => /heard \d+/i.test(await box()), "what Google heard so far", 20_000);
    await inPage(`document.querySelector(".composer-mic").click()`);
    await until(async () => /^final \d+$/i.test((await box()).trim()), "the settled words", 20_000);
    const streams = google.streams.length;

    assert.ok(streams >= 1);
    assert.equal(google.streams.at(-1)!.messages.at(-1)!.toString("hex"), "1a0410013200", "the end went once the mic stopped");
    assert.ok(google.streams.at(-1)!.messages.length > 10, "the mic's audio reached Google");
    assert.doesNotMatch(await inPage<string>("document.documentElement.outerHTML"), /ya29\.live/);

    // Menu › Images: Antigravity's model, on its plan.
    await sheet("images");
    await until(async () => (await text(".sheet")).includes("Gemini 3.1 Flash Image"), "Antigravity's image model", 20_000);
    assert.match(await text(".sheet"), /Google Antigravity sign-in/);
    assert.match(await text(".sheet"), /on your Google Antigravity plan/);
    await shot("agy-images-390");

    // Menu › Audio: its transcription is one to pick (a sheet the address does not open: opened as the menu does).
    await inPage(`(async () => (await import("/store.js")).openSheet({ type: "audio" }))()`);
    await until(async () => inPage<boolean>(`document.querySelector("[data-part=audio-transcribe-model] .choice") !== null`), "the transcription model", 20_000);
    await inPage(`document.querySelector("[data-part=audio-transcribe-model] .choice").click()`);
    await until(async () => (await inPage<string>(`document.querySelector(".choice-menu")?.innerText ?? ""`)).includes("Google Antigravity"), "Antigravity's transcription");
    await shot("agy-audio-390");
    await app.setVoice(user, { engine: "android" });
});
