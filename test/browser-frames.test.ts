// The Browser panel's pictures when the page's capture stalls (PP-199; src/server/browser/pi-browser.ts `#startFrames`),
// against a fake DevTools: Page.captureScreenshot waits as long as a page whose main thread is busy holds it (headless
// Chrome, checked on tuanlh-devbox-01), and a still page's screencast sends nothing. The panel stayed on "Waiting for the
// page…" for good. Now: a first capture that hangs is tried again (with a growing wait, the screencast started again)
// and the next picture shows; pictures that never come tell the panel (`pictureError`), which shows Retry; Retry starts
// them again; a panel opened later gets the last picture at once.
import { type App, cleanUp, fakeTab, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { Cdp } from "../src/server/browser/cdp.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { type BrowserEngine, type BrowserFrame, type BrowserState, ChromeEngine, PiBrowser } from "../src/server/browser/pi-browser.ts";
import { execFileSync } from "node:child_process";

const chrome = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"].find((name) => {
    try {
        execFileSync("which", [name], { stdio: "ignore" });

        return true;
    } catch {
        return false;
    }
});

/** A DevTools that answers what a tab's setup asks, and pictures as a test says: `hang` (never), `ok`, or an error. */
class FakeDevtools {
    readonly #server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    captures: ("hang" | "ok" | "error")[] = [];
    asked: string[] = [];
    #socket: WebSocket | undefined;

