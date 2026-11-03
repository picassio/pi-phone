// A HEIC photo attached in a real Chromium (PP-348): Chromium cannot draw it, so its chip shows the file's name and no
// broken picture; sent, the model gets it as a JPEG and the message's line says so. With PHONE_SHOTS, screenshots at
// 390 and 1280 px go there.
import { type App, cleanUp, cleanUpAll, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ConversationId } from "@earendil-works/pi-durable";
import { Browsers } from "./support/browser.ts";
import { findBrowser } from "./support/browser/discovery.ts";
import type { BrowserPage } from "./support/browser/page.ts";
import { VIEWPORTS } from "./support/browser/viewport.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser on this machine" : false } as const;
const SHOTS = process.env.PHONE_SHOTS;
const photo = readFileSync(new URL("./fixtures/photo.heic", import.meta.url));

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

const shot = async (name: string) => {
    if (SHOTS !== undefined) {
        mkdirSync(SHOTS, { recursive: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        writeFileSync(join(SHOTS, name), Buffer.from((await page.screenshot()).data, "base64"));
    }
};

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "heic-ui-")), load: async () => undefined, save: () => {} });
    session = await newSession(app);
    await app.commands.configure(session, owner(app), { model: { provider: "faux", modelId: "faux-vision" } });
    page = await browsers.open(1);
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${session}`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="message-box"] input[type="file"]') !== null)`), "the message box", 20_000);
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

test("a HEIC photo's chip shows its name, and the model gets it as a JPEG", real, async () => {
    await page.evaluate(`
        const input = document.querySelector('[data-part="message-box"] input[type="file"]');
        const files = new DataTransfer();
        const bytes = Uint8Array.from(atob(${JSON.stringify(photo.toString("base64"))}), (char) => char.charCodeAt(0));

        files.items.add(new File([bytes], "IMG_0001.HEIC", { type: "image/heic" }));
        input.files = files.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));

        return "true";
    `);
    // Uploaded, with no broken picture in its chip: the file's chip.
    await until(
        async () => await inPage<boolean>(`return JSON.stringify([...document.querySelectorAll('[data-part="message-box"] .chip')].some((chip) => chip.textContent.includes("IMG_0001.HEIC") && !chip.querySelector(".chip-thumb") && !chip.querySelector(".spinner")))`),
        "the chip without a picture",
    );
    await shot("heic-chip-390.jpg");
    await page.setViewport(VIEWPORTS.desktop);
    await shot("heic-chip-1280.jpg");
    await page.setViewport(VIEWPORTS.mobile);

    // Sent: the line in the message says the model got it as a JPEG.
    await page.evaluate(`
        const box = document.querySelector('[data-part="message-box"] textarea');

        box.value = "what is this";
        box.dispatchEvent(new Event("input", { bubbles: true }));

        return "true";
    `);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector('[data-part="message-box"] button[aria-label="Send"]:not([disabled])') !== null)`), "Send");
    await page.evaluate(`document.querySelector('[data-part="message-box"] button[aria-label="Send"]').click(); return "true";`);
    await until(async () => {
        const history = await app.transcripts.history(session, Number.MAX_SAFE_INTEGER);
        const user = history.findLast((entry) => entry.kind === "user");

        return user?.kind === "user" && / \[Image: shown to you as JPEG\.\]$/.test(user.text);
    }, "the message with its note");
    const history = await app.transcripts.history(session, Number.MAX_SAFE_INTEGER);
    const user = history.findLast((entry) => entry.kind === "user");

    assert.match(user?.kind === "user" ? user.text : "", /IMG_0001\.HEIC, image\/heic, 499 bytes\) \[Image: shown to you as JPEG\.\]$/);
});
