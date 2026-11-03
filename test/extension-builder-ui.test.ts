// Extension builder's templates (PP-367) as drop-ins in a real browser, at a phone's width and a desktop's: each browser
// part loads without failing, draws its page or sheet with the app's pieces (states as a word and a dot, never a ✓ or
// ⚠), fits the screen, and works: the timer starts, a snippet is added, and an item added on the checklist's page shows
// there and in its data. With PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, home, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { BUILDER_TEMPLATES } from "../src/server/extension-builder.ts";
import { dropInApi } from "../src/server/extension-inspect.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const dataDir = join(root, "builder-ui-data");

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** What shows in `selector`: its text, its state tags as "label/tone", and whether the page is wider than the screen. */
const shown = (selector: string) =>
    inPage<{ text: string; tags: string[]; wide: boolean }>(
        `const box = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify({ text: box?.innerText ?? "", tags: [...(box?.querySelectorAll('[data-part="state-tag"]') ?? [])].map((tag) => tag.textContent.trim() + "/" + tag.className.replace("state-tag", "").trim()), wide: document.documentElement.scrollWidth > innerWidth })`,
    );

const see = (selector: string, text: string) =>
    until(async () => (await shown(selector)).text.includes(text), `${text} in ${selector}`, 30_000).catch(async (error: Error) => {
        throw new Error(`${error.message}; it shows: ${JSON.stringify((await shown(selector)).text.slice(0, 1000))}`);
    });

async function shot(name: string): Promise<void> {
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

    for (const name of ["focus-timer", "snippets", "checklist"]) {
        cpSync(join(BUILDER_TEMPLATES, name), join(dataDir, "extensions"), { recursive: true });
    }

    // A browser part that throws as it loads (PP-368: the tab tells the server), and one that tells its own route
    // which members `pocket` has in a real tab.
    writeFileSync(join(dataDir, "extensions", "broken-ui.ts"), `/** Broken: its browser part throws. */\nexport default (_host: unknown, web: { client(entry: string): void }) => {\n    web.client("broken-ui.js");\n};\n`);
    writeFileSync(join(dataDir, "extensions", "broken-ui.js"), `export default () => {\n    throw new Error("broken on purpose");\n};\n`);
    writeFileSync(
        join(dataDir, "extensions", "probe.ts"),
        `/** Probe: what pocket has, as a tab gives it. */\ntype Web = { route(method: string, path: string, handle: (request: { body: Record<string, unknown> }) => unknown): void; client(entry: string): void };\nexport default (_host: unknown, web: Web) => {\n    let keys: unknown = null;\n    web.route("POST", "keys", (request) => { keys = request.body.keys; return {}; });\n    web.route("GET", "keys", () => ({ keys }));\n    web.client("probe.js");\n};\n`,
    );
    writeFileSync(join(dataDir, "extensions", "probe.js"), `export default (pocket) => {\n    void pocket.api("keys", { keys: Object.keys(pocket) });\n};\n`);

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

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

    const owner = app.config.users.find((user) => user.role === "owner")!;

    for (const file of ["focus-timer.ts", "snippets.ts", "checklist.ts", "broken-ui.ts", "probe.ts"]) {
        await app.setExtensionEnabled(owner, file, true);
    }

    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "builder-ui-browser-")), load: async () => undefined, save: () => {} });
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

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    test(`the focus timer's page draws, fits and starts at ${size} px`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?page=focus-timer:focus`);
        await see(".ext-page", "Focus timer");
        await see(".ext-page", "Length");

        let now = await shown(".ext-page");

        assert.doesNotMatch(now.text, /failed|[✓⚠]/);
        assert.deepEqual(now.tags, ["Ready/off"]);
        assert.equal(now.wide, false, "fits the screen");
        await shot(`builder-focus-${size}.jpg`);

        await page.click({ selector: ".ext-page .button.primary" });
        await until(async () => (await shown(".ext-page")).tags.includes("Running/ok"), "running");
        await page.click({ selector: ".ext-page .button.primary" });
        await until(async () => (await shown(".ext-page")).tags.includes("Paused/warn"), "paused");
        await page.click({ selector: ".ext-page .button.ghost" });
        now = await shown(".ext-page");
        assert.deepEqual(now.tags, ["Ready/off"]);
    });

    test(`the snippets sheet draws, fits and keeps a snippet at ${size} px`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?sheet=snippets:snippets`);
        await see(".sheet", "New snippet");
        assert.equal((await shown(".sheet")).wide, false, "fits the screen");
        assert.doesNotMatch((await shown(".sheet")).text, /failed/);

        await page.type({ selector: ".sheet textarea" }, `Review this at ${size}`);
        await page.click({ selector: ".sheet form .button.primary" });
        await see(".sheet", `Review this at ${size}`);
        await shot(`builder-snippets-${size}.jpg`);
    });

    test(`the checklist's page draws, fits, and an item added there is in its data at ${size} px`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/?page=checklist:checklist`);
        await see(".ext-page", "New item");
        assert.equal((await shown(".ext-page")).wide, false, "fits the screen");

        await page.type({ selector: ".ext-page .ckl-add input" }, `Water the plants ${size}`);
        await page.click({ selector: ".ext-page .ckl-add .button.primary" });
        await see(".ext-page", `Water the plants ${size}`);

        const now = await shown(".ext-page");

        assert.ok(now.tags.includes("Open/off"), now.tags.join(", "));
        assert.doesNotMatch(now.text, /failed|[✓⚠]/);
        assert.ok(
            (JSON.parse(readFileSync(join(dataDir, "extension-data", "checklist", "items.json"), "utf8")) as { text: string }[]).some((item) => item.text === `Water the plants ${size}`),
        );
        // Its stylesheet loaded: a row is laid out as a row.
        assert.equal(await inPage<string>(`return JSON.stringify(getComputedStyle(document.querySelector(".ckl-row")).display)`), "flex");
        await shot(`builder-checklist-${size}.jpg`);
    });
}

test("a tab tells the server what a drop-in's browser part added, and a failure, for extension_inspect; pocket has the members it lists (PP-368)", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/`);
    await until(() => app.webs.reports("checklist.ts").ready !== undefined, "the checklist's report", 30_000);
    const none = { dock: [], overlay: [], panelTab: [], sessionMenu: [] };

    assert.deepEqual((app.webs.reports("checklist.ts").ready as { adds: unknown }).adds, { rail: ["checklist"], menu: [], launcher: [], page: ["checklist"], sheet: [], ...none });
    assert.deepEqual((app.webs.reports("snippets.ts").ready as { adds: unknown }).adds, { rail: [], menu: ["snippets"], launcher: ["insert"], page: [], sheet: ["snippets"], ...none });
    await until(() => app.webs.reports("broken-ui.ts").failed !== undefined, "the broken one's failure", 30_000);

    const failed = app.webs.reports("broken-ui.ts").failed as { how: string; error: string };

    assert.equal(failed.how, "failed to load");
    assert.equal(failed.error, "broken on purpose");

    const keys = () =>
        fetch(`${base}/api/x/probe/keys`, { headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" } }).then(
            async (response) => ((await response.json()) as { keys: string[] | null }).keys,
        );

    await until(async () => (await keys()) !== null, "the probe's keys", 30_000);
    assert.deepEqual(await keys(), dropInApi().members, "extension_inspect lists the members a tab gives");
});
