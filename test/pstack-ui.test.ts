// pstack commands (PP-550) in Settings › Extensions: its row, off by default, with its title and description, at a
// phone's, a desktop's and a large screen's width. The layout check finds nothing that must be fixed in the row.
// PHONE_SHOTS=<dir> saves each picture and the layout check's words, for the report's counts.
import { type App, cleanUp, cleanUpAll, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { describeLayout, layoutCheck, parseLayout } from "../src/server/layout-check.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const LARGE = { width: 1920, height: 1080, scale: 1, mobile: false };
/** The kinds the ui-verify skill must bring to zero. */
const MUST_FIX = ["cut", "covered", "contrast", "small-text", "emoji", "small-target", "nested-cards", "spill"];

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const ROW = `[...document.querySelectorAll(".sheet .extension")].find((each) => each.querySelector(".extension-title")?.innerText.startsWith("pstack commands"))`;

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(), join(root, "pstack-ui-data"));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "pstack-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
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

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"], [LARGE, "1920"]] as const) {
    test(`at ${label} px: Extensions lists pstack commands, off, with its description, and nothing to fix in its row`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=extensions`);
        await until(() => inPage<boolean>(`return JSON.stringify(document.querySelectorAll(".sheet .extension").length > 10)`), "the extensions");
        // The row in view, for the check and the picture.
        await page.evaluate(`(${ROW})?.scrollIntoView({ block: "center" }); return "null"`);
        await new Promise((resolve) => setTimeout(resolve, 600));

        const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(viewport.width)})`)), viewport.width);

        assert.ok(report !== undefined, "the layout check answered");

        const counts = Object.fromEntries(MUST_FIX.map((kind) => [kind, report.found.filter((each) => each.kind === kind).length]));

        if (SHOTS !== undefined) {
            mkdirSync(SHOTS, { recursive: true });
            writeFileSync(join(SHOTS, `pstack-extensions-${label}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
            writeFileSync(join(SHOTS, `pstack-extensions-${label}.layout.txt`), `${describeLayout(report)}\nCOUNTS ${JSON.stringify(counts)}\nRAW ${JSON.stringify(report.found)}\n`);
        }

        const row = await inPage<{ off: boolean; text: string } | null>(`const row = ${ROW}; return JSON.stringify(row === undefined ? null : { off: row.classList.contains("off"), text: row.innerText })`);

        assert.ok(row !== null, "the row");
        assert.equal(row.off, true, "off by default");
        assert.match(row.text, /Slash commands from pstack: \/interrogate, \/blast-radius, \/ketchup, \/reflect, \/correct, \/why, \/how, \/teach and more\./);
        // What the check found in the row: none of the kinds that must be fixed.
        assert.deepEqual(report.found.filter((each) => MUST_FIX.includes(each.kind) && /pstack/.test(each.what)), [], describeLayout(report));
    });
}
