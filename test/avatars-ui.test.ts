// Profile pictures in a real browser (PP-353, from pi-pocket #205): Add photo in the name sheet crops and sends a
// picture, which then shows in the name sheet, the rail, and on your messages; Remove photo takes it away and the
// initials come back. With PHONE_SHOTS set to a folder, screenshots at 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
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
let id: ConversationId;

const inPage = async <T>(script: string): Promise<T> => JSON.parse(await page.evaluate(script)) as T;

async function shot(name: string): Promise<void> {
    if (SHOTS === undefined) {
        return;
    }

    mkdirSync(SHOTS, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 600));
    writeFileSync(join(SHOTS, `${name}.jpg`), Buffer.from((await page.screenshot()).data, "base64"));
}

/** The name sheet open, at `width`. */
async function nameSheet(viewport: typeof VIEWPORTS.mobile): Promise<void> {
    await page.setViewport(viewport);
    await page.navigate(`${base}/s/${Number(id)}`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".prompt") !== null)`), "the session", 20_000);
    await inPage(`(await import("/store.js")).openSheet({ type: "name" }); return "null";`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector("[data-part=my-photo]") !== null)`), "the name sheet");
}

/** A picture chosen in the name sheet's file field, as a person picks one: a wide one, which is cropped to its middle. */
const choose = () =>
    inPage(`
        const canvas = document.createElement("canvas");
        canvas.width = 300;
        canvas.height = 200;
        const context = canvas.getContext("2d");
        context.fillStyle = "#e0af68";
        context.fillRect(0, 0, 300, 200);
        context.fillStyle = "#7aa2f7";
        context.beginPath();
        context.arc(150, 100, 60, 0, Math.PI * 2);
        context.fill();
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const input = document.querySelector("[data-part=my-photo] input[type=file]");
        const files = new DataTransfer();
        files.items.add(new File([blob], "me.png", { type: "image/png" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return "null";
    `);

const pictures = () =>
    inPage<{ sheet: boolean; prompt: boolean; rail: boolean }>(`
        return JSON.stringify({
            sheet: document.querySelector("[data-part=my-photo] .avatar-img") !== null,
            prompt: document.querySelector(".prompt-avatar img") !== null,
            rail: document.querySelector(".rail .avatar-img, nav .avatar-img") !== null,
        });
    `);

before(async () => {
    if (real.skip) {
        return;
    }

    app = await openApp(scriptedModel());
    id = await newSession(app);
    await say(app, id, "Here is my question about the build");
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "avatars-ui-")), load: async () => undefined, save: () => {} });
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

test("at 390 px, Add photo sends a cropped picture, which shows in the sheet and on your messages", real, async () => {
    await nameSheet(VIEWPORTS.mobile);
    assert.deepEqual(await pictures(), { sheet: false, prompt: false, rail: false }, "initials until a picture is set");
    await choose();
    await until(() => app.config.userById(owner(app).id)?.avatar !== undefined, "the picture kept");
    await until(async () => (await pictures()).sheet, "the picture in the sheet");
    assert.equal(await inPage<string>(`return JSON.stringify(document.querySelector("[data-part=my-photo] .button").textContent.trim())`), "Change photo");
    await shot("photo-sheet-390");

    await inPage(`(await import("/store.js")).closeSheet(); return "null";`);
    await until(async () => (await pictures()).prompt, "the picture on your message");
    await shot("photo-message-390");
});

test("at 1280 px, the picture shows on the rail and your messages; Remove photo brings the initials back", real, async () => {
    await nameSheet(VIEWPORTS.desktop);
    await until(async () => (await pictures()).rail && (await pictures()).prompt, "the picture on the rail and the message");
    await shot("photo-1280");

    await inPage(`[...document.querySelectorAll("[data-part=my-photo] .button")].find((each) => each.textContent.trim() === "Remove photo").click(); return "null";`);
    await until(() => app.config.userById(owner(app).id)?.avatar === undefined, "the picture gone");
    await until(async () => JSON.stringify(await pictures()) === JSON.stringify({ sheet: false, prompt: false, rail: false }), "the initials back");
});
