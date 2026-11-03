// Opening a file that is already shown reads it again, in the sheet and in the Files tile (PP-340, from pi-pocket #187):
// the text on screen is the file's current text, not the text of the first read. With PHONE_SHOTS set to a folder,
// screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { type Viewport, VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const notes = join(work, "reopen-notes.txt");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string, timeoutMs = 10_000) =>
    until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

/** Wait until the open viewer's lines say `text`. */
const shows = (text: string) =>
    see(`return JSON.stringify(document.querySelector(".file-view")?.textContent.includes(${JSON.stringify(text)}) === true)`, `the viewer to show ${text}`);

const open = () => inPage(`(await import("/ui.js")).openFile(${JSON.stringify(notes)}); return "null";`);

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

/** A session page at the given size. */
async function opened(viewport: Viewport): Promise<void> {
    const id = await newSession(app);

    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session", 20_000);
}

before(async () => {
    if (real.skip) {
        return;
    }

    mkdirSync(work, { recursive: true });
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])));
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "file-reopen-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in", 20_000);
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

test("at 390 px, opening the file that the sheet shows reads it again", real, async () => {
    writeFileSync(notes, "first text\n");
    await opened(VIEWPORTS.mobile);
    await open();
    await shows("first text");

    writeFileSync(notes, "second text\n");
    await open();
    await shows("second text");
    await shot("file-reopen-sheet-390");
});

test("at 1280 px, opening the file that the Files tile shows reads it again", real, async () => {
    writeFileSync(notes, "tile first\n");
    await opened(VIEWPORTS.desktop);
    await inPage(`(await import("/files-panel.js")).setFilesOpen(true, "files"); return "null";`);
    await see(`return JSON.stringify(document.querySelector(".ft-view, .files-panel, .ft-row") !== null)`, "the tile");
    await open();
    await shows("tile first");

    writeFileSync(notes, "tile second\n");
    await open();
    await shows("tile second");
    assert.equal(await inPage(`return JSON.stringify(document.querySelectorAll(".file-view").length)`), 1);
    await shot("file-reopen-tile-1280");
});
