// Removing a drop-in from Settings › Extensions (PP-372), in a real browser at a phone's width and a desktop's: each
// drop-in has Remove, which asks in its own row first (what goes, a switch for its data), and Remove there takes it
// away: gone from the list and from the drop-in folder, its data in extension-data kept unless switched on. With
// PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, home, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const dataDir = join(root, "remove-ui-data");
const dropIns = join(dataDir, "extensions");
const kept = join(dataDir, "extension-data");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const seen = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what, 30_000);

/** The row of the drop-in `file` in the Extensions sheet, by its file line. */
const row = (file: string) => `[...document.querySelectorAll(".sheet .extension")].find((each) => each.innerText.includes(${JSON.stringify(file)}))`;

/** Tap the button `label` in the drop-in's row, once it is still and in view. */
async function tap(file: string, label: string): Promise<void> {
    for (let tries = 0; tries < 20; tries++) {
        const box = await inPage<{ x: number; y: number; on: boolean } | null>(
            `const button = [...(${row(file)})?.querySelectorAll("button") ?? []].find((each) => each.innerText.trim() === ${JSON.stringify(label)}); if (!button) return "null"; button.scrollIntoView({ block: "center" }); await new Promise((done) => setTimeout(done, 200)); const box = button.getBoundingClientRect(); const x = Math.round(box.left + box.width / 2); const y = Math.round(box.top + box.height / 2); return JSON.stringify({ x, y, on: document.elementFromPoint(x, y)?.closest("button") === button })`,
        );

        if (box?.on === true) {
            await page.input([{ type: "click", x: box.x, y: box.y }]);

            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error(`${label} in ${file}'s row never stayed in view to be tapped`);
}

async function shot(name: string): Promise<void> {
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.documentElement.scrollWidth > innerWidth)`), false, `${name}: nothing wider than the screen`);

    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

before(async () => {
    if (real.skip !== false) {
        return;
    }

    for (const name of ["water", "lamp"]) {
        mkdirSync(join(dropIns, name), { recursive: true });
        writeFileSync(join(dropIns, `${name}.ts`), `/** ${name}: a drop-in to remove. */\nexport default () => undefined;\n`);
        writeFileSync(join(dropIns, `${name}.js`), "export default () => {};\n");
        mkdirSync(join(kept, name), { recursive: true });
        writeFileSync(join(kept, name, "state.json"), "{}");
    }

    const faux = scriptedModel();

    app = await PocketApp.open({
        dataDir,
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "remove-ui-browser-")), load: async () => undefined, save: () => {} });
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

for (const [size, viewport, name, data] of [
    ["390", VIEWPORTS.mobile, "water", false],
    ["1280", VIEWPORTS.desktop, "lamp", true],
] as const) {
    test(`at ${size} px: Remove asks in the drop-in's row, then takes ${name} away${data ? " with its data" : ", its data kept"}`, real, async () => {
        const file = `${name}.ts`;

        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=extensions`);
        await seen(`return JSON.stringify((${row(file)}) !== undefined)`, `${file}'s row`);
        assert.equal(await inPage<boolean>(`return JSON.stringify((${row("artifacts.ts")})?.querySelector('[data-part="extension-remove-button"]') == null)`), true, "built-in modules have no Remove");

        await tap(file, "Remove");
        await seen(`return JSON.stringify((${row(file)})?.querySelector('[data-part="extension-remove"]')?.innerText.includes("Its data in extension-data stays.") === true)`, "the confirm");

        if (data) {
            await page.evaluate(`(${row(file)}).querySelector('[data-part="extension-remove"] .switch').click(); return "null"`);
            await seen(`return JSON.stringify((${row(file)})?.querySelector('[data-part="extension-remove"]')?.innerText.includes("goes too") === true)`, "its data goes too");
        }

        await page.evaluate(`(${row(file)}).querySelector('[data-part="extension-remove"]').scrollIntoView({ block: "center" }); return "null"`);
        assert.match(await inPage<string>(`return JSON.stringify((${row(file)}).querySelector('[data-part="extension-remove"]').innerText)`), new RegExp(`its files go: ${name}\\.ts, ${name}\\.js, ${name}/`));
        await shot(`remove-confirm-${size}.jpg`);
        // The confirm's own Remove: the last of the row's buttons by that name.
        await tap(file, "Remove");
        await seen(`return JSON.stringify((${row(file)}) === undefined)`, `${file} gone from the list`);
        await until(() => !existsSync(join(dropIns, file)) && !existsSync(join(dropIns, `${name}.js`)) && !existsSync(join(dropIns, name)), "its files gone");
        assert.equal(existsSync(join(kept, name, "state.json")), !data);
        await shot(`remove-done-${size}.jpg`);
    });
}
