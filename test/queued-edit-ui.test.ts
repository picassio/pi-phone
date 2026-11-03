// Edit on one's own queued message in a real browser (PP-344, from pi-pocket #194): the row has Edit, which takes the
// message back into the message box with its files, and it leaves the queue. With PHONE_SHOTS set to a folder,
// screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
/** "stream a long answer" streams for about 20 s at the scripted model's 2000 tokens a second; the rest echo. */
const route: FauxResponseStep = (request) => {
    const { text } = lastText(request as never);

    return fauxAssistantMessage([fauxText(text.includes("stream a long answer") ? "word ".repeat(40_000) : `echo: ${text}`)]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(route));
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "queued-edit-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
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

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    test(`at ${size} px, Edit takes your queued message back into the message box with its file`, real, async () => {
        const id = await newSession(app);
        const path = join(app.workspace.uploadDirectory(id), "lzx-1234abcd-notes.txt");

        writeFileSync(path, "abc");

        try {
            await page.setViewport(viewport);
            await page.navigate(`${base}/s/${id}`);
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="composer"] textarea') !== null)`), "the session", 20_000);
            await app.commands.submit(id, owner(app), { text: "stream a long answer", requestId: `long-${size}` });
            await until(() => app.isBusy(id), "the run to start");
            await app.commands.submit(id, owner(app), {
                text: "then check the tests\nand the build",
                attachments: [{ path, name: "notes.txt", mime: "text/plain", size: 3 }],
                mode: "followUp",
                requestId: `queued-${size}`,
            });
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="queued-edit"]') !== null)`), "Edit on the queued row", 20_000);
            await shot(`queued-edit-${size}`);

            await page.click({ selector: '[data-part="queued-edit"]' });
            await until(
                async () => (await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="composer"] textarea').value)`)) === "then check the tests\nand the build",
                "the words in the box",
            );
            assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="composer"] .chip-name')?.textContent ?? "")`), "notes.txt", "its file attached");
            await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".inbox") === null)`), "it left the queue");
            await shot(`queued-edited-${size}`);
        } finally {
            await app.commands.abort(id, owner(app));
        }
    });
}
