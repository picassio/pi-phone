// Wiki settings' Capture model, picked with the app's model picker (PP-409), in a real browser at 390 and 1280 px:
// every account's models with their plan figures (one at its weekly limit says so, and when it resets), "The default
// model for new sessions" first, no thinking level; a pick is saved and Wiki settings comes back with it; closing without
// a pick changes nothing. With PHONE_SHOTS, screenshots and the layout check's report go there.
import { type App, cleanUp, cleanUpAll, home, pastWelcome, root, work } from "./helpers.ts";
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
import { fakeAnthropic, localAnthropic, MODEL_ID, signIns } from "./support/fake-anthropic.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

let provider: Awaited<ReturnType<typeof fakeAnthropic>>;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
const weekReset = Date.now() + 3 * 86_400_000;

/** Claude's usage endpoint: the default account is at its weekly limit; Work has room. */
const usageFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const token = String(new Headers(init?.headers).get("authorization") ?? "").replace(/^Bearer /, "");
    const full = token === "tok-default";

    return Response.json({
        five_hour: { utilization: full ? 12 : 18, resets_at: new Date(Date.now() + 3_600_000).toISOString() },
        seven_day: { utilization: full ? 100 : 31, resets_at: new Date(weekReset).toISOString() },
    });
}) as typeof fetch;

before(async () => {
    if (real.skip) {
        return;
    }

    provider = await fakeAnthropic(() => ({ text: "ok" }));

    const agent = join(root, "agent");

    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "auth.json"), signIns({ anthropic: "tok-default", "anthropic~work": "tok-work" }));
    app = await PocketApp.open({
        dataDir: join(root, "capture-picker-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(localAnthropic(provider.url)),
        accountProviders: { anthropic: () => localAnthropic(provider.url) },
        usageFetch,
        officecli: { runs: false },
    });
    pastWelcome(app);
    app.accounts.add("anthropic", "Work");
    app.providers.modelsChanged();
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "capture-picker-")), load: async () => undefined, save: () => {} });
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
        () => provider?.close(),
        () => cleanUp(),
    ),
);

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
const present = (selector: string, what: string) =>
    until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) !== null)`), what).catch(async (error: Error) => {
        throw new Error(`${error.message}; on screen: ${await page.evaluate(`return JSON.stringify((document.querySelector(".sheet, .pop-menu")?.innerText ?? "(no sheet)").slice(0, 300))`)}`);
    });
const gone = (selector: string, what: string) => until(() => inPage<boolean>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)}) === null)`), what);
/** Where an element is now, to wait for a sheet that rises in to stop moving. */
const rect = (selector: string) => page.evaluate(`const box = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect(); return JSON.stringify(box ? [box.x, box.y, box.width, box.height] : null);`);

/** A real click (the browser's input, as a person's) on what the selector finds, once it stands still. */
async function click(selector: string): Promise<void> {
    let last = "";

    await until(async () => {
        const now = await rect(selector);
        const still = now !== "null" && now === last;

        last = now;
        await new Promise((resolve) => setTimeout(resolve, 100));

        return still;
    }, `${selector} standing still`);
    await page.click({ selector });
}

/** The capture model's field in Wiki settings: what it shows. */
const field = () => inPage<string>(`return JSON.stringify(document.querySelector('[data-part="wiki-capture-model"] .choice-text').innerText.trim().split(/\\s*\\n\\s*/).join(" | "))`);

/** The open picker: its title, its rows' names and lines, the row checked, and whether it has a thinking level. */
const picker = () =>
    inPage<{ title: string; rows: string[]; current: string; thinking: boolean; providers: boolean }>(`
        const menu = document.querySelector(".model-menu");
        return JSON.stringify({
            title: menu.getAttribute("aria-label"),
            rows: [...menu.querySelectorAll(".pop-menu-row")].map((row) => row.innerText.trim().split(/\\s*\\n\\s*/).join(" | ")),
            current: menu.querySelector('.pop-menu-row[aria-selected="true"]')?.innerText.trim().split(/\\s*\\n\\s*/)[0] ?? "",
            thinking: menu.querySelector(".model-levels") !== null,
            providers: menu.querySelector(".pop-menu-link") !== null,
        });
    `);

