// Linked sessions in a real browser (PP-157, from pi-pocket): a session Pi starts (session_start) shows under the one
// that started it, whose row has a fold with how many; folding hides it and holds across a reload; above the
// transcripts, "Started from" and "Linked session" lead from one to the other. With PHONE_SHOTS set to a folder,
// screenshots at 390 px go there.
import { type App, cleanUp, newSession, openApp, say, scriptedModel, until, work } from "./helpers.ts";
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

    app = await openApp(scriptedModel());
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

after(async () => {
    cdp?.close();
    await engine?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a session Pi starts shows under the one that started it, folds away, and each links to the other", real, async () => {
    const starter = await newSession(app);

    // Pi acts for whoever asked for the work: the owner, here.
    await say(app, starter, "check the build in another session");
    const { id: started } = await app.sessionControl.start(starter, { cwd: work, message: "check the build", title: "Build check", key: crypto.randomUUID() });

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
