// Archiving a session with repeating schedules (PP-338, from pi-pocket #215): a notice says how many keep running and
// leads to them; the Schedules sheet marks each schedule of an archived session. With PHONE_SHOTS set to a folder,
// screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const real = { skip: findBrowser() === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("done")])));
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "schedules-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
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

const notice = () => inPage<string>(`return JSON.stringify([...document.querySelectorAll(".notice .notice-text")].map((each) => each.textContent).join(" | "))`);
const marked = () => inPage<string>(`return JSON.stringify(document.querySelector(".schedule [data-part=state-tag]")?.textContent.trim() ?? "")`);

for (const [size, viewport] of [["390", VIEWPORTS.mobile], ["1280", VIEWPORTS.desktop]] as const) {
    test(`at ${size} px, archiving says the repeating schedules keep running, and leads to them, marked`, real, async () => {
        const id = await newSession(app);

        await app.commands.updateSession(id, owner(app), { title: `Nightly checks ${size}` });
        await app.commands.schedule(id, owner(app), { when: "every 20m ping", zone: "UTC" });
        await page.setViewport(viewport);
        await page.navigate(`${base}/`);
        await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part=session-row][data-id="${Number(id)}"]') !== null)`), "the row", 20_000);

        // As the row's Archive does.
        await inPage(`(await import("/sessions.js")).setArchived([${Number(id)}], true); return "null";`);
        await until(async () => (await notice()).includes("keeps 1 repeating schedule running"), "the notice");
        assert.match(await notice(), new RegExp(`“Nightly checks ${size}” keeps 1 repeating schedule running\\. (Tap|Click) to see it\\.`));
        await shot(`archive-notice-${size}`);

        await inPage(`[...document.querySelectorAll(".notice")].find((each) => each.textContent.includes("repeating schedule")).click(); return "null";`);
        await until(async () => (await marked()) === "Session archived", "the schedule marked in the sheet", 20_000);
        assert.equal(await inPage<string>(`return JSON.stringify(location.pathname)`), `/s/${Number(id)}`);
        await shot(`schedules-archived-${size}`);
    });
}

test("a session not archived has no mark", real, async () => {
    const id = await newSession(app);

    await app.commands.schedule(id, owner(app), { when: "every 20m ping", zone: "UTC" });
    await page.navigate(`${base}/s/${Number(id)}`);
    await until(
        async () =>
            await inPage<boolean>(`
                const { store, openSheet } = await import("/store.js");
                if (store.state.sessions.length === 0) return JSON.stringify(false);
                openSheet({ type: "schedules" });
                return JSON.stringify(document.querySelector(".schedule") !== null);
            `),
        "the sheet",
        20_000,
    );
    assert.equal(await marked(), "");
});
