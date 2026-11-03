// Favorite models in a real Chromium (PP-350): a star in Providers › Favorite models, and the model picker's Favorites
// filter with the star on the row. At phone size first; with PHONE_SHOTS, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const exists = (selector: string) => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`);
const present = (selector: string, what: string) => until(() => exists(selector), what);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "null";`);
const shot = async (name: string) => {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
};

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "model-favorites-ui-")), load: async () => undefined, save: () => {} });
    session = await newSession(app);
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(async () => await exists(".model-chip"), "the session's model chip", 20_000);
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

test("a model starred in Providers comes first in the picker, and alone under Favorites", real, async () => {
    await page.evaluate(`import("/store.js").then((module) => module.openSheet({ type: "providers" })); return "null";`);
    await present(`[data-part="favorite-models"] .list-item`, "Favorite models in Providers");
    await click(`[data-part="favorite-models"] .list-item`);
    await present(`[data-model="faux/faux-2"] [data-part="model-favorite"]`, "the models with their stars");
    await click(`[data-model="faux/faux-2"] [data-part="model-favorite"]`);
    await until(() => (owner(app).favoriteModels ?? []).includes("faux/faux-2"), "the star kept for the person");
    await present(`[data-model="faux/faux-2"] [data-part="model-favorite"][aria-pressed="true"]`, "the star on");
    await inPage(`document.querySelector('[data-part="favorite-models"]').scrollIntoView({ block: "start" }); return "null";`);
    await shot("favorites-providers-390.jpg");
    await page.evaluate(`import("/store.js").then((module) => module.closeSheet()); return "null";`);
    await until(async () => !(await exists(`[data-part="favorite-models"]`)), "Providers closed");

    // The picker: the starred model right after the current one, with its star, and the Favorites filter.
    await click(".model-chip");
    await present(`[data-part="model-filters"]`, "the Favorites filter");
    const names = () => inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".model-menu .pop-menu-row")].map((row) => row.getAttribute("title").split(" ")[0] + (row.querySelector(".model-star") ? " *" : "")))`);

    assert.deepEqual((await names()).slice(0, 2), ["faux/faux-1", "faux/faux-2 *"]);
    await page.evaluate(`[...document.querySelectorAll('[data-part="model-filters"] button')].at(-1).click(); return "null";`);
    await until(async () => (await names()).length === 1, "only the favorite");
    assert.deepEqual(await names(), ["faux/faux-2 *"]);
    await shot("favorites-picker-390.jpg");
    await page.setViewport(VIEWPORTS.desktop);
    await page.evaluate(`import("/store.js").then((module) => module.closeSheet()); return "null";`);
    await new Promise((resolve) => setTimeout(resolve, 300));
    await click(".model-chip");
    await present(`[data-part="model-filters"]`, "the Favorites filter at 1280");
    await shot("favorites-picker-1280.jpg");
    await page.setViewport(VIEWPORTS.mobile);
    app.setModelFavorites(owner(app), []);
});
