// Five more places for a drop-in's browser part (PP-371; the owner's OK of 2026-11-03 on the mockup pp371-mockup), in a
// real browser at a phone's width and a desktop's: a dock above the message box (at most two modules', the newest
// loaded), an overlay dragged anywhere and kept there, a tab in the side panel, a row in a session's menu that gets the
// session's id, and colours over the app's (the newest loaded module's win). Safe mode (?noext=1) shows none of them,
// and turning the module off takes them away. extension_inspect says whose dock waits and whose colour lost. With
// PHONE_SHOTS, screenshots go there.
import { type App, cleanUp, cleanUpAll, home, newSession, owner, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
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
import { inspect } from "../src/server/extension-inspect.ts";
import { createHandler } from "../src/server/http.ts";

const { PocketApp } = await import("../src/server/app.ts");

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const dataDir = join(root, "places-ui-data");
const dropIns = join(dataDir, "extensions");

/** A drop-in whose server part only names its browser part. */
function dropIn(name: string, summary: string, browser: string): void {
    writeFileSync(
        join(dropIns, `${name}.ts`),
        `/** ${summary} */\nexport const pocketApi = 2;\nexport default (_host: unknown, web: { client(entry: string): void }) => {\n    web.client("${name}.js");\n};\n`,
    );
    writeFileSync(join(dropIns, `${name}.js`), `export const pocketApi = 2;\nexport default (pocket) => {\n    const { html } = pocket;\n${browser}\n};\n`);
}

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session = 0;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

/** Wait until what `selector` finds has stopped moving: a panel slides in, and a tap during that lands elsewhere. */
const still = (selector: string) =>
    seen(
        `const box = document.querySelector(${JSON.stringify(selector)}); return JSON.stringify(box !== null && box.getAnimations({ subtree: true }).every((each) => each.playState !== "running") && document.getAnimations().every((each) => each.playState !== "running" || !box.contains(each.effect?.target ?? null)))`,
        `${selector} still`,
    );

const seen = (script: string, what: string) => until(async () => (await inPage<boolean>(script)) === true, what, 30_000);

async function shot(name: string): Promise<void> {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 500));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
}

/** What the places show now in the page. */
const places = () =>
    inPage<{
        docks: string[];
        overlay: { text: string; left: number; top: number; bottom: number } | null;
        composerTop: number;
        panelButton: boolean;
        accent: string;
        bg: string;
        wide: boolean;
    }>(`
        const overlay = document.querySelector('[data-part="extension-overlay"]');
        const box = overlay?.getBoundingClientRect();
        const style = getComputedStyle(document.documentElement);
        return JSON.stringify({
            docks: [...document.querySelectorAll('[data-part="extension-docks"] .ext-dock')].map((dock) => dock.innerText.trim()),
            overlay: overlay ? { text: overlay.innerText, left: Math.round(box.left), top: Math.round(box.top), bottom: Math.round(box.bottom) } : null,
            composerTop: Math.round(document.querySelector(".composer-wrap")?.getBoundingClientRect().top ?? 0),
            panelButton: document.querySelector('[data-part="extension-panel-button"]') !== null,
            accent: style.getPropertyValue("--accent").trim(),
            bg: style.getPropertyValue("--o-bg").trim(),
            wide: document.documentElement.scrollWidth > innerWidth,
        });
    `);

