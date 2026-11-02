// Settings › Pi's browser › Scripts in a real browser (PP-244): browser_eval's On / Off, read from browser.eval, saved
// when tapped, with what each means. With PHONE_SHOTS, screenshots go there.
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

const see = (script: string, what: string) =>
    until(async () => (await inPage<boolean>(script)) === true, what, 30_000).catch(async (error: unknown) => {
        throw new Error(`${String(error)}; the page shows: ${(await inPage<string>("return JSON.stringify(document.body.innerText.slice(0, 1500))")).replace(/\s+/g, " ")}`);
    });

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

    app = await PocketApp.open({
        dataDir: join(root, "browser-eval-ui-data"),
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "browser-eval-ui-browser-")), load: async () => undefined, save: () => {} });
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

/** The Scripts row: its title, what it says, and which of its buttons is on. */
const scriptsRow = () =>
    inPage<{ title: string; detail: string; on: string[] } | null>(`
        const row = [...document.querySelectorAll('.setting-row')].find((each) => each.querySelector('.setting-text span')?.textContent.trim() === "Scripts that read the page");
        return JSON.stringify(row ? { title: row.querySelector('.setting-text span').textContent.trim(), detail: row.querySelectorAll('.setting-text span')[1].textContent.trim(), on: [...row.querySelectorAll('.segmented button.on')].map((button) => button.textContent.trim()) } : null);`);

test("Pi's browser › Scripts: browser_eval On by default, Off saved as browser.eval when tapped and said in the row, On again (PP-244)", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent("/?sheet=browser")}`);
    await see(`return JSON.stringify([...document.querySelectorAll('.label')].some((label) => label.textContent.trim() === "Scripts"))`, "the Scripts section");
    await until(async () => (await scriptsRow()) !== null, "the Scripts row");

    const first = (await scriptsRow())!;

    assert.deepEqual(first.on, ["On"]);
    assert.match(first.detail, /no cookies, storage or network/);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        await page.evaluate(`document.querySelector('.sheet-body, .sheet')?.scrollTo?.(0, 100000); [...document.querySelectorAll('*')].forEach((each) => { if (each.scrollHeight > each.clientHeight + 4) each.scrollTop = each.scrollHeight; }); return "true";`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        writeFileSync(join(SHOTS, "browser-eval-390.jpg"), Buffer.from((await page.screenshot()).data, "base64"));
    }

    await page.evaluate(`[...document.querySelectorAll('.setting-row')].find((each) => each.textContent.includes("Scripts that read the page")).querySelectorAll('.segmented button')[1].click(); return "true";`);
    await until(() => app.config.browserEval === false, "kept as browser.eval off");
    await until(async () => (await scriptsRow())?.on[0] === "Off", "the row shows Off");
    assert.match((await scriptsRow())!.detail, /browser_eval refuses/);

    app.setBrowserEval(owner(app), true);
    assert.equal(app.config.browserEval, true);
});
