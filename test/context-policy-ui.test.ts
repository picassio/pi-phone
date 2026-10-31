// What goes into the prompt, in a real browser (PP-276): Menu › Compact context shows this session's choices and every
// session's, and a change reaches the session; a message the wiki's pages came with shows only the person's words, and
// its menu has the pages, folded until asked for (the owner's option C). Nothing runs past a phone's screen.
import { type App, cleanUp, context, home, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
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
const SHOTS = process.env.CONTEXT_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

async function open(id: number, size: keyof typeof VIEWPORTS): Promise<void> {
    await page.setViewport(VIEWPORTS[size]);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`, "signed in");
    await page.evaluate(`(await import("/store.js")).navigate(${id}); return "true";`);
    await see(`return JSON.stringify((await import("/store.js")).store.state.view.agent?.cwd !== undefined)`, "the session");
}

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        const { mkdirSync, writeFileSync } = await import("node:fs");

        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** What runs past the screen's right edge, or makes the page scroll sideways. */
const outside = () =>
    inPage<string[]>(`
        const out = [...document.querySelectorAll(".sheet *, .user-msg *, .attachments *")].filter((each) => {
            const box = each.getBoundingClientRect();

            return box.width > 0 && box.right > innerWidth + 0.5;
        }).map((each) => each.className || each.tagName);

        return JSON.stringify(document.documentElement.scrollWidth > innerWidth + 1 ? [...out, "page scrolls sideways"] : out);
    `);

before(async () => {
    if (chromium === undefined) {
        return;
    }

    const faux = scriptedModel();

    app = await PocketApp.open({
        dataDir: join(root, "context-ui-data"),
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "context-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("a message the wiki's pages came with shows only the person's words, its menu the pages; Compact context sets what the prompt holds", real, async () => {
    app.config.lastModel ??= { provider: "faux", modelId: "faux-1", thinkingLevel: "off" };
    await app.para.save(
        "resources/terminal-reattach",
        "---\ntitle: Terminal reattach\npara: resources\nscope:\n  - work\ntags:\n  - terminal\n---\n\nA shell outlives its socket for fifteen minutes.\n",
        true,
    );
    // The search index has the page (it is updated after a write, not during it).
    await until(async () => (await app.para.searchKeywords("socket")).some((each) => each.path === "resources/terminal-reattach"), "the page in the search index", 15_000);

    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    // The pages come with messages only where the owner picked it (the default is tool: Pi searches itself).
    await app.setContextPart(owner(app), "wiki", "relevant", id);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "why does the shell outlive its socket", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await open(Number(id), "mobile");
    await see(`return JSON.stringify(document.querySelector('[data-part="prompt"] .user-text')?.textContent.includes("why does the shell outlive its socket") === true)`, "the message");

    // The message holds the person's words alone: no page, by name or by text.
    const bubble = await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="prompt-row"]').textContent)`);

    assert.doesNotMatch(bubble, /terminal-reattach|wiki-pages|outlives its socket for fifteen/);
    assert.deepEqual(await outside(), []);
    await shot("context-message-390");

    // Its menu: what Pi got with it, folded; open, the page, which opens in the Wiki page.
    await page.evaluate(`document.querySelector('[data-part="prompt"]').click(); return "true";`);
    await see(`return JSON.stringify([...document.querySelectorAll(".sheet .list-item")].some((each) => each.textContent.includes("What Pi got with this message (1)")))`, "the menu's item");
    assert.equal(await inPage<number>(`return JSON.stringify(document.querySelectorAll('[data-part="wiki-came"]').length)`), 0, "folded");
    await page.evaluate(`[...document.querySelectorAll(".sheet .list-item")].find((each) => each.textContent.includes("What Pi got")).click(); return "true";`);
    await see(`return JSON.stringify(document.querySelector('[data-part="wiki-came"]')?.getAttribute("href") === "#wiki:resources%2Fterminal-reattach")`, "the page, as a link to the Wiki page");
    assert.deepEqual(await outside(), []);
    await shot("context-message-menu-390");
    await page.evaluate(`(await import("/store.js")).closeSheet(); return "true";`);

    // Menu › Compact context: this session's choices (as every session's) and every session's.
    await page.evaluate(`(await import("/store.js")).openSheet({ type: "compact" }); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll(".pp-row select").length === 6)`, "three parts, twice");

    const values = await inPage<string[]>(`return JSON.stringify([...document.querySelectorAll(".pp-row select")].map((each) => each.value))`);

    assert.deepEqual(values, ["relevant", "inherit", "inherit", "tool", "tool", "frozen"]);
    assert.deepEqual(await outside(), []);
    await shot("context-sheet-390");

    await page.evaluate(`
        const select = document.querySelector(".pp-row select");
        select.value = "inherit";
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return "true";
    `);
    await until(() => app.contextPolicy(id).wiki === "tool", "this session's wiki as every session's");
    assert.equal(app.config.contextPolicy.wiki, undefined, "every session's as it was");

    await page.setViewport(VIEWPORTS.desktop);
    await shot("context-sheet-1280");
});