before(async () => {
    if (real.skip !== false) {
        return;
    }

    mkdirSync(dropIns, { recursive: true });
    // Loaded in this order (by name): a-older's dock is the third, and waits; z-newer's colour wins over places'.
    dropIn("a-older", "An older dock.", `    pocket.dock({ id: "older", sessions: (id) => typeof id === "number", component: () => html\`<span>Older dock</span>\` });`);
    dropIn(
        "places",
        "Every new place at once.",
        `    pocket.dock({ id: "status", component: ({ sessionId }) => html\`<span>Places dock in \${sessionId}</span>\` });
    pocket.overlay({ id: "float", title: "Places overlay", component: () => html\`<p>Floating over the app</p>\` });
    pocket.panelTab({ id: "notes", title: "Places notes", icon: "file", component: ({ sessionId }) => html\`<p>Notes for \${sessionId}</p>\` });
    pocket.sessionMenu({ id: "stamp", label: "Places stamp", hint: "this session", run: (id) => { window.placesStamped = id; } });
    pocket.theme({ "--accent": "rgb(200, 0, 120)", "--o-bg": "rgb(16, 32, 48)" });`,
    );
    dropIn(
        "z-newer",
        "A newer dock and accent.",
        `    pocket.dock({ id: "newer", component: () => html\`<span>Newer dock</span>\` });
    pocket.theme({ "--accent": "rgb(0, 160, 80)" });`,
    );

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

    for (const file of ["a-older.ts", "places.ts", "z-newer.ts"]) {
        await app.setExtensionEnabled(owner(app), file, true);
    }

    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "places-ui-browser-")), load: async () => undefined, save: () => {} });
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
    test(`at ${size} px: the dock, the overlay, the colours, the session menu's row and the panel tab show and work`, real, async () => {
        await page.setViewport(viewport);
        await page.navigate(`${base}/s/${session}`);
        await seen(`return JSON.stringify(document.querySelectorAll('[data-part="extension-docks"] .ext-dock').length === 2)`, "two docks");
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-overlay"]') !== null)`, "the overlay");

        const now = await places();

        // The newest two modules' docks, the older first; a-older's waits.
        assert.deepEqual(now.docks, [`Places dock in ${session}`, "Newer dock"]);
        assert.match(now.overlay!.text, /Places overlay[^]*Floating over the app/);
        // The newest module's accent wins; the other module's background holds.
        assert.equal(now.accent, "rgb(0, 160, 80)");
        assert.equal(now.bg, "rgb(16, 32, 48)");
        assert.equal(now.panelButton, true);
        assert.equal(now.wide, false, "nothing wider than the screen");

        if (size === "390") {
            assert.ok(now.overlay!.bottom <= now.composerTop, `the overlay (bottom ${now.overlay!.bottom}) stays above the message box (top ${now.composerTop})`);
        }

        // A dock is one line.
        assert.equal(await inPage<number>(`return JSON.stringify(Math.round(document.querySelector(".ext-dock").getBoundingClientRect().height))`), 32);
        await shot(`places-${size}.jpg`);

        // The side panel's tab: beside the conversation on a wide screen, over it on a phone.
        const onTop = await page.evaluate(
            `const box = document.querySelector('[data-part="extension-panel-button"]').getBoundingClientRect(); const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2); return JSON.stringify(top?.closest("button")?.outerHTML.slice(0, 120) ?? top?.className ?? "(nothing)")`,
        );

        await page.click({ selector: '[data-part="extension-panel-button"]' });
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel"]')?.innerText.includes("Notes for ${session}") === true)`, "the panel tab").catch(async (error: Error) => {
            throw new Error(
                `${error.message}; on top of the button before the tap: ${onTop}; the panel: ${await page.evaluate(`return JSON.stringify(document.querySelector('[data-part="extension-panel"]')?.outerHTML.slice(0, 800) ?? "(none)")`)}; the button: ${await page.evaluate(`return JSON.stringify(document.querySelector('[data-part="extension-panel-button"]')?.outerHTML ?? "(none)")`)}; logs: ${JSON.stringify(page.logs().slice(-10))}`,
            );
        });

        await still('[data-part="extension-panel"]');

        const panel = await inPage<{ width: number; tab: string }>(
            `const panel = document.querySelector('[data-part="extension-panel"]'); return JSON.stringify({ width: Math.round(panel.getBoundingClientRect().width), tab: panel.querySelector('.ext-panel-tab.on')?.innerText.trim() })`,
        );

        assert.equal(panel.tab, "Places notes");

        if (size === "390") {
            assert.equal(panel.width, 390, "on a phone the panel covers the screen");
        } else {
            assert.ok(panel.width < 900, `beside the conversation (${panel.width} px)`);
        }

        await shot(`places-panel-${size}.jpg`);
        await page.click({ selector: size === "390" ? '[data-part="extension-panel"] .files-back' : '[data-part="extension-panel-button"]' });
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel"]') === null)`, "the panel closed");

        // The session's menu: the drop-in's row gets this session's id.
        await page.click({ selector: '.topbar button[aria-label="Menu"]' });
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-session-item"]')?.innerText.includes("Places stamp") === true)`, "the session menu's row");
        await page.evaluate(`document.querySelector('[data-part="extension-session-item"]').scrollIntoView({ block: "center" }); return "null"`);
        await shot(`places-menu-${size}.jpg`);
        await still(".sheet");
        await page.click({ selector: '[data-part="extension-session-item"]' });
        await seen(`return JSON.stringify(window.placesStamped === ${session})`, "the row ran with the session's id");
        await seen(`return JSON.stringify(document.querySelector(".sheet, .overlay") === null)`, "the menu closed");

        // By link, as Pi's screenshots need (PP-369): the row runs with the session, and the panel tab opens.
        await page.navigate(`${base}/s/${session}?run=places:stamp`);
        await seen(`return JSON.stringify(window.placesStamped === ${session})`, "?run= ran the row with the session's id");
        await page.navigate(`${base}/s/${session}?panelTab=places:notes`);
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel"]') !== null)`, "?panelTab= opened the tab");
        await page.click({ selector: size === "390" ? '[data-part="extension-panel"] .files-back' : '[data-part="extension-panel-button"]' });
        await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel"]') === null)`, "the panel closed again");
    });
}

