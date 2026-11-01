// Rank with Jev in a real browser (PP-312, the owner's mockup of 2026-11-01): Menu › Wiki's card with the app's dropdown
// of the Jev models OpenRouter offers and Off, a pick kept as wiki.rerankModel, the last search's outcome or failure on
// the card; and Pi's browser's run model as the same kind of dropdown, the session's own model or a listed Jev, saved
// when picked, with Test. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, home, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
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
let jevAnswers: "judge" | "402" = "judge";

// OpenRouter as the wiki and Pi's browser ask it: its decision models, and Jev's answers (every page 0.8).
const openRouter = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).startsWith("https://openrouter.ai/api/v1/models")) {
        return Response.json({
            data: [
                { id: "typesafe/jev-1.14", name: "TypeSafe: Jev 1.14", pricing: { prompt: "0.000000042" } },
                { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", pricing: { prompt: "0.000000042" } },
                { id: "~typesafe/jev-latest", name: "TypeSafe: Jev Latest", pricing: { prompt: "0.000000042" } },
                { id: "liquid/d1", name: "LiquidAI: d1", pricing: { prompt: "0.00000002" } },
            ],
        });
    }

    if (jevAnswers === "402") {
        return Response.json({ error: { message: "Insufficient credits" } }, { status: 402 });
    }

    const questions = (JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }).questions;

    return Response.json({ answers: Object.fromEntries(Object.keys(questions).map((name) => [name, { noul: 0.8 }])), usage: { cost: 0.00008, input_tokens: 300 } });
}) as typeof fetch;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const see = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** The texts of a dropdown's rows, once it is open. */
const rows = () =>
    inPage<string[]>(
        `return JSON.stringify([...document.querySelectorAll('.choice-menu .pop-menu-row .pop-menu-row-text')].map((row) => [...row.children].map((part) => part.textContent.trim()).join(" | ")))`,
    );

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

    app = await PocketApp.open({
        dataDir: join(root, "wiki-jev-ui-data"),
        defaultCwd: work,
        supervised: false,
        log: () => {},
        home,
        configureModels: (models) => models.registerNativeProvider(faux.provider),
        officecli: { runs: false },
        jev: { fetch: openRouter },
    });
    pastWelcome(app);
    await app.models.setRuntimeApiKey("openrouter", "or-test-key");
    await app.para.save("resources/office-printer", "---\ntitle: Office printer\npara: resources\nscope:\n  - global\ntags: []\n---\n\nThe printer is on the third floor.\n", true);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "wiki-jev-ui-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("Menu › Wiki › Rank with Jev: the Jev models OpenRouter offers and Off, a pick kept, the last search's outcome and failure", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=${encodeURIComponent("/?sheet=para:settings")}`);
    await see(`return JSON.stringify(document.querySelector('[data-part="wiki-rerank"] .choice') !== null)`, "the card's dropdown");
    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"]').scrollIntoView({ block: "center" }); return "true";`);

    const chosen = await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="wiki-rerank"] .choice-text').textContent.trim())`);

    assert.match(chosen, /TypeSafe: Jev 1\.14\s*typesafe\/jev-1\.14 · the default/);
    await shot("wiki-rerank-390.jpg");

    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"] .choice').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.choice-menu .pop-menu-row').length === 4)`, "Off and three Jev models");
    assert.deepEqual(await rows(), [
        "Off: the search's own order | by keyword and meaning scores",
        "TypeSafe: Jev 1.14 | typesafe/jev-1.14 · the default",
        "TypeSafe: Jev 1.13 | typesafe/jev-1.13",
        "TypeSafe: Jev Latest | ~typesafe/jev-latest · follows TypeSafe's newest",
    ]);
    await shot("wiki-rerank-dropdown-390.jpg");
    await page.evaluate(`[...document.querySelectorAll('.choice-menu .pop-menu-row')].find((row) => row.textContent.includes("Jev 1.13")).click(); return "true";`);
    await until(() => app.config.wikiRerankModel === "typesafe/jev-1.13", "kept as wiki.rerankModel");

    // A search with Jev, then one that fails: the card says how each went (read when the sheet opens again).
    await app.para.relevant("where is the office printer", work);
    await page.navigate(`${base}/?sheet=para:settings`);
    await see(`return JSON.stringify(/Last search \\(.*\\): \\d+ pages read, 1 kept, [\\d.]+ s, \\$0\\.00008\\./.test(document.querySelector('[data-part="wiki-rerank"]')?.textContent ?? ""))`, "the last search's outcome");
    jevAnswers = "402";
    await app.para.relevant("where is the office printer", work);
    jevAnswers = "judge";
    await page.navigate(`${base}/?sheet=para:settings`);
    await see(`return JSON.stringify(/Jev \\(typesafe\\/jev-1\\.13\\) failed: OpenRouter answered 402: Insufficient credits, so it kept the search's own order/.test(document.querySelector('[data-part="wiki-rerank"] .wiki-problem')?.textContent ?? ""))`, "the failure");
    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"]').scrollIntoView({ block: "center" }); return "true";`);
    await shot("wiki-rerank-failed-390.jpg");

    // Off, then back to the default.
    await page.evaluate(`document.querySelector('[data-part="wiki-rerank"] .choice').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.choice-menu .pop-menu-row').length === 4)`, "the list");
    await page.evaluate(`document.querySelector('.choice-menu .pop-menu-row').click(); return "true";`);
    await until(() => app.config.wikiRerankModel === null, "off");
    await app.setWikiRerankModel(owner(app), "default");
});

test("Pi's browser: the run model as the app's dropdown, the session's own model or a listed Jev, saved when picked, with Test", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/?sheet=browser`);
    await see(`return JSON.stringify(document.querySelector('[data-part="browser-run-every"] .choice') !== null)`, "the run model's dropdown");
    assert.match(await inPage<string>(`return JSON.stringify(document.querySelector('[data-part="browser-run-every"] .choice-text').textContent)`), /The session's own model/);

    await page.evaluate(`document.querySelector('[data-part="browser-run-every"] .choice').click(); return "true";`);
    await see(`return JSON.stringify(document.querySelectorAll('.choice-menu .pop-menu-row').length === 4)`, "the session's model and three Jev models");
    assert.deepEqual(await rows(), [
        "The session's own model | each session decides with its model",
        "TypeSafe: Jev 1.14 | typesafe/jev-1.14",
        "TypeSafe: Jev 1.13 | typesafe/jev-1.13",
        "TypeSafe: Jev Latest | ~typesafe/jev-latest",
    ]);
    await page.evaluate(`[...document.querySelectorAll('.choice-menu .pop-menu-row')].find((row) => row.textContent.includes("Jev 1.14")).click(); return "true";`);
    await until(() => app.config.browserRunModel === "typesafe/jev-1.14", "kept as browser.runModel");
    await see(`return JSON.stringify([...document.querySelectorAll('[data-part="browser-run-every"] button')].some((button) => button.textContent.trim() === "Test"))`, "Test for a Jev model");
    await shot("browser-run-model-390.jpg");

    // The alias is a Jev model too.
    await app.setBrowserRunModel(owner(app), "~typesafe/jev-latest");
    assert.equal(app.config.browserRunModel, "~typesafe/jev-latest");
    await app.setBrowserRunModel(owner(app), "session");
});
