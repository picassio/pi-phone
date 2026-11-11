// The app's dropdown (`Choice`, `MultiChoice` in web/ui.js) inside something that moves or is transformed, as a sheet
// sliding in or the account card rising in (PP-374): its list sits right under its button while the container moves and
// after it stops, not off by the container's offset (a fixed element inside a transformed ancestor is placed against it).
import { type App, cleanUp, cleanUpAll, home, pastWelcome, root, scriptedModel, until, work } from "./helpers.ts";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
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

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (real.skip !== false) {
        return;
    }

    const faux = scriptedModel(() => fauxAssistantMessage([fauxText("ok")]));

    app = await PocketApp.open({
        dataDir: join(root, "choice-place-data"),
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
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "choice-place-browser-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`http://127.0.0.1:${(server.address() as AddressInfo).port}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await until(async () => (await inPage<boolean>(`return JSON.stringify((await import("/store.js")).store.state.me?.role === "owner")`)) === true, "signed in", 30_000);
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

/**
 * A Choice and a MultiChoice in a box that slides up 240 px over `ms` (as a sheet does), or that stays moved by a
 * transform; answers how far each list's top is from where it belongs (its button's bottom + 4), now.
 */
const mount = (ms: number) => `
    const { html, Choice, MultiChoice } = await import("/ui.js");
    const { render } = await import("preact");
    document.getElementById("pp374")?.remove();
    const box = document.createElement("div");
    box.id = "pp374";
    box.style.cssText = "position:fixed;left:16px;right:16px;top:120px;padding:16px;background:#222;z-index:9999;transform:translateY(40px)";
    document.body.append(box);
    window.pp497 = [];
    render(html\`<div><\${Choice} label="One" value="a" options=\${[{ value: "a", label: "A" }, { value: "b", label: "B" }]} onChange=\${(value) => window.pp497.push(value)} /></div>
        <div style="margin-top:8px"><\${MultiChoice} label="Some" options=\${[{ value: "x", label: "X" }]} onAdd=\${(values) => window.pp497.push(...values)} /></div>\`, box);
    ${ms > 0 ? `box.animate([{ transform: "translateY(280px)" }, { transform: "translateY(40px)" }], { duration: ${ms}, easing: "linear" });` : ""}
    return "true";`;

// Measured once the list's own pop-in (8 px, 0.25 s) is over: null until then.
const off = (which: number) => `
    const button = document.querySelectorAll("#pp374 button.choice")[${which}];
    const menu = document.querySelector("#pp374 .choice-menu");
    const popping = menu !== null && menu.getAnimations().some((each) => each.playState === "running");
    return JSON.stringify(menu === null || popping ? null : Math.round(menu.getBoundingClientRect().top - (button.getBoundingClientRect().bottom + 4)));`;

test("a dropdown's list sits under its button inside a transformed box, and follows it while the box slides in (PP-374)", real, async () => {
    // Moved by a transform and still: placed against the box, the list would be 40 px (plus the box's top) off.
    await page.evaluate(mount(0));
    await page.evaluate(`document.querySelectorAll("#pp374 button.choice")[0].click(); return "true";`);
    await until(async () => (await inPage<number | null>(off(0))) !== null, "the list open");
    assert.equal(await inPage<number>(off(0)), 0, "Choice, transformed box");
    await page.evaluate(`document.querySelectorAll("#pp374 button.choice")[0].click(); return "true";`);
    await until(async () => (await inPage<boolean>(`return JSON.stringify(document.querySelector("#pp374 .choice-menu") === null)`)) === true, "the list closed");

    await page.evaluate(`document.querySelectorAll("#pp374 button.choice")[1].click(); return "true";`);
    await until(async () => (await inPage<number | null>(off(1))) !== null, "the multi list open");
    assert.equal(await inPage<number>(off(1)), 0, "MultiChoice, transformed box");

    // Sliding in over 1.5 s: opened at once, the list stays under the button while it moves, and once it stops.
    await page.evaluate(mount(1500));
    await page.evaluate(`document.querySelectorAll("#pp374 button.choice")[0].click(); return "true";`);
    await until(async () => (await inPage<number | null>(off(0))) !== null, "the list open while sliding");

    const during: (number | null)[] = [];

    for (let i = 0; i < 4; i++) {
        during.push(await inPage<number>(off(0)));
        await new Promise((resolve) => setTimeout(resolve, 150));
    }

    assert.ok(during.filter((each) => each !== null).length >= 2, `measured while sliding: ${during.join(", ")}`);
    assert.ok(
        during.every((each) => each === null || Math.abs(each) <= 2),
        `under the button while sliding (one frame behind at most): ${during.join(", ")}`,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await inPage<number>(off(0)), 0, "under the button once it stopped");
});

/** Open dropdown `which` while its box slides in, wait `frames` frames, tap `rows` in its list, and say what came of it later. */
const pickWhileMoving = (which: number, frames: number, rows: string[]) => `
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    document.querySelectorAll("#pp374 button.choice")[${which}].click();
    for (let i = 0; i < ${frames}; i++) await frame();
    for (const row of ${JSON.stringify(rows)}) {
        document.querySelector("#pp374 .choice-menu " + row).click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    return JSON.stringify({ open: document.querySelector("#pp374 .choice-menu") !== null, picked: window.pp497 });`;

test("a dropdown picked while its box still moves stays closed (PP-497)", real, async () => {
    for (const frames of [1, 2, 4]) {
        await page.evaluate(mount(1500));
        assert.deepEqual(await inPage(pickWhileMoving(0, frames, [".pop-menu-row:nth-child(2)"])), { open: false, picked: ["b"] }, `Choice, picked ${frames} frames after it opened`);

        await page.evaluate(mount(1500));
        assert.deepEqual(await inPage(pickWhileMoving(1, frames, [".mc-row", "[data-part=multi-add]"])), { open: false, picked: ["x"] }, `MultiChoice, added ${frames} frames after it opened`);
    }
});