    constructor() {
        this.#server.on("connection", (socket) => {
            this.#socket = socket;
            socket.on("message", (raw) => {
                const { id, method } = JSON.parse(String(raw)) as { id: number; method: string };

                this.asked.push(method);

                const answer = (result: Record<string, unknown>) => socket.send(JSON.stringify({ id, result }));

                if (method === "Page.captureScreenshot") {
                    const next = this.captures.shift() ?? "ok";

                    if (next === "ok") {
                        answer({ data: "UElDVFVSRQ==" });
                    } else if (next === "error") {
                        socket.send(JSON.stringify({ id, error: { code: -32000, message: "Unable to capture screenshot" } }));
                    }

                    return;
                }

                if (method === "Page.getFrameTree") {
                    return answer({ frameTree: { frame: { id: "main" } } });
                }

                if (method === "Runtime.evaluate") {
                    return answer({ result: { type: "string", value: "" } });
                }

                answer({});
            });
        });
    }

    get url(): string {
        return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/devtools/page/t1`;
    }

    /** A screencast frame, as Chrome sends one. */
    cast(): void {
        this.#socket?.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: "RlJBTUU=", sessionId: 1, metadata: { deviceWidth: 1280, deviceHeight: 800 } } }));
    }

    listening(): Promise<void> {
        return this.#server.address() === null ? new Promise((resolve) => this.#server.once("listening", () => resolve())) : Promise.resolve();
    }

    count(method: string): number {
        return this.asked.filter((each) => each === method).length;
    }

    close(): Promise<void> {
        for (const client of this.#server.clients) {
            client.terminate();
        }

        return new Promise((resolve) => this.#server.close(() => resolve()));
    }
}

const opened: { browser: PiBrowser; devtools: FakeDevtools }[] = [];
let app: App | undefined;

after(async () => {
    for (const { browser, devtools } of opened) {
        await browser.close().catch(() => {});
        await devtools.close();
    }

    await app?.close();
    cleanUp();
});

const engineOf = (devtools: FakeDevtools): BrowserEngine => ({
        label: "the fake Chrome",
        popups: false,
        local: true,
        actAsPhone: false,
        reopensToResize: false,
        tabs: async () => [],
        newTab: async () => "t1",
        connect: () => Cdp.connect({ url: devtools.url }),
        closeTab: async () => {},
        close: async () => {},
        pdf: async () => Buffer.alloc(0),
        picture: (_id: string, page: BrowserPage, quality: number, timeoutMs?: number) => page.screenshot(quality, timeoutMs, { surface: false }),
        stage: async (name: string) => name,
});

async function browserOn(devtools: FakeDevtools) {
    await devtools.listening();

    const engine = engineOf(devtools);
    const frames: BrowserFrame[] = [];
    let state: BrowserState | undefined;
    const browser = new PiBrowser({
        engine,
        session: 1,
        size: "desktop",
        changed: (changed) => {
            state = changed;
        },
        frame: (frame) => frames.push(frame),
        log: () => {},
        frames: { pictureMs: 150, firstMs: 150, backoffMs: [50, 100], failAfter: 3 },
    });

    opened.push({ browser, devtools });
    // A tab open, as after Pi browsed: Pi is not browsing now.
    await browser.tabs(1);

    return { browser, frames, state: () => state ?? browser.state() };
}

const until = async (check: () => boolean, what: string, ms = 5000) => {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error(`Timed out waiting for ${what}`);
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

test("a first picture that hangs is tried again, the screencast started again, and the next picture shows", async () => {
    const devtools = new FakeDevtools();
    const { browser, frames, state } = await browserOn(devtools);

    devtools.captures = ["hang", "ok"];
    browser.watch();
    await until(() => frames.length > 0, "a picture in the panel");
    assert.equal(frames[0]!.jpeg, "UElDVFVSRQ==");
    await until(() => devtools.count("Page.startScreencast") >= 2, "the screencast started again");
    assert.equal(state().pictureError, null);
    assert.equal(browser.lastFrame()?.jpeg, "UElDVFVSRQ==");
});

test("pictures that never come tell the panel, which shows Retry; Retry starts them again; a frame clears it", async () => {
    const devtools = new FakeDevtools();
    const { browser, frames, state } = await browserOn(devtools);

    devtools.captures = Array.from({ length: 1000 }, () => "error" as const);
    browser.watch();
    await until(() => state().pictureError !== null, "the panel told");
    assert.match(state().pictureError!, /Unable to capture screenshot/);
    assert.equal(frames.length, 0);

    // Still trying meanwhile, with a wait that grows.
    const tried = devtools.count("Page.captureScreenshot");

    await until(() => devtools.count("Page.captureScreenshot") > tried, "another try");

    // Retry: the error goes at once, and the picture comes once the page answers.
    devtools.captures = ["ok"];
    browser.retryFrames();
    assert.equal(state().pictureError, null);
    await until(() => frames.length > 0, "the picture after Retry");

    // A frame of the screencast is a picture too.
    devtools.cast();
    await until(() => frames.length > 1, "the cast's frame");
    assert.equal(browser.lastFrame()?.jpeg, "RlJBTUU=");
    assert.equal(state().pictureError, null);
});

// The owner's report: the panel opened after Pi stopped browsing; the page was still, so no frame came, and the cast
// already ran for another of the owner's tabs: "Waiting for the page…" for good.
test("a panel opened while another tab watches a still page gets its last picture at once", async () => {
    const devtools = new FakeDevtools();

    await devtools.listening();
    app = await openApp(scriptedModel(), join(root, "browser-frames"), undefined, { browserEngine: engineOf(devtools) });

    const session = Number(await newSession(app));
    const first = fakeTab(undefined, owner(app));
    const second = fakeTab(undefined, owner(app));

    opened.push({ browser: app.browserAt("phone", session), devtools });
    await app.attach(first.client);
    await app.attach(second.client);
    await app.browserAt("phone", session).tabs(session);
    app.setBrowserWatch(owner(app), first.client.connection, "phone", session, true);
    await until(() => first.last("browser-frame") !== undefined, "the first tab's picture");

    const captured = devtools.count("Page.captureScreenshot");

    app.setBrowserWatch(owner(app), second.client.connection, "phone", session, true);
    assert.equal(second.last("browser-frame")?.jpeg, "UElDVFVSRQ==", "at once, with no new capture");
    assert.equal(devtools.count("Page.captureScreenshot"), captured);
    app.setBrowserWatch(owner(app), first.client.connection, "phone", session, false);
    app.setBrowserWatch(owner(app), second.client.connection, "phone", session, false);
});

// What holds a capture, found on tuanlh-devbox-01 (headless Chrome 155, 1280×800): a page whose main thread is busy
// (a big dialog's list rendering, on a slow computer). Page.captureScreenshot waits until it is free, from the surface
// or not; the screencast's frames come once it is.
test("with Chrome: a page busy when the panel opens gets its picture once it is free", { skip: chrome === undefined ? "no Chrome on this machine" : false }, async () => {
    const engine = new ChromeEngine(chrome!, ["--no-sandbox"]);
    const frames: BrowserFrame[] = [];
    const logged: string[] = [];
    const browser = new PiBrowser({ engine, session: 1, size: "desktop", changed: () => {}, frame: (frame) => frames.push(frame), log: (line) => logged.push(line), frames: { pictureMs: 1000, firstMs: 1000, backoffMs: [500, 1000], failAfter: 3 } });

    try {
        // Busy for 6 s, starting a moment after it loads.
        await browser.open(1, "data:text/html,<h1>Review and submit</h1><script>setTimeout(()=>{const end=Date.now()+6000;while(Date.now()<end){}},800)</script>");
        await new Promise((resolve) => setTimeout(resolve, 1000));
        browser.watch();
        await until(() => frames.length > 0, "a picture once the page is free", 20_000);
        assert.ok(logged.some((line) => line.includes("took longer than 1 seconds")), `the capture was held: ${logged.join(" | ")}`);
    } finally {
        await browser.close();
    }
});

test("a picture from the screencast is enough: no retry while frames come, though the capture hangs", async () => {
    const devtools = new FakeDevtools();
    const { browser, frames, state } = await browserOn(devtools);

    devtools.captures = ["hang"];
    browser.watch();
    await until(() => devtools.count("Page.startScreencast") === 1, "the screencast");
    devtools.cast();
    await until(() => frames.length === 1, "the frame");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(devtools.count("Page.startScreencast"), 1, "not started again");
    assert.equal(state().pictureError, null);
});
