// Steps before the shot (PP-423) on the app itself, with the server edition's renderer on a real Chrome (as the phone's
// renders): Wiki settings by link (/?sheet=para:settings), its Capture model picker opened with steps, then pictured and
// measured open at 390 and 1920 px. With PHONE_SHOTS, the pictures and the layout check's report go there.
import { type App, cleanUp, openApp, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ChromeRenderer } from "../src/server/chrome-renderer.ts";
import { createHandler } from "../src/server/http.ts";
import { describeLayout } from "../src/server/layout-check.ts";
import type { RenderStep } from "../src/server/render-steps.ts";
import { findBrowser } from "./support/browser/discovery.ts";

const chrome = findBrowser();
const real = { skip: chrome === undefined ? "no Chromium-based browser on this machine (CI runs it)" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
/** What a person taps to see the picker: the field, then the picker shows. */
const OPEN_PICKER: RenderStep[] = [{ click: '[data-part="wiki-capture-model"] .choice' }, { wait: ".model-menu .pop-menu-row" }];

let app: App;
let server: Server;
let renderer: ChromeRenderer | undefined;
let base = "";

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    if (chrome !== undefined) {
        renderer = new ChromeRenderer(app.screenshots, { binary: chrome, flags: ["--no-sandbox"], base, token: () => app.config.ownerToken, log: () => {} });
        void renderer.run();
    }
});

after(async () => {
    await renderer?.stop();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("Wiki settings' Capture model picker, opened with steps, is pictured and measured open at 390 and 1920 px", real, async () => {
    const page = `${base}/?sheet=para:settings`;
    const state = await app.screenshots.render(page, {
        widths: [390, 1920],
        settleMs: 1500,
        steps: OPEN_PICKER,
        check: `JSON.stringify({ title: document.querySelector(".model-menu")?.getAttribute("aria-label") ?? null, rows: document.querySelectorAll(".model-menu .pop-menu-row").length })`,
    });

    for (const shot of state) {
        const open = JSON.parse(shot.check!) as { title: string | null; rows: number };

        assert.equal(open.title, "Capture model", `at ${shot.width} px the picker is open`);
        assert.ok(open.rows > 0, `at ${shot.width} px it lists models`);
    }

    // The same, measured by the layout check (the screenshot tool's), as Pi gets it.
    const shots = await app.screenshots.render(page, { widths: [390, 1920], settleMs: 1500, steps: OPEN_PICKER });

    for (const shot of shots) {
        assert.ok(shot.layout !== undefined, `the layout check at ${shot.width} px`);

        if (SHOTS !== undefined) {
            mkdirSync(SHOTS, { recursive: true });
            shot.parts.forEach((part, index) => writeFileSync(join(SHOTS, `capture-picker-steps-${shot.width}${index === 0 ? "" : `-${index + 1}`}.jpg`), part));
            writeFileSync(join(SHOTS, `capture-picker-steps-${shot.width}.layout.txt`), `${describeLayout(shot.layout!)}\nRAW ${JSON.stringify(shot.layout!.found)}\n`);
        }
    }

    // A selector the page lacks: the render fails naming the step.
    await assert.rejects(
        app.screenshots.render(page, { widths: [390], settleMs: 1500, steps: [{ click: '[data-part="no-such-field"]' }] }),
        /a step failed: step 1 \(click "\[data-part=\\"no-such-field\\"\]"\): nothing matches/,
    );
});
