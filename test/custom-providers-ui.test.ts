// OpenAI-compatible providers in a real browser (PP-248, picassio/pi-phone#4): Providers › Add an OpenAI-compatible
// provider, a name and a base URL, no key, Find models against a local stub of the API, two ticked and one's context
// window typed, Save; the models reach the tab's model list; Edit opens the form with what was saved; Remove takes it
// out. On a phone the form stays inside the sheet. With PROVIDER_SHOTS set to a folder, screenshots at 390 and 1280 px
// go there (provider-custom-*.jpg).
import { type App, cleanUp, home, pastWelcome, root, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PROVIDER_SHOTS;
const file = join(root, "agent", "models.json");

let app: App;
let server: Server;
let stub: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let api = "";

before(async () => {
    if (real.skip) {
        return;
    }

    stub = createServer((request, response) => {
        if (request.url === "/v1/models") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify({
                    data: [
                        { id: "qwen3-coder-30b-a3b-instruct", context_length: 262144, supported_parameters: ["reasoning"] },
                        { id: "gemma-3-27b-it", architecture: { input_modalities: ["text", "image"] } },
                        { id: "text-embedding-nomic-embed-text-v1.5" },
                    ],
                }),
            );

            return;
        }

        response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    api = `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`;
    mkdirSync(join(root, "agent"), { recursive: true });
    writeFileSync(file, JSON.stringify({ providers: { mine: { baseUrl: "http://127.0.0.1:9/v1", api: "anthropic-messages", apiKey: "literal-of-mine", models: [{ id: "m" }] } } }));
    app = await PocketApp.open({ dataDir: join(root, "custom-ui-data"), defaultCwd: work, supervised: false, log: () => {}, home, officecli: { runs: false } });
    pastWelcome(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "custom-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    stub?.close();
    await app?.close();
    rmSync(file, { force: true });
    cleanUp();
});

async function until(check: () => Promise<boolean> | boolean, what: string, timeoutMs = 20_000): Promise<void> {
    const started = Date.now();

    while (!(await check())) {
        if (Date.now() - started > timeoutMs) {
            // What the part of the sheet showed, and its fields' values: enough to see why.
            const shown = await page
                .evaluate(`return JSON.stringify({ text: document.querySelector(".custom-providers")?.innerText ?? "(no part)", values: [...document.querySelectorAll(".custom-providers input")].map((each) => each.value) })`)
                .catch((error: unknown) => String(error));

            throw new Error(`Timed out waiting for ${what}: ${shown.slice(0, 1500)}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;
const text = (selector: string) => inPage<string>(`return JSON.stringify(document.querySelector(${JSON.stringify(selector)})?.innerText ?? "")`);
const count = (selector: string) => inPage<number>(`return JSON.stringify(document.querySelectorAll(${JSON.stringify(selector)}).length)`);
/** Click the first button under `scope` whose text is `label`. */
const press = (scope: string, label: string) =>
    inPage<boolean>(`
        const button = [...document.querySelectorAll(${JSON.stringify(`${scope} button`)})].find((each) => each.innerText.trim() === ${JSON.stringify(label)});

        button?.click();

        return JSON.stringify(button !== undefined);
    `);
/**
 * Type into a field as a person does (the browser's own text input), focused by script rather than by a tap at its
 * place: the sheet may still be moving (it scrolls the form into view), and a tap there could land on the next field.
 */
async function typeInto(selector: string, value: string): Promise<void> {
    assert.ok(await inPage<boolean>(`const field = document.querySelector(${JSON.stringify(selector)}); field?.focus(); return JSON.stringify(document.activeElement === field && field !== null)`), selector);
    await page.type(undefined, value);
}

/** Click an element by script (a checkbox, a button), for the same reason. */
const tap = (selector: string) => inPage<boolean>(`const found = document.querySelector(${JSON.stringify(selector)}); found?.click(); return JSON.stringify(found !== null)`);

/** What of the form sticks out of the screen, or makes the sheet scroll sideways: none, on a phone. */
const outside = () =>
    inPage<string[]>(`
        const out = [...document.querySelectorAll(".custom-providers *")].filter((each) => {
            const box = each.getBoundingClientRect();

            return box.width > 0 && (box.left < -0.5 || box.right > innerWidth + 0.5);
        }).map((each) => each.className || each.tagName);
        const sheet = document.querySelector(".custom-providers").closest(".sheet-body, .sheet, [role=dialog]");

        return JSON.stringify(sheet !== null && sheet.scrollWidth > sheet.clientWidth + 1 ? [...out, "sheet scrolls sideways"] : out);
    `);

/** The screen as it is, with `at` scrolled to the top of the sheet first. */
async function shot(name: string, at: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await page.evaluate(`document.querySelector(${JSON.stringify(at)})?.scrollIntoView({ block: "start" }); return "1"`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

test("add a provider with Find models, see its models in the pickers, edit it and remove it, at 390 and 1280 px", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/`);
    await inPage(`const { openSheet } = await import("/store.js"); openSheet({ type: "providers" }); return "1"`);
    await until(async () => /OpenAI-compatible providers/.test(await text(".custom-providers")), "the part of the sheet");
    await shot("provider-custom-empty-390", ".custom-providers");

    assert.ok(await press(".custom-providers", "Add an OpenAI-compatible provider"));
    await until(async () => (await count(".cp-form")) === 1, "the form");
    await typeInto('.cp-form input[aria-label="Provider\'s name"]', "LM Studio");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('.cp-form input[aria-label="Provider\\'s id"]').value)`), "lm-studio");
    await typeInto('.cp-form input[aria-label="Base URL"]', "ftp://nope");
    await until(async () => /starts with http:\/\/ or https:\/\//.test(await text(".cp-form")), "the address hint");
    await typeInto('.cp-form input[aria-label="Base URL"]', api);
    assert.ok(await press(".cp-form .segmented", "No key"));
    assert.ok(await press(".cp-form .cp-find", "Find models"));
    await until(async () => (await count(".cp-found .subagent-model")) === 3, "the server's models");
    assert.match(await text(".cp-found"), /qwen3-coder-30b-a3b-instruct\s+262,144 context · reasoning/);

    // Two ticked; the second's context window typed; one typed by hand and taken off again.
    assert.ok(await tap(".cp-found .subagent-model:nth-child(2) input"));
    assert.ok(await tap(".cp-found .subagent-model:nth-child(1) input"));
    await until(async () => (await count(".cp-model")) === 2, "two models chosen");
    await typeInto('.cp-model:nth-child(3) input[aria-label="Context window"]', "131072");
    await typeInto('.cp-form input[aria-label="A model\'s id"]', "typed-model");
    assert.ok(await press(".cp-typed", "Add"));
    await until(async () => (await count(".cp-model")) === 3, "the typed model");
    assert.ok(await tap('.cp-model:nth-child(4) button[aria-label="Remove typed-model"]'));
    await until(async () => (await count(".cp-model")) === 2, "the typed model off");
    assert.deepEqual(await outside(), [], "the form stays inside the phone's screen");
    await shot("provider-custom-form-390", ".cp-form");
    await shot("provider-custom-models-390", ".cp-find");

    assert.ok(await press(".cp-form .sheet-actions", "Save"));
    await until(async () => (await count(".cp-form")) === 0 && /LM Studio/.test(await text(".custom-providers .sheet-list")), "the saved provider");
    assert.match(await text(".custom-providers .sheet-list"), /LM Studio\s*✓[\s\S]*127\.0\.0\.1[\s\S]*no key · 2 models/);
    // In the order ticked: the found list is by id, so qwen3 (second) first, then gemma with the typed window.
    assert.deepEqual(app.customProviders.get("lm-studio").models, [
        { id: "qwen3-coder-30b-a3b-instruct", contextWindow: 262144, images: false, reasoning: true },
        { id: "gemma-3-27b-it", contextWindow: 131072, images: true, reasoning: false },
    ]);
    // The tab's model list (every picker's) has them.
    await until(
        async () =>
            await inPage<boolean>(`const { store } = await import("/store.js"); return JSON.stringify(store.state.models.filter((model) => model.provider === "lm-studio").length === 2)`),
        "the models in the pickers",
    );
    // The provider is not listed again among Pi's own.
    assert.doesNotMatch(await text(".sheet-list:not(.custom-providers .sheet-list)"), /LM Studio/);
    await shot("provider-custom-list-390", ".custom-providers");

    await page.setViewport(VIEWPORTS.desktop);
    await shot("provider-custom-list-1280", ".custom-providers");
    assert.ok(await press(".custom-providers .sheet-list", "Edit"));
    await until(async () => (await count(".cp-form .cp-model")) === 2, "the form with what was saved");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector('.cp-form input[aria-label="Base URL"]').value)`), api);
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector(".cp-form .segmented button.on").innerText.trim())`), "As it is");
    // Find models again with the key as it is: the saved ones ticked.
    assert.ok(await press(".cp-form .cp-find", "Find models"));
    await until(async () => (await count(".cp-found .subagent-model input:checked")) === 2, "the saved models ticked");
    await shot("provider-custom-form-1280", ".cp-form");
    await shot("provider-custom-models-1280", ".cp-find");
    assert.ok(await press(".cp-form .sheet-actions", "Cancel"));

    await inPage(`window.confirm = () => true; return "1"`);
    assert.ok(await press(".custom-providers .sheet-list", "Remove"));
    await until(async () => (await count(".custom-providers .sheet-list")) === 0, "the provider gone");
    assert.equal(app.customProviders.list().length, 0);
    assert.equal(app.models.getModel("lm-studio", "gemma-3-27b-it"), undefined);
});
