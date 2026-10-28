// The browser panel's live picture while the person has the page (PP-124), in a headless browser at the phone's size: a
// finger dragged on it scrolls the page at the point it went down (an open panel's own list first), and is no tap.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
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
const real = {
    skip: chromium === undefined ? "no Chromium-based browser on this machine" : false,
} as const;
const PICTURE = ".pb-frame.live img";

let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base = "";
let session: ConversationId;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

before(async () => {
    if (chromium === undefined) {
        return;
    }

    app = await openApp(scriptedModel());
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "browser-panel-ui-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

type Sent = { type: string; x?: number; y?: number; dx?: number; dy?: number };

/**
 * The session open with its browser panel showing a page the person has taken over. No browser runs: the panel's
 * requests to it are answered in the page, and what it sends the page is kept in `window.sent`.
 */
async function takenOver(): Promise<void> {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${Number(session)}`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`), "the session", 20_000);
    await page.evaluate(`
        const { setPiBrowser, store } = await import("/store.js");
        const { setBrowserOpen } = await import("/browser-panel.js");
        const state = {
            session: ${Number(session)},
            place: "phone",
            open: true,
            takenOver: true,
            url: "https://example.test/",
            title: "Example",
            tabs: [],
            viewport: { width: 412, height: 860 },
            size: "phone",
        };
        const fetched = window.fetch;

        window.sent = [];
        window.fetch = async (input, init) => {
            const url = String(input);

            if (url.includes("/browser/input")) {
                window.sent.push(JSON.parse(init.body));

                return Response.json({ editable: false, password: false });
            }

            // Its state, and watching its frames (which answers the state too).
            if (/^api\\/browser(\\/watch)?\\?/.test(url)) {
                return Response.json(state);
            }

            return fetched(input, init);
        };
        window.showTakenOver = () => setPiBrowser(state);
        setBrowserOpen(true);
    `);
    // The panel's own first look at the browser (closed, from the server) may land after the state set here: set again
    // until the picture stays (two looks running).
    let stayed = 0;

    await until(async () => {
        const shown = await inPage<boolean>(`
            window.showTakenOver();
            await new Promise((resolve) => setTimeout(resolve, 300));

            return JSON.stringify(document.querySelector(${JSON.stringify(PICTURE)}) !== null);
        `);

        stayed = shown ? stayed + 1 : 0;

        return stayed >= 2;
    }, "the live picture");
}

/**
 * Pointer events on the live picture, as a finger makes them: down at the middle of its frame (the picture fills it; no
 * frame came here, so the image itself has no height), moved by `steps`, up, and the click.
 */
async function finger(steps: Array<[number, number]>): Promise<void> {
    await page.evaluate(`
        const picture = document.querySelector(${JSON.stringify(PICTURE)});
        const box = picture.parentElement.getBoundingClientRect();
        let x = box.left + box.width / 2;
        let y = box.top + box.height / 2;
        const at = (type) =>
            picture.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y, bubbles: true }));

        at("pointerdown");

        for (const [dx, dy] of ${JSON.stringify(steps)}) {
            x += dx;
            y += dy;
            at("pointermove");
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        at("pointerup");
        picture.dispatchEvent(new MouseEvent("click", { clientX: x, clientY: y, bubbles: true }));
    `);
}

const sent = () => inPage<Sent[]>(`return JSON.stringify(window.sent)`);

test("taken over on a phone: a finger dragged up scrolls the page down at the point it went down, and is no tap", real, async () => {
    await takenOver();
    await finger([
        [0, -20],
        [0, -40],
        [0, -40],
    ]);
    await until(async () => (await sent()).reduce((sum, event) => sum + (event.dy ?? 0), 0) > 100, "scrolls sent");
    const events = await sent();

    assert.ok(
        events.every((event) => event.type === "scroll"),
        `only scrolls, no tap: ${JSON.stringify(events)}`,
    );
    // Where the finger went down, in the page's pixels: the middle of a 412 by 860 page.
    assert.deepEqual(new Set(events.map((event) => `${event.x},${event.y}`)), new Set(["206,430"]));
    assert.ok(events.every((event) => event.dx === 0));
});

// PP-199: the page's picture never came (a capture held by a busy page): the panel said "Waiting for the page…" for
// good. The server now tells it (`pictureError`) after a few tries: the panel shows why, with Retry.
test("no picture after several tries: the panel says so with Retry, which starts the pictures again", real, async () => {
    await page.setViewport(VIEWPORTS.mobile);
    await page.navigate(`${base}/s/${Number(session)}`);
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".composer textarea") !== null)`), "the session", 20_000);
    await page.evaluate(`
        const { setPiBrowser } = await import("/store.js");
        const { setBrowserOpen } = await import("/browser-panel.js");
        const state = {
            session: ${Number(session)}, place: "phone", open: true, takenOver: false, url: "https://example.test/", title: "Example",
            tabs: [], viewport: { width: 412, height: 860 }, size: "phone", doing: null,
            pictureError: "the first picture: Error: Page.captureScreenshot took longer than 5 seconds.",
        };
        const fetched = window.fetch;

        window.retried = 0;
        window.fetch = async (input, init) => {
            const url = String(input);

            if (url.includes("/browser/frames")) {
                window.retried += 1;

                return Response.json({ ...state, pictureError: null });
            }

            if (/^api\\/browser(\\/watch)?\\?/.test(url)) {
                return Response.json(state);
            }

            return fetched(input, init);
        };
        window.showFailed = () => setPiBrowser(state);
        setBrowserOpen(true);
    `);
    await until(async () => await inPage<boolean>(`window.showFailed(); await new Promise((r) => setTimeout(r, 200)); return JSON.stringify(document.querySelector(".pb-picture-error button") !== null)`), "the error with Retry");

    const shown = await inPage<{ text: string; waiting: boolean }>(`return JSON.stringify({ text: document.querySelector(".pb-picture-error").innerText, waiting: document.querySelector(".pb-wait") !== null })`);

    assert.match(shown.text, /The page's picture did not come\./);
    assert.match(shown.text, /captureScreenshot took longer than 5 seconds/);
    assert.equal(shown.waiting, false, "not \"Waiting for the page…\"");

    if (process.env.PHONE_SHOTS !== undefined) {
        writeFileSync(join(process.env.PHONE_SHOTS, "browser-picture-error.jpg"), Buffer.from((await page.screenshot()).data, "base64"));
    }

    await page.evaluate(`document.querySelector(".pb-picture-error button").click()`);
    await until(async () => (await inPage<number>(`return JSON.stringify(window.retried)`)) === 1, "Retry sent");
    await until(async () => await inPage<boolean>(`return JSON.stringify(document.querySelector(".pb-picture-error") === null && document.querySelector(".pb-wait") !== null)`), "waiting again after Retry");
});

test("taken over on a phone: a finger that barely moves is a tap", real, async () => {
    await takenOver();
    await finger([[3, 2]]);
    await until(async () => (await sent()).length > 0, "a tap sent");
    assert.deepEqual(
        (await sent()).map((event) => event.type),
        ["tap"],
    );
});
