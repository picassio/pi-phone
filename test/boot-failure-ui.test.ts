// The boot screen says "could not start" and why when a file of the app does not load (a content blocker, the network)
// or fails as it runs (PP-342, from pi-pocket #249), in the person's language; with every file there, the app starts.
// With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
/** What the server answers for one of the app's files now: blocked (403), broken (a module that throws), or as it is. */
let blocked: "none" | "blocked" | "broken" = "none";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

const boot = () =>
    inPage<{ caption: string; detail: string }>(
        `return JSON.stringify({ caption: document.querySelector(".boot.failed .boot-caption")?.textContent ?? "", detail: document.querySelector(".boot.failed .boot-detail")?.textContent ?? "" })`,
    );

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        // A module app.js imports, stopped as a content blocker would, or broken so it throws as it runs.
        if (request.url?.startsWith("/seen.js") && blocked === "blocked") {
            response.writeHead(403).end();

            return;
        }

        if (request.url?.startsWith("/seen.js") && blocked === "broken") {
            // Its exports are there (the app links), and it throws as it runs.
            const source = readFileSync(new URL("../web/seen.js", import.meta.url), "utf8");

            response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" }).end(`throw new Error("seen.js broke.");\n${source}`);

            return;
        }

        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "boot-failure-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(async () => (await inPage<string>(`return JSON.stringify(location.pathname)`).catch(() => "")) === "/", "signed in", 20_000);
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
    test(`at ${size} px, a file of the app that a blocker stops shows on the boot screen`, real, async () => {
        blocked = "blocked";
        await page.setViewport(viewport);
        await page.navigate(`${base}/?boot=${size}`, { wait: false });
        await until(async () => (await boot().catch(() => ({ caption: "", detail: "" }))).detail.includes("did not load"), "the boot screen to say a file did not load", 20_000);
        assert.equal((await boot()).caption, "could not start");
        assert.equal(await inPage<string>(`return JSON.stringify(getComputedStyle(document.querySelector(".boot-bar")).display)`), "none", "the bar stops");
        await shot(`boot-blocked-${size}`);
    });
}

test("a file that fails as it runs says why, in the person's language", real, async () => {
    blocked = "broken";
    await page.setViewport(VIEWPORTS.mobile);
    await inPage(`localStorage.setItem("pocket.language", "vi"); return "null";`);

    try {
        await page.navigate(`${base}/?boot=broken`, { wait: false });
        await until(async () => (await boot().catch(() => ({ caption: "", detail: "" }))).detail.includes("seen.js broke."), "the boot screen to say what failed", 20_000);
        assert.equal((await boot()).caption, "không khởi động được");
        assert.match((await boot()).detail, /^Một tệp của ứng dụng bị lỗi: .*seen\.js broke\. Tải lại để thử lại\.$/);
        await shot("boot-broken-vi-390");
    } finally {
        await inPage(`localStorage.removeItem("pocket.language"); return "null";`);
    }
});

test("with every file there, the app starts and the boot screen says nothing failed", real, async () => {
    blocked = "none";
    await page.navigate(`${base}/`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".boot") === null || document.querySelector(".boot.failed") === null && (await import("/store.js")).store.state.me?.role === "owner")`), "the app", 20_000);
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector(".boot.failed") !== null)`), false);
});
