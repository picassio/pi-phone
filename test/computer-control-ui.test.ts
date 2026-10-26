// Computer control in a real browser (PP-178), with a stand-in machine and ocu (`test/support/fake-ocu.ts`): the
// computer_control card shows the machine, the apps and the minutes Pi asked for, fits a phone, and Approve and start
// starts the session; the top bar's monitor button opens Pi's computer, the browser panel's parts: the windows as tabs,
// the picture with the box on what Pi clicked, the minutes left and Stop; Take over makes a tap a click and refuses Pi;
// Menu › Computer control lists the machine, keeps the Never list and stops the session. With PHONE_SHOTS set to a
// folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : false;
const SHOTS = process.env.PHONE_SHOTS;
const FAKE = join(import.meta.dirname, "support", "fake-ocu.ts");

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("greet me on the sandbox")) {
        return fauxAssistantMessage(
            [fauxToolCall("computer_control", { action: "start", machine: "tuanlh-sandbox-01", apps: ["Pi OCU Demo", "Text Editor"], minutes: 15, follow: true, reason: "Fill in the name in Pi OCU Demo and press Greet." } as never)],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text.slice(0, 200)}` : "ok")]);
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

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

    app = await openApp(scriptedModel(route), join(root, "computer-ui-data"), undefined, {
        computer: {
            machines: () => [{ id: "m1", name: "tuanlh-sandbox-01", platform: "linux", connected: true, tools: { ocu: "1.1.2-pp.1" } }],
            launch: (_machine, script) => spawn(process.execPath, [FAKE, script.includes("python3 -c") ? "sign" : "mcp"], { stdio: ["pipe", "pipe", "pipe"] }),
            idleEndMs: 600_000,
            refreshMs: 3000,
        },
    });
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "computer-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    app?.computerControl.close();
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

test("the card, the panel with its picture and box, take over, and Menu › Computer control", { skip }, async () => {
    const id = Number(await newSession(app));

    await app.commands.submit(id as never, owner(app), { text: "greet me on the sandbox", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id as never).length > 0, "the card", 30_000);

    // The card on a phone: the machine, the apps with their names, the minutes Pi asked for, no picker.
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".phone-control-card")) !== "", "the card on a phone");
    const card = await text(".phone-control-card");

    assert.match(card, /Let Pi use tuanlh-sandbox-01 for 15 minutes\?/);
    assert.match(card, /Fill in the name in Pi OCU Demo and press Greet\./);
    assert.match(card, /Pi OCU Demo\s+demo_app\.py/);
    assert.match(card, /Text Editor\s+gedit/);
    assert.match(card, /and the windows these open while Pi works in them/);
    assert.match(card, /15 minutes, from when you approve\s+as Pi asked; for more, Pi asks again/);
    assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll(".phone-control-card input, .phone-control-card select").length)`), 0, "no minutes picker");
    const fits = await inPage<{ right: number; column: number; page: number; screen: number }>(`
        const box = document.querySelector(".phone-control-card").getBoundingClientRect();

        return JSON.stringify({ right: box.right, column: document.querySelector(".phone-control-card").parentElement.getBoundingClientRect().right, page: document.documentElement.scrollWidth, screen: innerWidth });
    `);

    assert.ok(fits.right <= fits.column + 1 && fits.page <= fits.screen, JSON.stringify(fits));
    await shot("computer-card-390");
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".phone-control-card .button.primary")?.disabled === false)`), "Approve enabled");
    await page.evaluate(`document.querySelector(".phone-control-card .button.primary").click()`);
    await until(() => app.computerControl.view().length === 1, "the session started");

    // Pi reads the window and clicks Greet: the panel's picture shows the box on it.
    const session = app.computerControl.sessionOfConversation(id)!;

    await app.computerControl.screen(session, "Pi OCU Demo");
    await app.computerControl.act(session, undefined, { op: "set_value", index: 2, value: "Tuan" });
    await app.computerControl.act(session, undefined, { op: "click", index: 5 });

    // On a desktop: the top bar's monitor button opens the panel beside the conversation.
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".topbar button[title=\\"Pi's computer\\"]") !== null)`), "the monitor button");
    await page.evaluate(`document.querySelector(".topbar button[title=\\"Pi's computer\\"]").click()`);
    await until(async () => (await text("[data-part=computer-panel]")) !== "", "the panel");
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector("[data-part=computer-panel] .pb-frame img") !== null)`), "the picture");
    const panel = await text("[data-part=computer-panel]");

    assert.match(panel, /Pi's computer/);
    assert.match(panel, /tuanlh-sandbox-01 · Pi OCU Demo/);
    assert.match(panel, /Pi OCU Demo\s+Text Editor/, "the windows as tabs");
    assert.match(panel, /This session · 1[45] min left/);
    assert.match(await text("[data-part=computer-panel] .cu-hit-tag"), /click \[5\]/);
    await shot("computer-panel-1280");

    // Take over: Pi waits; a tap is a click at that point of the picture.
    await page.evaluate(`[...document.querySelectorAll("[data-part=computer-panel] .button")].find((each) => each.innerText === "Take over").click()`);
    await until(async () => (await text("[data-part=computer-panel] .pb-status")).includes("You have the window"), "taken over");
    await assert.rejects(app.computerControl.screen(session, "Pi OCU Demo"), /The owner took the computer over/);
    await page.evaluate(`
        const image = document.querySelector("[data-part=computer-panel] .pb-frame img");
        const box = image.getBoundingClientRect();

        image.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: box.left + box.width * 0.5, clientY: box.top + box.height * 0.64 }));
    `);
    await until(async () => (await text("[data-part=computer-panel] .pb-takeover")).includes("never into a password field"), "the take-over bar");
    await shot("computer-takeover-1280");
    await page.evaluate(`[...document.querySelectorAll("[data-part=computer-panel] .button")].find((each) => each.innerText === "Hand back").click()`);
    await until(async () => !(await text("[data-part=computer-panel] .pb-status")).includes("You have the window"), "handed back");

    // On a phone the panel covers the screen.
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text("[data-part=computer-panel]")) !== "", "the panel on a phone");
    await shot("computer-panel-390");

    // Menu › Computer control: the machine and its session, the Never list kept by the owner, Stop.
    await page.evaluate(`
        sessionStorage.removeItem("pocket.piComputer");
        (await import("/store.js")).openSheet({ type: "computer-control" });
    `);
    // innerText as shown: the section titles are in capitals.
    await until(async () => (await text(".computer-control-sheet")).toLowerCase().includes("never these apps"), "the sheet");
    const sheet = await text(".computer-control-sheet");

    assert.match(sheet, /tuanlh-sandbox-01\s+Linux · ocu 1\.1\.2-pp\.1 · in use by session #\d+ until \d{1,2}:\d\d/);
    assert.match(sheet, /Banking and payment apps/);
    assert.match(sheet, /Password managers and authenticators/);
    await page.evaluate(`[...document.querySelectorAll(".computer-control-sheet button.chip")].find((each) => each.innerText.includes("Add")).click()`);
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".computer-control-sheet form input") !== null)`), "the field");
    await page.evaluate(`
        const input = document.querySelector(".computer-control-sheet form input");

        input.value = "Outlook";
        input.dispatchEvent(new Event("input", { bubbles: true }));
    `);
    // The form submits with the name once it is drawn with it.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await page.evaluate(`document.querySelector(".computer-control-sheet form").requestSubmit()`);
    await until(() => app.computerControl.neverList().own.some((each) => each.label === "Outlook"), "Outlook on the Never list");
    await shot("computer-sheet-390");
    await page.evaluate(`[...document.querySelectorAll(".computer-control-sheet [data-part=computer-machine] .button")].find((each) => each.innerText === "Stop").click()`);
    await until(() => app.computerControl.view().length === 0, "stopped");
});
