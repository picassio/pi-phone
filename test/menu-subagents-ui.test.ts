// A session's subagents in its menu (PP-280, the owner's option B): the one at work first with a row of its own, the
// idle ones folded into one row that opens in place, so fourteen of them leave the session's own actions on a phone's
// screen. Nothing runs past it, on a phone or a desktop.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.MENU_SHOTS;
const IDLE = ["web-providers-a", "web-providers-b", "web-providers-c", "i18n-sheets-a", "i18n-sheets-b", "i18n-sheets-c", "i18n-web-d", "i18n-ext-projects", "i18n-ext-others", "i18n-gateway", "i18n-server", "i18n-docs", "i18n-check"];

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify(request);
    const { role, text } = lastText(request as never);
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent === "slow-build" && role !== "toolResult") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 60" })], { stopReason: "toolUse" });
    }

    if (subagent !== undefined) {
        return fauxAssistantMessage([fauxText(`${subagent}: done`)]);
    }

    if (text === "spread out") {
        return fauxAssistantMessage(
            [...IDLE, "slow-build"].map((name) => fauxToolCall("subagent", { action: "spawn", name, message: `Do ${name}.` })),
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const see = (script: string, what: string, timeoutMs?: number) => until(async () => (await inPage<boolean>(script)) === true, what, timeoutMs);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        // The group in view: the menu's other parts come first.
        await page.evaluate(`
            const group = document.querySelector('[data-part="menu-subagents"]');
            let box = group.parentElement;

            while (box !== null && !(box.scrollHeight > box.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(box).overflowY))) {
                box = box.parentElement;
            }

            if (box !== null) {
                box.scrollTop += group.getBoundingClientRect().top - box.getBoundingClientRect().top - 120;
            }

            return "true";
        `);
        const { mkdirSync, writeFileSync } = await import("node:fs");

        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** What runs past the screen's right edge in the sheet, or makes the page scroll sideways. */
const outside = () =>
    inPage<string[]>(`
        const out = [...document.querySelectorAll(".sheet *")].filter((each) => {
            const box = each.getBoundingClientRect();

            return box.width > 0 && box.right > innerWidth + 0.5;
        }).map((each) => each.className || each.tagName);

        return JSON.stringify(document.documentElement.scrollWidth > innerWidth + 1 ? [...out, "page scrolls sideways"] : out);
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel(route));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "menu-subagents-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("fourteen subagents: the one at work has its row, the idle fold into one that opens in place; the session's actions stay on screen", real, async () => {
    const id = await newSession(app);

    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${id}`);
    await see(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`, "the session");
    await app.commands.submit(id, owner(app), { text: "spread out", requestId: `spread-${id}` });
    await see(
        `const agents = (await import("/store.js")).store.state.view.subagents ?? [];
        return JSON.stringify(agents.length === 14 && agents.filter((each) => !each.busy).length === 13 && agents.some((each) => each.busy))`,
        "thirteen idle, one at work",
        30_000,
    );

    await page.evaluate(`(await import("/store.js")).openSheet({ type: "menu" }); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="menu-subagents"]') !== null)`, "the menu's subagents");

    const shown = await inPage<{ title: string; rows: string[]; fold: string; open: string | null }>(`
        const group = document.querySelector('[data-part="menu-subagents"]');
        const fold = group.querySelector('[data-part="idle-subagents"]');

        return JSON.stringify({
            title: group.querySelector(".group-title").textContent.trim(),
            rows: [...group.querySelectorAll(":scope > .list-item")].map((each) => each.textContent.replace(/\\s+/g, " ").trim()),
            fold: fold.textContent.replace(/\\s+/g, " ").trim(),
            open: fold.getAttribute("aria-expanded"),
        });
    `);

    assert.equal(shown.title, "Subagents · 14");
    assert.equal(shown.rows.length, 2, "the one at work, and the fold");
    assert.match(shown.rows[0]!, /^slow-build\s*working · /);
    assert.match(shown.fold, /^13 idle\s*Show$/);
    assert.equal(shown.open, "false");

    // Shut, the group is two rows high whatever the number of idle ones: the menu's other parts stay where they were.
    const height = await inPage<number>(`return JSON.stringify(document.querySelector('[data-part="menu-subagents"]').getBoundingClientRect().height)`);

    assert.ok(height < 180, `the subagents group is ${height}px high`);
    assert.deepEqual(await outside(), []);
    await shot("menu-subagents-390");

    // Open in place: thirteen rows under it, each with its state.
    await page.evaluate(`document.querySelector('[data-part="idle-subagents"]').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.sa-folded .list-item').length === 13)`, "thirteen idle rows");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="idle-subagents"]').getAttribute("aria-expanded"))`), "true");
    assert.ok((await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll('.sa-folded .list-item')].map((each) => each.textContent))`)).every((each) => /idle/.test(each)));
    assert.deepEqual(await outside(), []);
    await shot("menu-subagents-open-390");

    await page.setViewport(VIEWPORTS.desktop);
    assert.deepEqual(await outside(), []);
    await shot("menu-subagents-1280");
});
