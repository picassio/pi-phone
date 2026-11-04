// The subagents' model and thinking in a real browser (PP-281): Menu › Subagents sets every session's model with the
// session's model picker (PP-410: its own choices first, no thinking level there, the sheet back after) and its thinking
// with the app's dropdown, and the models Pi may also use are added several at once from a dropdown that ticks, and
// taken off one by one; a session's own sheet sets its own over them. Nothing runs past a phone's screen or a desktop's.
import { type App, cleanUp, cleanUpAll, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.SUBAGENT_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);
const click = (selector: string) => page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); return "true";`);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        const { mkdirSync, writeFileSync } = await import("node:fs");

        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** What runs past the screen's right edge, in the sheet or a dropdown, or makes the page scroll sideways. */
const outside = () =>
    inPage<string[]>(`
        const out = [...document.querySelectorAll(".sheet *, .choice-menu *")].filter((each) => {
            const box = each.getBoundingClientRect();

            return box.width > 0 && (box.right > innerWidth + 0.5 || box.left < -0.5);
        }).map((each) => each.className || each.tagName);

        return JSON.stringify(document.documentElement.scrollWidth > innerWidth + 1 ? [...out, "page scrolls sideways"] : out);
    `);

/** The open model picker: its title, its rows (name, then its line), the row checked, and whether it has a thinking level. */
const picker = () =>
    inPage<{ title: string; rows: string[]; current: string; thinking: boolean }>(`
        const menu = document.querySelector(".model-menu");
        return JSON.stringify({
            title: menu.getAttribute("aria-label"),
            rows: [...menu.querySelectorAll(".pop-menu-row")].map((row) => row.querySelector(".pop-menu-row-name").textContent.trim()),
            current: menu.querySelector('.pop-menu-row[aria-selected="true"] .pop-menu-row-name')?.textContent.trim() ?? "",
            thinking: menu.querySelector(".model-levels") !== null,
        });
    `);

/** Open the subagents' model in the model picker (PP-410), check what it offers first, pick `option`, and see the sheet back. */
async function chooseModel(option: string, first: string[], current: string): Promise<void> {
    await click('[data-part="subagent-model"] .choice');
    await see(`return JSON.stringify(document.querySelector(".model-menu .pop-menu-row") !== null)`, "the model picker");

    const open = await picker();

    assert.equal(open.title, "Subagents' model");
    assert.deepEqual(open.rows.slice(0, first.length), first, "the sheet's own choices first");
    assert.equal(open.current, current, "the one chosen now is checked");
    assert.ok(open.rows.includes(option), JSON.stringify(open.rows));
    assert.equal(open.thinking, false, "the thinking level stays the sheet's");
    assert.deepEqual(await outside(), []);
    await shot(`subagents-picker-${first.length > 1 ? "own" : "every"}-${await inPage<number>("return JSON.stringify(innerWidth)")}`);
    await page.evaluate(`[...document.querySelectorAll(".model-menu .pop-menu-row")].find((each) => each.querySelector(".pop-menu-row-name").textContent.trim() === ${JSON.stringify(option)}).click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector(".model-menu") === null && document.querySelector('[data-part="subagent-model"] .choice') !== null)`, "the sheet back");
}

/** Pick `option` (its text) in the Choice of the row `part`. */
async function choose(part: string, option: string): Promise<void> {
    await click(`[data-part="${part}"] .choice`);
    await see(`return JSON.stringify(document.querySelectorAll('.choice-menu [role="option"]').length > 0)`, `${part}'s options`);
    await page.evaluate(`[...document.querySelectorAll('.choice-menu [role="option"]')].find((each) => each.querySelector(".pop-menu-row-name").textContent.trim() === ${JSON.stringify(option)}).click(); return "true";`);
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "subagent-settings-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
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

test("Menu › Subagents: every session's model and thinking, and models added several at once, taken off one by one", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "subagent-settings" }); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="subagent-model"] .choice') !== null)`, "the sheet");

    // The app's own dropdowns, each at the session's own.
    assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll(".sheet select").length)`), 0);
    assert.deepEqual(
        await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".pp-row .choice-text > span:first-child")].map((each) => each.textContent.trim()))`),
        ["The session's own", "The session's own"],
    );

    await chooseModel("faux-2", ["The session's own"], "The session's own");
    await until(() => app.config.subagentDefaults.model === "faux/faux-2", "every session's model");
    await see(`return JSON.stringify(document.querySelector('[data-part="subagent-model"] .choice-text > span').textContent.trim() === "faux-2")`, "the sheet shows faux-2");
    await choose("subagent-thinking", "Low");
    await until(() => app.config.subagentDefaults.thinking === "low", "every session's thinking");
    assert.deepEqual(await outside(), []);
    await shot("subagents-sheet-390");

    // Add two at once: ticked in the dropdown, then Add 2.
    await click(".sam-add .choice");
    await see(`return JSON.stringify(document.querySelectorAll(".multi-choice .mc-row").length === 3)`, "the models to tick");
    await page.evaluate(`
        for (const value of ["faux/faux-1", "faux/faux-vision"]) {
            document.querySelector(\`.multi-choice .mc-row[data-value="\${value}"]\`).click();
        }
        return "true";
    `);
    await see(`return JSON.stringify(document.querySelector('[data-part="multi-add"]').textContent.trim() === "Add 2")`, "Add 2");
    assert.deepEqual(await outside(), []);
    await shot("subagents-add-390");
    await click('[data-part="multi-add"]');
    await until(() => app.config.subagentModels.length === 2, "two allowed");
    assert.deepEqual([...app.config.subagentModels].sort(), ["faux/faux-1", "faux/faux-vision"]);
    await see(`return JSON.stringify(document.querySelectorAll('[data-part="allowed-model"]').length === 2)`, "a row each");

    // One taken off by its X.
    await click('[data-part="allowed-model"][data-model="faux/faux-1"] .icon-button');
    await until(() => app.config.subagentModels.length === 1, "one left");
    assert.deepEqual([...app.config.subagentModels], ["faux/faux-vision"]);

    await page.setViewport(VIEWPORTS.desktop);
    assert.deepEqual(await outside(), []);
    await shot("subagents-sheet-1280");
    // At a desktop's width too, and back to the session's own: the value it keeps is "session", as before.
    await chooseModel("The session's own", ["The session's own"], "faux-2");
    await until(() => app.config.subagentDefaults.model === undefined || app.config.subagentDefaults.model === "session", "every session's model: the session's own");
});

test("a session's own: As every session first, then its own model over every session's", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session");
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "subagent-settings", own: true }); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="subagent-model"] .choice') !== null)`, "the session's sheet");
    assert.deepEqual(
        await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".pp-row .choice-text > span:first-child")].map((each) => each.textContent.trim()))`),
        ["As every session", "As every session"],
    );
    assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll('[data-part="subagent-allowed"]').length)`), 0, "the list is every session's");

    await chooseModel("faux-1", ["As every session", "The session's own"], "As every session");
    await until(() => app.sessionMeta(id)?.subagentDefaults?.model === "faux/faux-1", "its own model");
    assert.equal(app.subagentDefaults(id).model, "faux/faux-1");
    assert.equal(app.subagentDefaults(id).thinking, app.config.subagentDefaults.thinking, "its thinking: every session's");
    assert.deepEqual(await outside(), []);
    await shot("subagents-own-390");
});