/** A picture and the layout check's report, with PHONE_SHOTS. */
async function shot(name: string, width: number): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const report = parseLayout(JSON.parse(await page.evaluate(`return JSON.stringify(${layoutCheck(width)})`)), width);

    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    writeFileSync(join(SHOTS, `${name}.layout.txt`), `${report === undefined ? "no report" : describeLayout(report)}\nRAW ${JSON.stringify(report?.found ?? [])}\n`);
}

for (const [viewport, label] of [[VIEWPORTS.mobile, "390"], [VIEWPORTS.desktop, "1280"]] as const) {
    test(`at ${label} px: Capture model opens the model picker with every account's figures, and a pick is saved (PP-409)`, real, async () => {
        await app.para.updateSettings({ captureModel: "auto" });
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=para:settings`);
        await present('[data-part="wiki-capture-model"] .choice', "the capture model's field");
        assert.equal(await field(), "The default model for new sessions");
        await shot(`wiki-settings-${label}`, viewport.width);

        await click('[data-part="wiki-capture-model"] .choice');
        await present(".model-menu", "the model picker");
        await until(async () => (await picker()).rows.some((row) => /wk 100%/.test(row)), "the accounts' plan figures");

        const open = await picker();
        const defaultRow = open.rows.find((row) => row.startsWith("Claude Test | anthropic") && /wk 100%/.test(row));
        const workRow = open.rows.find((row) => /Work account/.test(row));

        assert.equal(open.title, "Capture model");
        assert.equal(open.rows[0], "The default model for new sessions", "the default entry first");
        assert.equal(open.current, "The default model for new sessions", "the one chosen now is checked");
        assert.ok(defaultRow && /resets /.test(defaultRow), `the account at its weekly limit says when it resets: ${JSON.stringify(open.rows)}`);
        assert.ok(workRow && /5h 18% · wk 31%/.test(workRow) && !/resets/.test(workRow), `the Work account's figures: ${JSON.stringify(open.rows)}`);
        assert.equal(open.thinking, false, "no thinking level for the capture model");
        assert.equal(open.providers, false, "no way out to Providers, which Wiki settings coming back would close");
        await shot(`capture-picker-${label}`, viewport.width);

        // Closed without a pick: nothing changes, and Wiki settings comes back.
        await page.press("Escape");
        await gone(".model-menu", "the picker closed");
        await present('[data-part="wiki-capture-model"] .choice', "Wiki settings back");
        assert.equal((await app.para.settings()).captureModel, "auto");

        // The Work account's model: saved as that account's, shown in the field.
        await click('[data-part="wiki-capture-model"] .choice');
        await present(".model-menu", "the model picker again");
        await until(async () => (await picker()).rows.some((row) => /Work account/.test(row)), "the Work account");
        await click(`.model-menu [data-value="anthropic~work/${MODEL_ID}"]`);
        await until(async () => (await app.para.settings()).captureModel === `anthropic~work/${MODEL_ID}`, "the pick saved");
        await present('[data-part="wiki-capture-model"] .choice', "Wiki settings back with the pick");
        await until(async () => (await field()) === `Claude Test | anthropic~work/${MODEL_ID}`, "the field shows the pick");

        // And back to the default entry.
        await click('[data-part="wiki-capture-model"] .choice');
        await present(".model-menu", "the model picker a third time");
        assert.equal((await picker()).current, "Claude Test");
        await click('.model-menu [data-part="model-pick-entry"]');
        await until(async () => (await app.para.settings()).captureModel === "auto", "the default again");
    });
}
