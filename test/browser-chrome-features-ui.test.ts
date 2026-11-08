// Settings › Pi's browser › Chrome on machines in a real browser (PP-454): the Chrome features field, read from
// browser.chromeFeatures, saved with Save (off until the names change), said saved; a bad name shows the server's error
// and changes nothing. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, home, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
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

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

    app = await PocketApp.open({
        dataDir: join(root, "browser-chrome-features-ui-data"),
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "browser-chrome-features-ui-browser-")), load: async () => undefined, save: () => {} });
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

/** The row: the field's value, whether Save is off, and what it says. */
const row = () =>
    inPage<{ value: string; disabled: boolean; text: string } | null>(`
        const row = document.querySelector('[data-part=browser-chrome-features]');
        return JSON.stringify(row ? { value: row.querySelector('input').value, disabled: row.querySelector('button').disabled, text: row.innerText } : null);`);

/** Type into the field as a person does. */
const type = (value: string) =>
    page.evaluate(`
        const input = document.querySelector('[data-part=browser-chrome-features] input');
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return "true";`);

async function shot(name: string, width: number): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(`document.querySelector('[data-part=browser-chrome-features]').scrollIntoView({ block: "center" }); return "true";`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}-${width}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

for (const [width, viewport] of [
    [390, VIEWPORTS.mobile],
    [1280, VIEWPORTS.desktop],
] as const) {
    test(`Pi's browser › Chrome on machines at ${width} px: none at first, Save off until the names change, saved as browser.chromeFeatures and said; a bad name refused (PP-454)`, real, async () => {
        await app.setBrowserChromeFeatures(owner(app), "none");
        await page.setViewport(viewport);
        await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent("/?sheet=browser")}`);
        await until(async () => (await row()) !== null, "the Chrome features row", 30_000);

        const first = (await row())!;

        assert.equal(first.value, "");
        assert.equal(first.disabled, true, "nothing to save");
        assert.match(first.text, /Chrome features/);
        assert.match(first.text, /--enable-features/);
        await shot("browser-chrome-features", width);

        await type("CanvasDrawElement");
        await until(async () => (await row())?.disabled === false, "Save on");
        await page.evaluate(`document.querySelector('[data-part=browser-chrome-features] button').click(); return "true";`);
        await until(() => app.config.browserChromeFeatures.join(",") === "CanvasDrawElement", "kept as browser.chromeFeatures");
        await until(async () => (await row())?.text.includes("Saved.") === true, "said saved");
        assert.equal((await row())!.disabled, true);
        await shot("browser-chrome-features-saved", width);

        await type("Canvas-Draw");
        await page.evaluate(`document.querySelector('[data-part=browser-chrome-features] button').click(); return "true";`);
        await until(async () => (await inPage<string>("return JSON.stringify(document.body.innerText)")).includes("only letters, digits and underscores"), "the server's error shown");
        assert.deepEqual(app.config.browserChromeFeatures, ["CanvasDrawElement"], "unchanged");
    });
}
