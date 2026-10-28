// The first-run welcome in a real browser (PP-234; web/welcome.js): a new pi-phone's owner gets three skippable steps
// (language, a model, this phone or this browser); finishing or skipping it is kept on the server, so it does not come
// back. In the pi-phone app the third step is Android's permissions, each through the app's bridge; in a browser,
// notifications and installing the app. On a team server whose accounts give the person models, the second step picks
// the one Pi starts with. Full screen on a phone, a card over the app on a wide screen. With PHONE_SHOTS set to a
// folder, screenshots go there (onboarding-built-*.png).
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
let engine: ChromeEngine;
let cdp: Cdp;
let base = "";

async function inPage<T>(expression: string): Promise<T> {
    const answer = await cdp.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `onboarding-built-${name}.png`), Buffer.from(data, "base64"));
}

const welcomeText = () => inPage<string>(`document.querySelector("[data-part=welcome]")?.innerText ?? ""`);
const press = (label: string) =>
    inPage(`(() => {
        const button = [...document.querySelectorAll("[data-part=welcome] button")].find((each) => each.innerText.trim() === ${JSON.stringify(label)});
        if (!button) throw new Error("no button " + ${JSON.stringify(label)});
        button.click();
    })()`);
/** The page as a new owner opens it: the welcome to show, at `width`; `phone` stands in the pi-phone app's bridge. */
async function open(width: number, { phone = false, extra = "" } = {}): Promise<void> {
    app.setWelcome(owner(app), "show");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: phone
            ? `window.asked = []; window.PiPhoneApp = {
                notificationsEnabled: () => true, openNotificationSettings: () => asked.push("notifications"),
                runsUnrestricted: () => asked.includes("unrestricted"), runUnrestricted: () => asked.push("unrestricted"),
                micAllowed: () => false, askMic: () => asked.push("mic"),
                assistantHeld: () => false, openSettings: (which) => asked.push("settings:" + which),
                signIn: () => {} };${extra}`
            : `delete window.PiPhoneApp;${extra}`,
    });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await welcomeText().catch(() => "")).includes("Welcome to pi-phone"), "the welcome", 20_000);
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(), join(root, "welcome-ui"), undefined, {}, { welcome: true });
    await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
});

after(async () => {
    cdp?.close();
    await engine?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("in a browser: language, a model, this browser; finished, it stays finished", real, async () => {
    await open(390);
    assert.match(await welcomeText(), /Step 1 of 3/i);
    assert.match(await welcomeText(), /Auto[\s\S]*English[\s\S]*简体中文/);
    await shot("language-390");
    await press("Continue");
    await until(async () => (await welcomeText()).includes("Sign in to a model"), "the model step");
    // The model sign-ins offered (owner's decision D), as the providers have them, and a key for the rest.
    await until(async () => (await inPage<number>(`document.querySelectorAll("[data-part=welcome] [data-provider]").length`)) > 0, "the providers");
    assert.deepEqual(await inPage<string[]>(`[...document.querySelectorAll("[data-part=welcome] [data-provider]")].map((each) => each.dataset.provider)`), ["anthropic", "openai-codex", "github-copilot", "openrouter"]);
    assert.match(await welcomeText(), /An API key/);
    await shot("model-390");
    // The scripted model is signed in: Continue goes on.
    await press("Continue");
    await until(async () => (await welcomeText()).includes("Keep up from this browser"), "this browser's step");
    assert.match(await welcomeText(), /Notifications[\s\S]*Install as an app/);
    await shot("browser-390");
    await press("Go to the app");
    await until(async () => (await welcomeText()) === "", "the welcome gone");
    assert.equal((await app.hello(owner(app))).user.welcome, "done");

    // Opened again: no welcome.
    await cdp.send("Page.reload");
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal(await welcomeText(), "");
});

test("Skip setup leaves it, kept as skipped", real, async () => {
    await open(390);
    await press("Skip setup");
    await until(async () => (await welcomeText()) === "", "the welcome gone");
    assert.equal((await app.hello(owner(app))).user.welcome, "skipped");
});

test("in the pi-phone app: Android's permissions through the bridge, read again on return", real, async () => {
    await open(390, { phone: true });
    await press("Continue");
    await until(async () => (await welcomeText()).includes("Sign in to a model"), "the model step");
    await press("Continue");
    await until(async () => (await welcomeText()).includes("Let Pi work well on this phone"), "the phone step");
    assert.match(await welcomeText(), /Notifications[\s\S]*Run with the screen off[\s\S]*Microphone[\s\S]*Side key/);
    assert.equal(await inPage<number>(`document.querySelectorAll("[data-part=welcome-permission].done").length`), 1, "notifications are on already");
    await shot("phone-390");
    await press("Allow");
    // Back from Android's screen: the app's window has the focus again, and the page reads them again.
    await inPage(`window.dispatchEvent(new Event("focus"))`);
    await until(async () => (await inPage<number>(`document.querySelectorAll("[data-part=welcome-permission].done").length`)) === 2, "run unrestricted done");
    await press("Open");
    assert.deepEqual(await inPage<string[]>("window.asked"), ["unrestricted", "settings:assistant"]);
    await press("Go to the app");
    await until(async () => (await welcomeText()) === "", "the welcome gone");
});

test("on a team server with team models: pick the one Pi starts with; on a wide screen, a card over the app", real, async () => {
    // A team member's pi-phone as the page sees it: behind the gateway, a team account with models.
    const stub = `
        const fetched = window.fetch;
        window.fetch = async (input, init) => {
            if (String(input).startsWith("api/providers") && (!init || !init.method || init.method === "GET")) {
                return Response.json([{ id: "anthropic~team-work", name: "Anthropic · Team Work", team: { roles: [] }, configured: true, models: 2, oauth: null, apiKey: true, account: { name: "Work", of: "anthropic" } }]);
            }
            return fetched(input, init);
        };`;

    await open(1280, { extra: stub });
    // After the stream's hello, which sets both.
    await new Promise((resolve) => setTimeout(resolve, 2000));
    await inPage(`(async () => {
        const { store } = await import("/store.js");
        store.set({ server: { ...store.state.server, gateway: true }, models: [
            { provider: "anthropic~team-work", id: "claude-sonnet-5", name: "Claude Sonnet 5" },
            { provider: "anthropic~team-work", id: "claude-opus-5", name: "Claude Opus 5" },
        ] });
    })()`);
    await shot("language-1280");
    await press("Continue");
    await until(async () => (await welcomeText()).includes("Your team's models"), "the team's models");
    assert.match(await welcomeText(), /Claude Sonnet 5[\s\S]*Claude Opus 5[\s\S]*Your own sign-in/);

    const card = await inPage<{ width: number; left: number; screen: number }>(`(() => { const box = document.querySelector(".welcome-card").getBoundingClientRect(); return { width: box.width, left: box.left, screen: innerWidth }; })()`);

    assert.ok(card.width <= 560 && card.left > 300, `a centred card: ${JSON.stringify(card)}`);
    await shot("team-model-1280");
    await press("Skip setup").catch(() => {});
    app.setWelcome(owner(app), "done");
});
