// Menu › Videos in a real browser (PP-297): the models that watch videos through OpenRouter, Automatic first with the
// default it means, each with its price; a tap picks one, as the setting video.askModel keeps it. With PHONE_SHOTS,
// screenshots go there.
import { type App, cleanUp, home, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
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

const stub = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
        response.end(
            JSON.stringify({
                data: [
                    { id: "google/gemini-3.5-flash-lite", name: "Google: Gemini 3.5 Flash-Lite", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.0000003" } },
                    { id: "google/gemini-3.8-flash", name: "Google: Gemini 3.8 Flash", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.00000075" } },
                    { id: "google/gemini-4-argon", name: "Google: Gemini 4 Argon", architecture: { input_modalities: ["text", "video"] }, pricing: { prompt: "0.000002" } },
                ],
            }),
        );
    });
});

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const faux = scriptedModel();

    app = await PocketApp.open({
        dataDir: join(root, "videos-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        videos: { endpoints: { openRouter: `http://127.0.0.1:${(stub.address() as AddressInfo).port}/api/v1` } },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "videos-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    stub.close();
    await app?.close();
    cleanUp();
});

test("Menu › Videos lists Automatic and the models that watch videos with their price; a tap picks one; the menu names it", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "videos" }); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="video-ask-model"]').length === 4)`, "Automatic and three models");

    const rows = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('[data-part="video-ask-model"]')].map((row) => [...row.querySelectorAll(".ds-text > span")].map((line) => line.textContent.replace(/\\s+/g, " ").trim()).join(" | ")))`);

    assert.deepEqual(rows, [
        "Automatic | Now google/gemini-3.5-flash-lite",
        "Google: Gemini 3.5 Flash-Lite | google/gemini-3.5-flash-lite · $0.30/M in",
        "Google: Gemini 3.8 Flash | google/gemini-3.8-flash · $0.75/M in",
        "Google: Gemini 4 Argon | google/gemini-4-argon · $2/M in",
    ]);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, "videos-390.jpg"), Buffer.from((await page.screenshot()).data, "base64"));
    }

    await page.evaluate(`document.querySelector('[data-model="google/gemini-3.8-flash"]').click(); return "true";`);
    await until(() => app.config.videoAskModel === "google/gemini-3.8-flash", "the choice kept");
    await see(`return JSON.stringify(document.querySelector('[data-model="google/gemini-3.8-flash"]').getAttribute("aria-pressed") === "true")`, "the row marked");
    await app.setVideoAskModel(owner(app), null);
});
