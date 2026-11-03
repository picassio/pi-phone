// Keep as a page in a real browser (PP-370), at a phone's 390 px and a desktop's 1280 px: an artifact's card in the chat
// keeps it, its page shows on the rail (the drawer's on a phone), opens in the artifacts' sandbox, and a tap on the
// page's own button puts its text into the session's message box through the bridge, the page closing; Settings › Pages
// lists it and removes it from the rail. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, context, home, lastText, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const QUESTION = "What does page 3 say?";
/** The artifact: a reader whose button, the whole top of the page, puts a question into the message box. */
const READER = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:16px system-ui,sans-serif;background:#f4f1ea;color:#222}#ask{display:block;width:100%;height:160px;border:0;background:#2e6fd8;color:#fff;font-size:20px}p{padding:16px}</style></head><body><button id="ask" onclick="parent.postMessage({ type: 'pi-compose', text: ${JSON.stringify(QUESTION).replace(/"/g, "&quot;")} }, '*')">Ask Pi about page 3</button><p>Paper reader: a kept page.</p></body></html>`;

const route: FauxResponseStep = (ctx) => {
    const { role, text } = lastText(ctx as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("Published the reader.")]);
    }

    if (text.includes("make the reader")) {
        return fauxAssistantMessage([fauxToolCall("artifact", { id: "paper-reader", title: "Paper reader", content: READER })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what, 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}; the page shows: ${(await inPage<string>("return JSON.stringify(document.body.innerText.slice(0, 1500))")).replace(/\s+/g, " ")}`);
    });

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(route);

    app = await PocketApp.open({
        dataDir: join(root, "kept-pages-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
    });
    pastWelcome(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "kept-pages-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
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

test("Keep as a page: kept from the chat's card, on the rail, opened in the sandbox, its text into the message box, removed in Settings › Pages, at 390 and 1280 px (PP-370)", real, async () => {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    const { id } = await app.commands.createSession(owner(app), { cwd: work });
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "make the reader", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const key = `${id}/paper-reader`;
    const button = `document.querySelector('[data-part="kept-pages"] [data-page="${key}"]')`;
    // How many times the message box holds the page's question.
    const asked = `(document.querySelector('[data-part="composer"] textarea')?.value ?? "").split(${JSON.stringify(QUESTION)}).length - 1`;

    for (const size of ["mobile", "desktop"] as const) {
        const width = VIEWPORTS[size].width;
        const phone = size === "mobile";

        await page.setViewport(VIEWPORTS[size]);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
        await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
        await page.evaluate(`(await import("/store.js")).navigate(${id}); return "true";`);
        await see(`return JSON.stringify(document.querySelector('[data-part="keep-page"]') !== null)`, "Keep as a page on the artifact's card");
        await page.evaluate(`document.querySelector('[data-part="keep-page"]').scrollIntoView({ block: "center" }); return "true";`);
        await shot(`pages-card-${width}`);

        // The viewer offers it too.
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "viewer", id: "paper-reader", version: 1 }); return "true";`);
        await see(`return JSON.stringify(document.querySelector('.viewer-head [data-part="keep-page"]') !== null)`, "Keep as a page in the viewer");
        await shot(`pages-viewer-${width}`);
        await page.evaluate(`(await import("/store.js")).closeSheet(); return "true";`);
        await see(`return JSON.stringify(document.querySelector('.viewer') === null)`, "the viewer closed");

        // Kept from the card: the server has it, the card says so, and the rail has its button.
        await page.evaluate(`document.querySelector('[data-part="keep-page"]').click(); return "true";`);
        await until(async () => (await app.keptPages.list(owner(app))).pages.length === 1, "kept on the server");
        await see(`return JSON.stringify(document.querySelector('[data-part="kept-page-state"]')?.textContent.includes("Kept as a page") === true)`, "the card says it is kept");

        if (phone) {
            await page.evaluate(`(await import("/store.js")).store.set({ drawer: true }); return "true";`);
        }

        await see(`return JSON.stringify(${button}?.getAttribute("title") === "Paper reader")`, "the page's button on the rail");
        assert.equal(await inPage<string>(`return JSON.stringify(${button}.querySelector("svg path") !== null ? "line icon" : "none")`), "line icon");
        await shot(`pages-rail-${width}`);

        // Opened from the rail: the artifact in the sandbox, at its newest version, the drawer closed.
        const before = await inPage<number>(`return JSON.stringify(${asked})`);

        await page.evaluate(`${button}.click(); return "true";`);
        await see(`return JSON.stringify(document.querySelector('[data-part="kept-page"] iframe')?.getAttribute("src") === "a/${id}/paper-reader/1")`, "the page, at version 1");
        const frame = await inPage<{ sandbox: string; x: number; y: number; title: string }>(`
            const frame = document.querySelector('[data-part="kept-page"] iframe');
            const box = frame.getBoundingClientRect();
            return JSON.stringify({ sandbox: frame.getAttribute("sandbox"), x: box.left + box.width / 2, y: box.top + 60, title: document.querySelector('[data-part="kept-page"] h2').textContent });`);

        assert.equal(frame.title, "Paper reader");
        assert.ok(!frame.sandbox.includes("allow-same-origin"), "no way into the app's origin");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await shot(`pages-page-${width}`);

        // The page's own button: its text goes into the message box (once more than the draft had it), and the page closes.
        if (phone) {
            await page.tap({ x: frame.x, y: frame.y });
        } else {
            await page.click({ x: frame.x, y: frame.y });
        }

        await see(`return JSON.stringify(${asked} === ${before + 1})`, "the question in the message box");
        assert.equal(await inPage<boolean>(`return JSON.stringify((await import("/store.js")).store.state.page === null)`), true, "the page closed");
        await shot(`pages-compose-${width}`);

        // Settings › Pages: listed, then removed from the rail.
        await page.evaluate(`(await import("/store.js")).openSheet({ type: "pages" }); return "true";`);
        await see(`return JSON.stringify(document.querySelector('[data-part="kept-pages-list"] [data-page="${key}"]')?.textContent.includes("Paper reader") === true)`, "the page in Settings › Pages");
        await shot(`pages-settings-${width}`);
        await page.evaluate(`document.querySelector('[data-part="kept-pages-list"] [data-page="${key}"] [data-part="unkeep-page"]').click(); return "true";`);
        await until(async () => (await app.keptPages.list(owner(app))).pages.length === 0, "removed on the server");
        await see(`return JSON.stringify(document.querySelector('[data-part="kept-pages-list"]') === null)`, "gone from the sheet");

        if (phone) {
            await page.evaluate(`(await import("/store.js")).store.set({ sheet: null, drawer: true }); return "true";`);
        }

        await see(`return JSON.stringify(document.querySelector('[data-part="rail"]') !== null && ${button} === null)`, "gone from the rail");
        await see(`return JSON.stringify(document.querySelector('[data-part="keep-page"]') !== null)`, "the card offers Keep as a page again");
    }
});
