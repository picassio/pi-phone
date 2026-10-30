// Menu › Computer control for a Windows machine (PP-179) in a real browser, with a stand-in Windows machine and bridge
// (`test/support/fake-windows.ts`): the machine says pi-phone's task is not set up, with what Set up makes; Set up makes
// it (the owner's tap is their yes) and the machine is ready, with Check (what ocu reads, through the bridge) and Remove;
// nobody signed in says so. With PHONE_SHOTS set to a folder, screenshots go there.
import { type App, cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type FakeWindows, fakeWindows } from "./support/fake-windows.ts";

const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : false;
const SHOTS = process.env.PHONE_SHOTS;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let windows: FakeWindows;

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            const shown = page === undefined ? "" : await page.evaluate(`return JSON.stringify(document.body.innerText.slice(0, 3000))`).catch(() => "");

            throw new Error(`Timed out waiting for ${what}; the page shows: ${shown}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

before(async () => {
    if (skip) {
        return;
    }

    windows = await fakeWindows({ ocuLog: join(mkdtempSync(join(root, "computer-windows-ui-")), "calls.jsonl") });
    windows.state = { task: false, loggedOn: true, locked: false, running: false };
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), join(root, "computer-windows-ui-data"), undefined, {
        computer: {
            machines: () => [{ id: "w1", name: "tualh-laptop", platform: "windows", connected: true, tools: { ocu: "1.1.2-pp.2" }, user: "Picassio" }],
            launch: windows.launch,
            run: windows.run,
            writeFile: windows.writeFile,
            forward: windows.forward,
            idleEndMs: 600_000,
            refreshMs: 60_000,
        },
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "computer-windows-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`http://127.0.0.1:${(server.address() as { port: number }).port}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    app?.computerControl.close();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    await windows?.close();
    cleanUp();
});

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const machineText = () => inPage<string>(`return JSON.stringify(document.querySelector(".computer-control-sheet [data-part=computer-machine]")?.innerText ?? "")`);
const press = (label: string) => page.evaluate(`[...document.querySelectorAll(".computer-control-sheet [data-part=computer-machine] .button")].find((each) => each.innerText === ${JSON.stringify(label)}).click()`);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

test("Menu › Computer control: a Windows machine not set up, Set up, ready with Check and Remove, and nobody signed in", { skip }, async () => {
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "computer-control" })`);
    await until(async () => (await machineText()).includes("pi-phone's task is not set up"), "not set up");
    const before = await machineText();

    assert.match(before, /tualh-laptop\s+Windows · ocu 1\.1\.2-pp\.2/);
    assert.match(before, /Set up makes a scheduled task as you, run only while you are signed in \(no password, never as administrator\)/);
    assert.ok(!windows.scripts.some((each) => each.kind === "install"));
    await shot("computer-windows-not-set-up");

    await press("Set up");
    await until(async () => /\bready\b/.test(await machineText()), "ready");
    assert.equal(windows.scripts.filter((each) => each.kind === "install").length, 1);
    assert.match(await machineText(), /Remove/);

    await press("Check");
    await until(async () => (await machineText()).includes("ocu reads:"), "what ocu reads");
    assert.match(await machineText(), /ocu reads: [^\n]*Pi OCU Demo/);
    await shot("computer-windows-ready");

    await press("Remove");
    await until(async () => (await machineText()).includes("pi-phone's task is not set up"), "removed");
    assert.equal(windows.scripts.filter((each) => each.kind === "remove").length, 1);
    assert.doesNotMatch(await machineText(), /ocu reads:|Check/, "what ocu read before goes with the task");

    // Nobody signed in: the sheet says so when it opens.
    windows.state = { task: true, loggedOn: false, locked: false, running: false };
    await page.evaluate(`(await import("/store.js")).closeSheet()`);
    await until(async () => !(await inPage<boolean>(`return JSON.stringify(document.querySelector(".computer-control-sheet") !== null)`)), "the sheet closed");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "computer-control" })`);
    await until(async () => (await machineText()).includes("not logged on: sign in on the computer"), "not logged on");
});