test("the overlay is dragged by its title, kept where it was put across a reload, and closed with its ×", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${session}`);
    await seen(`return JSON.stringify(document.querySelector('[data-part="extension-overlay"]') !== null)`, "the overlay");

    const before = (await places()).overlay!;
    const head = await inPage<{ x: number; y: number }>(
        `const box = document.querySelector(".ext-overlay-title").getBoundingClientRect(); return JSON.stringify({ x: Math.round(box.left + 10), y: Math.round(box.top + box.height / 2) })`,
    );

    await page.input([
        { type: "mouse", action: "move", x: head.x, y: head.y },
        { type: "mouse", action: "down", x: head.x, y: head.y },
        { type: "mouse", action: "move", x: 420, y: 300, pressed: true },
        { type: "mouse", action: "move", x: 400, y: 320, pressed: true },
        { type: "mouse", action: "up", x: 400, y: 320 },
    ]);

    const moved = (await places()).overlay!;

    // It followed the pointer: moved by as much as the pointer did.
    assert.ok(Math.abs(moved.left - (before.left + 400 - head.x)) <= 2, `left ${moved.left}, from ${before.left}`);
    assert.ok(Math.abs(moved.top - (before.top + 320 - head.y)) <= 2, `top ${moved.top}, from ${before.top}`);
    await page.navigate(`${base}/s/${session}`);
    await seen(`return JSON.stringify(document.querySelector('[data-part="extension-overlay"]') !== null)`, "the overlay again");
    await until(async () => (await places()).overlay?.left === moved.left && (await places()).overlay?.top === moved.top, "the overlay where it was put");

    await page.click({ selector: '[data-part="extension-overlay"] .ext-overlay-head .icon-button' });
    await seen(`return JSON.stringify(document.querySelector('[data-part="extension-overlay"]') === null)`, "the overlay closed");
});

test("extension_inspect says whose dock waits and whose colour lost, as the tab reported", real, async () => {
    await until(() => (app.webs.places()?.hiddenDocks ?? []).includes("a-older"), "the tab's places report");

    const modules = {
        list: () => app.loader.list(),
        nameClashes: () => app.loader.nameClashes(),
        builtInToolNames: () => app.loader.builtInToolNames(),
        dropInFolder: () => app.loader.dropInFolder,
        browserReports: (file: string) => app.webs.reports(file),
        browserPlaces: () => app.webs.places(),
    };

    assert.match(inspect(modules, "a-older"), /- its dock waits: only two modules' docks show at once, the newest loaded \(z-newer, places\)/);
    assert.match(inspect(modules, "places"), /- its dock shows above the message box\n- its colours show: --o-bg\n- its colours lost to newer modules \(the newest loaded wins\): --accent to z-newer/);
    assert.match(inspect(modules, "places"), /added dock status; overlay float; panelTab notes; sessionMenu stamp/);
});

test("safe mode shows none of them, and the app's own colours", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${session}?noext=1`);
    await seen(`return JSON.stringify(document.querySelector(".composer-wrap") !== null)`, "the conversation");

    const now = await places();

    assert.deepEqual(now.docks, []);
    assert.equal(now.overlay, null);
    assert.equal(now.panelButton, false);
    assert.notEqual(now.accent, "rgb(0, 160, 80)");
    assert.notEqual(now.bg, "rgb(16, 32, 48)");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.getElementById("pocket-extension-theme") === null)`), true);
    await shot("places-safe-390.jpg");
    await page.navigate(`${base}/s/${session}?noext=0`);
});

test("turned off, a module's places go: its dock (a-older's shows in its place), overlay, tab, menu row and colours", real, async () => {
    await page.setViewport(VIEWPORTS.desktop);
    await page.navigate(`${base}/s/${session}`);
    await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel-button"]') !== null)`, "the places module loaded");
    await app.setExtensionEnabled(owner(app), "places.ts", false);
    await seen(`return JSON.stringify(document.querySelector('[data-part="extension-panel-button"]') === null)`, "its panel button gone");

    const now = await places();

    assert.deepEqual(now.docks, ["Older dock", "Newer dock"]);
    assert.equal(now.overlay, null);
    assert.equal(now.accent, "rgb(0, 160, 80)", "the other module's colour stays");
    assert.notEqual(now.bg, "rgb(16, 32, 48)");
    await page.click({ selector: '.topbar button[aria-label="Menu"]' });
    await seen(`return JSON.stringify(document.querySelector(".sheet") !== null)`, "the menu");
    assert.equal(await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="extension-session-item"]') === null)`), true);

    await app.setExtensionEnabled(owner(app), "z-newer.ts", false);
    await seen(`return JSON.stringify(document.getElementById("pocket-extension-theme") === null)`, "no colours of extensions left");
});
