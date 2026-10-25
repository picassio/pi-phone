// Phone control in a real browser (PP-141), with a fake phone answering the app's service channel
// (`test/support/fake-phone.ts`): Menu › Phone control shows the setup steps with their marks from the phone (the Open
// buttons ask the app's shell), the Never list's groups with what is installed, the owner's own list (added from the
// phone's apps, removed again) and the device; the phone_control card shows the apps and minutes, fits a phone's column,
// and Approve and start starts the session, whose live line in the session says so and stops it. With PHONE_SHOTS set
// to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
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
import { FakePhone } from "./support/fake-phone.ts";

const skip = findBrowser() === undefined ? "no Chromium-based browser on this machine" : false;
const SHOTS = process.env.PHONE_SHOTS;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("order lunch on my phone")) {
        return fauxAssistantMessage([fauxToolCall("phone_control", { action: "start", apps: ["Grab"], minutes: 15, reason: "Order your usual lunch from Pho Thin" } as never)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const phone = new FakePhone();

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

    app = await openApp(scriptedModel(route), join(root, "phone-ui-data"));
    phone.attach(app.phoneControl.requests);
    await until(() => app.phoneControl.present(), "the phone polls");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "phone-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    phone.detach();
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

/** Nothing wider than the screen, and `selector` inside its column. */
async function fits(selector: string): Promise<void> {
    const measured = await inPage<{ right: number; column: number; page: number; screen: number }>(`
        const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
        const column = document.querySelector(${JSON.stringify(selector)}).parentElement.getBoundingClientRect();

        return JSON.stringify({ right: box.right, column: column.right, page: document.documentElement.scrollWidth, screen: innerWidth });
    `);

    assert.ok(measured.right <= measured.column + 1 && measured.page <= measured.screen, JSON.stringify(measured));
}

/** Open the sheet in the app's shell (a stand-in bridge that records which settings page it was asked for). */
async function openSheet(): Promise<void> {
    await page.navigate(`${base}/`);
    await until(async () => (await text(".topbar, header, body")) !== "", "the app");
    await page.evaluate(`
        window.__opened = [];
        window.PiPhoneApp = { openSettings: (which) => window.__opened.push(which) };
        (await import("/store.js")).openSheet({ type: "phone-control" });
    `);
    // innerText as shown: the section titles are in capitals.
    await until(async () => (await text(".phone-control-sheet")).toLowerCase().includes("never these apps"), "the sheet");
}

test("Menu › Phone control: the steps with the phone's marks, the Never list, the owner's own list, the device", { skip }, async () => {
    phone.enabled = false;
    await page.setViewport(VIEWPORTS.mobile);
    await openSheet();
    await until(async () => (await text(".phone-control-sheet")).includes("installed"), "the counts of installed apps");
    const sheet = await text(".phone-control-sheet");

    assert.match(sheet, /Allow restricted settings/, "Android 14: the restricted settings step");
    assert.match(sheet, /Turn on pi-phone in Accessibility/);
    assert.match(sheet, /Let it run in the background/);
    assert.match(sheet, /pi-phone itself \(always\)/);
    assert.match(sheet, /Banking and payment apps\s*· 1 installed/);
    assert.match(sheet, /Password managers and authenticators\s*· 1 installed/);
    assert.match(sheet, /This phone\s+Android 34 · accessibility off/);
    // Accessibility off: steps 1 and 2 to do, 3 done (pi runs unrestricted).
    assert.deepEqual(await inPage<boolean[]>(`return JSON.stringify([...document.querySelectorAll(".phone-step")].map((each) => each.classList.contains("done")))`), [false, false, true]);
    await fits(".phone-steps");
    await shot("phone-control-sheet-390");

    // Open asks the app's shell for Android's page.
    // (A DOM click: under a full test run's load a click at the button's coordinates missed it.)
    await page.evaluate(`document.querySelector(".phone-step:nth-child(2) .button").click()`);
    await until(async () => (await inPage<string[]>(`return JSON.stringify(window.__opened)`)).length > 0, "the bridge asked");
    assert.deepEqual(await inPage<string[]>(`return JSON.stringify(window.__opened)`), ["accessibility"]);

    // The owner adds an app from the phone's list, then removes it (DOM clicks, as above: a loaded CI run missed a
    // coordinate click here too).
    await page.evaluate(`document.querySelector(".phone-never button.chip").click()`);
    await until(async () => (await text(".phone-picker")).includes("Notes"), "the picker");
    assert.doesNotMatch(await text(".phone-picker"), /Vietcombank|Bitwarden|\bpi\b/, "apps on the built-in lists are not offered");
    await shot("phone-control-add-390");
    await page.evaluate(`[...document.querySelectorAll(".phone-picker button")].find((each) => each.innerText.includes("Notes")).click()`);
    await until(() => app.phoneControl.neverReason("com.example.notes") === "on the owner's Never list", "Notes on the Never list");
    await until(async () => (await text(".phone-never")).includes("Notes"), "its chip");
    await page.evaluate(`document.querySelector(".phone-never .chip button[aria-label='Remove Notes']").click()`);
    await until(() => app.phoneControl.neverReason("com.example.notes") === undefined, "Notes off the list");

    // On a desktop, with accessibility on (Android says so when the person comes back): the steps are done.
    phone.enabled = true;
    await page.setViewport(VIEWPORTS.desktop);
    await openSheet();
    await until(async () => (await text(".phone-control-sheet")).includes("accessibility on"), "accessibility on");
    assert.deepEqual(await inPage<boolean[]>(`return JSON.stringify([...document.querySelectorAll(".phone-step")].map((each) => each.classList.contains("done")))`), [true, true, true]);
    await shot("phone-control-sheet-1280");
});

test("the phone_control card shows the apps and minutes, fits a phone, and starts the session; its live line stops it", { skip }, async () => {
    phone.enabled = true;
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "order lunch on my phone", requestId: crypto.randomUUID() });
    await until(() => app.approvals.forConversation(id).length > 0, "the card");

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".phone-control-card")) !== "", "the card on a phone");
    const card = await text(".phone-control-card");

    assert.match(card, /Let Pi use this phone for 15 minutes\?/);
    assert.match(card, /Order your usual lunch from Pho Thin/);
    assert.match(card, /Grab\s+com\.grabtaxi\.passenger/);
    assert.match(card, /and the home screen, to open them/);
    assert.match(card, /15 minutes, from when you approve/);
    assert.match(card, /banking apps, password managers and your Never list stay out/);
    await fits(".phone-control-card");
    await shot("phone-control-card-390");

    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".phone-control-card")) !== "", "the card on a desktop");
    await shot("phone-control-card-1280");
    await until(async () => inPage<boolean>(`return JSON.stringify(document.querySelector(".phone-control-card .button.primary")?.disabled === false)`), "Approve enabled");
    await page.evaluate(`document.querySelector(".phone-control-card .button.primary").click()`);
    await until(() => app.phoneControl.active()?.conversationId === id, "the session started");
    assert.equal(phone.banner?.apps, "Grab");

    // The live line: on a phone and a desktop.
    await until(async () => /Using this phone · Grab · 1[45] min left/.test(await text(".phone-control-line")), "the live line");
    await shot("phone-control-line-1280");
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await until(async () => (await text(".phone-control-line")) !== "", "the live line on a phone");
    await fits(".phone-control-line");
    await shot("phone-control-line-390");
    await page.evaluate(`document.querySelector(".phone-control-line .button").click()`);
    await until(() => app.phoneControl.active() === undefined, "stopped");
    await until(async () => (await text(".phone-control-line")) === "", "the line gone");
    assert.equal(phone.banner, undefined, "the banner is down");
});
