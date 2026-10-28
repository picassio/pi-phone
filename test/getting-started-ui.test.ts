// Getting started in a real browser (PP-235; web/guide.js, web/sheets/menu.js): Menu › Getting started opens the owner's
// Getting started session, where Pi (a scripted model here) keeps the checklist with the guide tool and changes a
// setting through its card. The checklist bar under the session's header: one line on a phone with the part Pi is on,
// opening to the whole list; the whole list on a wide screen. With PHONE_SHOTS set to a folder, screenshots go there
// (onboarding-built-*.png).
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
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

/** Pi as the skill has it: the topics picked, the first one done, then a setting offered on its card. */
const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    if (role === "user" && text.includes("Show me around.")) {
        return fauxAssistantMessage(
            [
                fauxText("Hi, I'm Pi. You picked the basics, how the app looks, and voice: I keep them on the list above and tick each as we finish it."),
                fauxToolCall("guide", { action: "set", items: ["The basics", "How the app looks", "Voice and dictation"] } as never),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "toolResult" && text.includes("[ ] The basics")) {
        return fauxAssistantMessage([fauxToolCall("guide", { action: "tick", item: "1" } as never)], { stopReason: "toolUse" });
    }

    if (role === "toolResult" && text.includes("[x] The basics")) {
        return fauxAssistantMessage(
            [
                fauxText("The basics are done. Now how the app looks: themes and colors are in Appearance."),
                fauxToolCall("show_screen", { screen: "appearance", why: "Pick a theme and its colors." } as never),
            ],
            { stopReason: "toolUse" },
        );
    }

    if (role === "toolResult" && text.includes("open appearance")) {
        return fauxAssistantMessage(
            [
                fauxText("You said you like light screens, so I can make the app start in its light colors. Approve the card to switch."),
                fauxToolCall("setting_change", { id: "themes.default", value: "lantern", reason: "You like light screens: the app starts in its light colors." } as never),
            ],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

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
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

    writeFileSync(join(SHOTS, `onboarding-built-${name}.png`), Buffer.from(data, "base64"));
}

const bar = () => inPage<string>(`document.querySelector("[data-part=guide-checklist]")?.innerText ?? ""`);

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(route), join(root, "getting-started-ui"));
    await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    cdp = await engine.connect(await engine.newTab());
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await cdp.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}` });
    await until(async () => (await inPage<boolean>(`document.querySelector("[data-part=home-list]") !== null`).catch(() => false)), "the app", 20_000);
});

after(async () => {
    cdp?.close();
    await engine?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("Menu › Getting started opens the guide; the checklist bar follows Pi's ticks; a setting waits on its card", real, async () => {
    // The menu, as a person opens it, with Getting started first among the app's things.
    await inPage(`(async () => { const { openSheet } = await import("/store.js"); openSheet({ type: "menu" }); })()`);
    await until(async () => (await inPage<boolean>(`[...document.querySelectorAll(".list-item")].some((each) => each.innerText.startsWith("Getting started"))`)), "the menu item");
    await inPage(`[...document.querySelectorAll(".group-title")].find((each) => each.innerText === "App")?.scrollIntoView({ block: "center" })`);
    await shot("menu-390");
    await inPage(`[...document.querySelectorAll(".list-item")].find((each) => each.innerText.startsWith("Getting started")).click()`);

    const id = await (async () => {
        await until(() => owner(app).guide !== undefined, "the session made");

        return Number(owner(app).guide);
    })();

    await until(async () => (await inPage<number | null>(`(async () => (await import("/store.js")).store.state.conversationId)()`)) === id, "opened");
    assert.equal(app.sessionMeta(id as never)?.title, "Getting started");

    // On a phone: one line, with the part Pi is on.
    await until(async () => (await bar()).includes("1 of 3 done"), "the bar, the basics ticked");
    assert.match(await bar(), /Now:\s*How the app looks/);
    assert.doesNotMatch(await bar(), /Voice and dictation/, "one line until opened");
    await until(async () => (await inPage<boolean>(`[...document.querySelectorAll("button")].some((each) => each.innerText.trim() === "Allow")`)), "the setting's card");

    // Pi's show_screen card: the screen, why, and Open, which opens it only when tapped (PP-235).
    const card = await inPage<string>(`document.querySelector("[data-part=screen-card]")?.innerText ?? ""`);

    assert.match(card, /Appearance[\s\S]*Pick a theme and its colors\.[\s\S]*Open/);
    assert.equal(await inPage<boolean>(`document.querySelector(".sheet") !== null`), false, "nothing opened by itself");
    await inPage(`document.querySelector("[data-part=screen-card]").scrollIntoView({ block: "center" })`);
    await shot("session-390");
    await inPage(`document.querySelector("[data-part=screen-card] button").click()`);
    await until(async () => (await inPage<string>(`document.querySelector(".sheet")?.innerText ?? ""`)).includes("Appearance"), "Appearance opened by the tap");
    await inPage(`(async () => (await import("/store.js")).closeSheet())()`);

    // Opened: the whole list.
    await inPage(`document.querySelector("[data-part=guide-checklist] .guide-head").click()`);
    await until(async () => (await bar()).includes("Voice and dictation"), "the whole list");
    assert.equal(await inPage<number>(`document.querySelectorAll("[data-part=guide-checklist] li.done").length`), 1);

    // On a wide screen: the whole list.
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
    await cdp.send("Page.reload");
    await until(async () => (await bar().catch(() => "")).includes("Voice and dictation"), "the whole list on a wide screen", 20_000);
    await shot("session-1280");

    // The menu again: the same session.
    await inPage(`(async () => { const { navigate } = await import("/store.js"); navigate(null); })()`);
    await inPage(`(async () => { const { openGettingStarted } = await import("/guide.js"); await openGettingStarted(); })()`);
    await until(async () => (await inPage<number | null>(`(async () => (await import("/store.js")).store.state.conversationId)()`)) === id, "the same session");
});

const card = () => inPage<string>(`document.querySelector("[data-part=whats-new]")?.innerText ?? ""`);
const home = async (width: number) => {
    await cdp.send("Emulation.setDeviceMetricsOverride", { width, height: width < 600 ? 844 : 800, deviceScaleFactor: 2, mobile: width < 600 });
    await inPage(`(async () => { const { navigate } = await import("/store.js"); navigate(null); })()`);
};

// What's new (PP-235): the app's newest big release (whatsnew/), shown until dismissed.
test("after a big update: the card on the session list and the home screen; Show me opens the guide on its notes; Dismiss hides it", real, async () => {
    const me = owner(app);

    // The guide's run before still waits on its setting card: stopped, so the next message goes to Pi at once.
    await app.commands.abort(Number(me.guide) as never, me);
    app.setWhatsNew(me, "show");
    await home(390);
    await until(async () => (await card()).includes("A welcome, and Getting started with Pi"), "the card on the session list");
    assert.match(await card(), /What's new[\s\S]*Dismiss[\s\S]*Show me/i);
    await shot("whats-new-390");
    await home(1280);
    await until(async () => (await inPage<boolean>(`document.querySelector("[data-part=home] [data-part=whats-new]") !== null`)), "the card on the home screen");
    await shot("whats-new-1280");

    await inPage(`[...document.querySelectorAll("[data-part=whats-new] button")].find((each) => each.innerText.trim() === "Show me").click()`);
    await until(async () => (await inPage<number | null>(`(async () => (await import("/store.js")).store.state.conversationId)()`)) === Number(me.guide), "the guide session");
    await until(async () => (await inPage<string>(`document.querySelector(".transcript")?.innerText ?? ""`)).includes("Show me what's new in 2026-10-28."), "the What's new message");
    assert.equal((await app.hello(me)).user.whatsNew, null, "seen");

    // Dismiss, after it is shown again.
    app.setWhatsNew(me, "show");
    await home(390);
    await until(async () => (await card()) !== "", "the card again");
    await inPage(`[...document.querySelectorAll("[data-part=whats-new] button")].find((each) => each.innerText.trim() === "Dismiss").click()`);
    await until(async () => (await card()) === "", "dismissed");
    assert.equal((await app.hello(me)).user.whatsNew, null);
});
