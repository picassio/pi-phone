// The Browser panel's live picture end to end in real browsers (PP-200): Pi's browser a headless Chrome, the panel the web
// app in another at a phone's size. The panel draws each picture on a canvas from a JPEG it fetches (one request
// waiting at the server for the next), never from the event stream; it tells the server how big it draws them, and the
// frames are no bigger; a change on the page shows within moments.
import { type App, cleanUp, newSession, openApp, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Cdp } from "../src/server/browser/cdp.ts";
import { ChromeEngine } from "../src/server/browser/pi-browser.ts";
import { createHandler } from "../src/server/http.ts";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});
const real = { skip: chrome === undefined ? "no Chrome on this machine" : false } as const;

let app: App;
let server: Server;
let pi: ChromeEngine;
let viewerEngine: ChromeEngine;
let viewer: Cdp;
let session = 0;

async function inViewer<T>(expression: string): Promise<T> {
    const answer = await viewer.send<{ result: { value?: unknown }; exceptionDetails?: { exception?: { description?: string } } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });

    if (answer.exceptionDetails !== undefined) {
        throw new Error(answer.exceptionDetails.exception?.description ?? "the page threw");
    }

    return answer.result.value as T;
}

const page = (color: string) => `data:text/html,<body style="margin:0;height:100vh;background:${encodeURIComponent(color)}"></body>`;

before(async () => {
    if (real.skip) {
        return;
    }

    pi = new ChromeEngine(chrome!, ["--no-sandbox"]);
    app = await openApp(scriptedModel(), join(root, "browser-stream-ui"), undefined, { browserEngine: pi });
    session = Number(await newSession(app));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await app.browserAt("phone", session).resize(session, "desktop");
    await app.browserAt("phone", session).open(session, page("rgb(255,0,0)"));

    viewerEngine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    viewer = await viewerEngine.connect(await viewerEngine.newTab());
    await viewer.send("Page.enable");
    await viewer.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 860, deviceScaleFactor: 3, mobile: true });
    // What goes over the event stream, and the panel's requests, as the page sees them.
    await viewer.send("Page.addScriptToEvaluateOnNewDocument", {
        source: `window.frameEvents = []; window.watched = [];
            const Source = window.EventSource;
            window.EventSource = class extends Source { constructor(...a) { super(...a); this.addEventListener("browser-frame", (e) => window.frameEvents.push(e.data)); } };
            const fetched = window.fetch;
            window.fetch = (input, init) => { if (String(input).includes("browser/watch")) window.watched.push(init?.body); return fetched(input, init); };`,
    });

    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    await viewer.send("Page.navigate", { url: `${base}/login?token=${encodeURIComponent(app.config.ownerToken)}&next=/s/${session}` });
    await until(async () => (await inViewer<boolean>(`document.querySelector(".composer textarea") !== null`).catch(() => false)), "the session", 20_000);
    await inViewer(`(async () => { const { setBrowserOpen } = await import("/browser-panel.js"); setBrowserOpen(true); })()`);
});

after(async () => {
    viewer?.close();
    await viewerEngine?.close();
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    await pi?.close();
    cleanUp();
});

/** The panel picture's middle pixel. */
const middle = () =>
    inViewer<number[] | null>(`(() => {
        const canvas = document.querySelector(".pb-frame canvas");
        if (!canvas || canvas.width === 0) return null;
        const probe = new OffscreenCanvas(1, 1).getContext("2d");
        probe.drawImage(canvas, canvas.width / 2, canvas.height / 2, 1, 1, 0, 0, 1, 1);
        return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
    })()`);
const near = (seen: number[] | null, [r, g, b]: number[]) => seen !== null && Math.abs(seen[0]! - r!) + Math.abs(seen[1]! - g!) + Math.abs(seen[2]! - b!) < 60;

test("the panel draws the page from fetched pictures, at the size it draws them, and a change shows within moments", real, async () => {
    await until(async () => near(await middle(), [255, 0, 0]), "the red page in the panel", 20_000);

    // The event stream said a picture is there; the picture itself was fetched.
    const events = await inViewer<string[]>("window.frameEvents");

    assert.ok(events.length > 0);
    assert.ok(events.every((data) => !data.includes("jpeg")), "no picture in the event stream");

    // It said how big it draws them: its box on screen at twice the CSS pixels at most (the phone's ratio is 3).
    const said = JSON.parse((await inViewer<string[]>("window.watched")).find((body) => body.includes('"on":true'))!) as { width: number; height: number };
    const box = await inViewer<{ width: number; height: number }>(`(() => { const r = document.querySelector(".pb-frame").getBoundingClientRect(); return { width: r.width, height: r.height }; })()`);

    assert.ok(Math.abs(said.width - box.width * 2) <= 2 && Math.abs(said.height - box.height * 2) <= 2, `${JSON.stringify(said)} for a box of ${JSON.stringify(box)}`);

    // The frames are that size, not the page's 1280 (a picture taken before the panel had its size on screen, as it slid
    // in, is replaced by one of its size).
    const width = () => inViewer<number>(`document.querySelector(".pb-frame canvas").width`);

    await until(async () => (await width()) <= said.width + 1, `frames as wide as ${said.width}`, 5000);

    const changed = Date.now();

    await app.browserAt("phone", session).open(session, page("rgb(0,0,255)"));
    await until(async () => near(await middle(), [0, 0, 255]), "the blue page in the panel", 5000);
    assert.ok(Date.now() - changed < 5000);

    if (process.env.PHONE_SHOTS !== undefined) {
        const { data } = await viewer.send<{ data: string }>("Page.captureScreenshot", { format: "png" });

        writeFileSync(join(process.env.PHONE_SHOTS, "browser-stream.png"), Buffer.from(data, "base64"));
    }
});
