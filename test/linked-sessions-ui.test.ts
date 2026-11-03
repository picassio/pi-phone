// Linked sessions in a real browser (PP-157, from pi-pocket): a session Pi starts (session_start) shows under the one
// that started it, whose row has a fold with how many; folding hides it and holds across a reload; above the
// transcripts, "Started from" and "Linked session" lead from one to the other. With PHONE_SHOTS set to a folder,
// screenshots at 390 px go there.
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { type App, cleanUp, cleanUpAll, lastText, modelTexts, newSession, openApp, say, scriptedModel, until, work } from "./helpers.ts";
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
const row = (id: number) => `[data-part=session-row][data-id="${id}"]`;
const shown = (id: number) => inPage<boolean>(`document.querySelector(${JSON.stringify(row(id))}) !== null`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality: 80 });

    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from(data, "base64"));
}

before(async () => {
    if (real.skip) {
        return;
    }

    // The card test's long message gets a short answer, so the card and the answer fit the screen.
    app = await openApp(
        scriptedModel((request) => {
            const { text } = lastText(request as never);

            return fauxAssistantMessage([fauxText(text.includes("Check the build.") ? "On it." : `echo: ${text}`)]);
        }),
    );
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
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
        () => cleanUp(),
    ),
);

test("a session Pi starts shows under the one that started it, folds away, and each links to the other", real, async () => {
    const starter = await newSession(app);

    // Pi acts for whoever asked for the work: the owner, here.
    await say(app, starter, "check the build in another session");
    const { id: started } = await app.sessionControl.startLinked(starter, { cwd: work, message: "check the build", title: "Build check", key: crypto.randomUUID() });

    await cdp.send("Page.navigate", { url: `${base}/` });
    await until(async () => (await shown(Number(starter))) && (await shown(started)), "both rows", 20_000);

    // The started one is nested under its starter, which has a fold with how many.
    assert.ok(await inPage<boolean>(`document.querySelector(${JSON.stringify(row(started))}).style.getPropertyValue("--linked-depth") === "1"`), "nested one level");
    assert.match(await text(`${row(Number(starter))} [data-part=session-fold]`), /1/);
    await shot("linked-list-390");

    // Folded: it goes, and stays folded across a reload.
    await inPage(`document.querySelector(${JSON.stringify(`${row(Number(starter))} [data-part=session-fold]`)}).click()`);
    await until(async () => !(await shown(started)), "folded away");
    await cdp.send("Page.navigate", { url: `${base}/` });
    await until(async () => await shown(Number(starter)), "the list again", 20_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await shown(started), false, "still folded after a reload");
    await inPage(`document.querySelector(${JSON.stringify(`${row(Number(starter))} [data-part=session-fold]`)}).click()`);
    await until(async () => await shown(started), "unfolded");

    // Above the transcripts: where it came from, and what it started.
    await cdp.send("Page.navigate", { url: `${base}/s/${started}` });
    await until(async () => (await text("[data-part=linked-sessions]")).includes("Started from"), "Started from", 20_000);
    await shot("linked-started-from-390");
    await inPage(`document.querySelector("[data-part=linked-session]").click()`);
    await until(async () => (await inPage<string>("location.pathname")) === `/s/${starter}`, "to the starter");
    await until(async () => (await text("[data-part=linked-sessions]")).includes("Linked session"), "Linked session");
    assert.match(await text("[data-part=linked-sessions]"), /Build check/);
});

