// /make and /page in a real browser (PP-428): both in the "/" list with their descriptions; /make alone stays in the box
// with an example and sends nothing; /make with words goes to Pi and shows as typed; /page alone opens Settings › Pages;
// with the Extension builder off, /make leaves the list. With PHONE_SHOTS, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, context, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { BUILDER_MODULE } from "../src/server/extension-builder.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const BOX = ".composer textarea";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; the page: ${await page.evaluate(`return JSON.stringify(document.body.innerText.slice(-1500))`)}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** The "/" list as it shows: each row's name and description. */
const listed = () =>
    inPage<{ name: string; description: string }[]>(`return JSON.stringify([...document.querySelectorAll(".commands .command")].map((row) => ({
        name: row.querySelector(".command-name").textContent,
        description: row.querySelector(".command-description").textContent,
    })))`);

/** The session open afresh at `viewport`, its message box there. */
async function open(viewport: Viewport): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(session)}`);
    await see(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}) !== null)`, "the message box");
}

/** How many messages went to Pi in the session. */
async function messages(): Promise<number> {
    const entries = await (await app.harness.conversation(session, context))!.entries({}, 50, undefined, context);

    return entries.items.filter((entry) => entry.kind === "pi.user").length;
}

before(async () => {
    if (real.skip !== false) {
        return;
    }

    app = await openApp(scriptedModel(), join(root, "creator-commands-ui-data"));
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "creator-commands-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent(`/s/${Number(session)}`)}`);
});

after(() =>
    cleanUpAll(
        () => browsers?.closeAll({ final: true }),
        () => server?.closeAllConnections(),
        () => server?.close(),
        () => app?.close(),
        () => cleanUp(),
    ),
);

test('/make and /page are in the "/" list; /make alone stays in the box unsent; /make with words shows as typed; /page alone opens Pages', real, async () => {
    for (const [viewport, width] of [[VIEWPORTS.desktop, 1280], [VIEWPORTS.mobile, 390]] as const) {
        await open(viewport);
        await page.type({ selector: BOX }, "/");
        await see(`return JSON.stringify(document.querySelector(".commands .command") !== null)`, "the command list");

        const rows = await listed();

        assert.deepEqual(rows.find((row) => row.name === "/make"), { name: "/make", description: "Pi makes a drop-in extension for the app: a tool, a rail page, a sheet" });
        assert.deepEqual(rows.find((row) => row.name === "/page"), { name: "/page", description: "Pi builds an artifact and offers to keep it as a page on your rail" });
        await page.evaluate(`[...document.querySelectorAll(".commands .command")].find((row) => row.querySelector(".command-name").textContent === "/make").scrollIntoView({ block: "center" }); return "true";`);
        await shot(`slash-list-${width}.png`);
    }

    // Alone, /make stays in the box with an example, and nothing goes to Pi.
    await page.type({ selector: BOX }, "/make");
    await page.press("Enter");
    await see(`return JSON.stringify(document.querySelector(${JSON.stringify(BOX)}).value === "/make ")`, "/make left in the box");
    await see(`return JSON.stringify(document.body.innerText.includes("Say what to make, such as /make a pomodoro timer in the side rail."))`, "the example");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector(".command-hint")?.textContent ?? "")`), /\/make\s*<what>.*sent to Pi/);
    await shot("make-alone-390.png");
    assert.equal(await messages(), 0, "nothing was sent");

    // With words, it goes to Pi, and shows as typed: the request the server added stays out of sight.
    await page.type({ selector: BOX }, "/make a pomodoro timer in the side rail");
    await page.press("Enter");
    await until(async () => (await messages()) === 1, "the message sent", 20_000);
    await see(`return JSON.stringify(document.body.innerText.includes("/make a pomodoro timer in the side rail"))`, "the message as typed");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.body.innerText.includes("make-request"))`), false);

    // Alone, /page opens Settings › Pages.
    await page.type({ selector: BOX }, "/page");
    await page.press("Enter");
    await see(`return JSON.stringify([...document.querySelectorAll(".sheet .sheet-head h2")].some((each) => each.textContent.trim() === "Pages"))`, "the Pages sheet");
    assert.equal(await messages(), 1, "/page alone sent nothing");
});

test("with the Extension builder off, /make leaves the list and /page stays", real, async () => {
    await app.setExtensionEnabled(owner(app), BUILDER_MODULE, false);

    try {
        await open(VIEWPORTS.mobile);
        await page.type({ selector: BOX }, "/");
        await see(`return JSON.stringify(document.querySelector(".commands .command") !== null)`, "the command list");

        const names = (await listed()).map((row) => row.name);

        assert.equal(names.includes("/make"), false);
        assert.equal(names.includes("/page"), true);
    } finally {
        await app.setExtensionEnabled(owner(app), BUILDER_MODULE, true);
    }
});