test("a message from a linked session shows as an agent's card, with its session and Open; the model reads it as before (PP-352)", real, async () => {
    const starter = await newSession(app);

    await say(app, starter, "ask another session");
    const long = Array.from({ length: 40 }, (_, at) => `- step ${at + 1}: check **part ${at + 1}** of the build`).join("\n");
    const { id: started } = await app.sessionControl.startLinked(starter, { cwd: work, message: `Check the build.\n\n${long}`, title: "Card check", key: crypto.randomUUID() });

    await cdp.send("Page.navigate", { url: `${base}/s/${started}` });
    await until(async () => (await inPage<boolean>(`document.querySelector('[data-from="linked"]') !== null`)), "the card", 20_000);
    const card = await inPage<{ name: string; open: boolean; bold: boolean; folded: boolean; head: string }>(`(() => {
        const card = document.querySelector('[data-from="linked"]');

        return {
            name: card.querySelector('[data-part="linked-name"]').textContent.trim(),
            open: card.querySelector('[data-part="linked-open"]') !== null,
            bold: card.querySelector('[data-part="linked-body"] strong') !== null,
            folded: !card.querySelector('[data-part="linked-body"]').textContent.includes("step 40"),
            head: card.querySelector('[data-part="linked-head"]').textContent,
        };
    })()`);

    assert.equal(card.name, "ask another session");
    assert.equal(card.open, true, "Open, as the owner sees the session");
    assert.equal(card.bold, true, "its text as Markdown");
    assert.equal(card.folded, true, "a long one folded");
    assert.match(card.head, /Linked session/);
    // Nothing of a person's message: no avatar or author.
    assert.equal(await inPage<boolean>(`document.querySelector('[data-from="linked"] [data-part="author-mark"]') === null`), true);
    // What the model reads is as it was: the marker and the text.
    assert.ok((await modelTexts(app, started as never)).some((each) => each.includes(`[via session #${String(starter)} `) && each.includes("Check the build.")));
    const toCard = `document.querySelector('[data-from="linked"]').scrollIntoView({ block: "start" })`;

    await inPage(toCard);
    await shot("linked-card-390");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await inPage(toCard);
    await shot("linked-card-1280");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

    // Show all unfolds it, and the card stays where it is: the message sheet does not open.
    assert.match(await text('[data-part="linked-more"]'), /Show all · 42 lines/);
    await inPage(`document.querySelector('[data-part="linked-more"]').click()`);
    await until(async () => (await text('[data-part="linked-body"]')).includes("step 40"), "all of it");
    assert.equal(await inPage<boolean>(`document.querySelector(".sheet") === null`), true);

    // Open goes to the session it came from.
    await inPage(`document.querySelector('[data-part="linked-open"]').click()`);
    await until(async () => (await inPage<string>("location.pathname")) === `/s/${starter}`, "to the session it came from");
});

test("a session whose linked sessions work shows as working, at any depth (PP-337)", real, async () => {
    const top = await newSession(app);

    await say(app, top, "start a team");
    const { id: middle } = await app.sessionControl.startLinked(top, { cwd: work, message: "lead it", title: "Lead", key: crypto.randomUUID() });

    await say(app, middle as never, "start a helper");
    const { id: bottom } = await app.sessionControl.startLinked(middle as never, { cwd: work, message: "help", title: "Helper", key: crypto.randomUUID() });
    const mark = (id: number) => inPage<{ state: string; label: string }>(`(() => {
        const row = document.querySelector(${JSON.stringify(row(id))});

        return { state: row?.dataset.state ?? "", label: row?.querySelector(".status-work")?.getAttribute("aria-label") ?? "" };
    })()`);

    await cdp.send("Page.navigate", { url: `${base}/` });
    await until(async () => (await shown(Number(top))) && (await shown(bottom)), "the rows", 20_000);
    await until(async () => !app.isBusy(bottom as never) && (await mark(Number(top))).state !== "working", "all at rest", 20_000);

    // The helper two levels down works: both sessions above it wait for its report.
    await inPage(`(async () => {
        const { store } = await import("/store.js");

        store.set((state) => ({ sessions: state.sessions.map((session) => (session.id === ${bottom} ? { ...session, busy: true } : session)) }));
    })()`);
    await until(async () => (await mark(Number(top))).state === "working", "the top session working");
    assert.deepEqual(await mark(Number(top)), { state: "working", label: "Its linked sessions are working" });
    assert.deepEqual(await mark(middle), { state: "working", label: "Its linked sessions are working" });
    assert.deepEqual(await mark(bottom), { state: "working", label: "Working" });
    await shot("linked-working-390");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await shot("linked-working-1280");
    await cdp.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });

    // At rest again: so is the session that waited.
    await inPage(`(async () => {
        const { store } = await import("/store.js");

        store.set((state) => ({ sessions: state.sessions.map((session) => (session.id === ${bottom} ? { ...session, busy: false } : session)) }));
    })()`);
    await until(async () => (await mark(Number(top))).state !== "working", "the top session at rest");
});
