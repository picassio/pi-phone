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
    /** Each command's parameters, in order. */
    params: { method: string; params: Record<string, unknown> }[] = [];
    /** How long a method's answer takes (a machine's link), in ms. */
    delays: Record<string, number> = {};
    #socket: WebSocket | undefined;
    #frames = 0;

    constructor() {
        this.#server.on("connection", (socket) => {
            this.#socket = socket;
            socket.on("message", (raw) => {
                const { id, method, params } = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };

                this.asked.push(method);
                this.params.push({ method, params: params ?? {} });

                const late = this.delays[method] ?? 0;
                const answer = (result: Record<string, unknown>) => (late > 0 ? setTimeout(() => socket.send(JSON.stringify({ id, result })), late) : socket.send(JSON.stringify({ id, result })));

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
        this.#frames += 1;
        this.#socket?.send(JSON.stringify({ method: "Page.screencastFrame", params: { data: "RlJBTUU=", sessionId: this.#frames, metadata: { deviceWidth: 1280, deviceHeight: 800 } } }));
    }

    /** The frames acknowledged, by their session ids. */
    acked(): unknown[] {
        return this.params.filter((each) => each.method === "Page.screencastFrameAck").map((each) => each.params.sessionId);
    }

    /** The sizes the screencast was started at. */
    castSizes(): { maxWidth: unknown; maxHeight: unknown }[] {
        return this.params.filter((each) => each.method === "Page.startScreencast").map((each) => ({ maxWidth: each.params.maxWidth, maxHeight: each.params.maxHeight }));
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

async function browserOn(devtools: FakeDevtools, tuning: { ackWaitMs?: number } = {}) {
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
        frames: { pictureMs: 150, firstMs: 150, backoffMs: [50, 100], failAfter: 3, ...tuning },
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

    // PP-200: the event stream says a picture is there (its number and size), never the picture itself; the tab fetches
    // the newest when it can draw it.
    const notice = second.last("browser-frame");

    assert.ok(notice !== undefined, "at once");
    assert.equal(notice.jpeg, undefined, "no picture in the event stream");
    assert.equal((await app.browserFrame(owner(app), second.client.connection, "phone", session, 0))?.jpeg, "UElDVFVSRQ==", "fetched, with no new capture");
    assert.equal(devtools.count("Page.captureScreenshot"), captured);

    // A tab that does not watch gets nothing.
    const stranger = fakeTab(undefined, owner(app));

    await app.attach(stranger.client);
    assert.equal(await app.browserFrame(owner(app), stranger.client.connection, "phone", session, 0), undefined);

    // A fetch that waits for the next picture gets it as soon as it comes.
    const seq = Number(notice.seq);
    const next = app.browserFrame(owner(app), second.client.connection, "phone", session, seq, 5000);

    devtools.cast();
    assert.equal((await next)?.jpeg, "RlJBTUU=");
    assert.equal(await app.browserFrame(owner(app), second.client.connection, "phone", session, seq + 1, 100), undefined, "none newer: undefined after the wait");
    app.setBrowserWatch(owner(app), first.client.connection, "phone", session, false);
    app.setBrowserWatch(owner(app), second.client.connection, "phone", session, false);
});

// PP-200: Chrome made frames as fast as it drew them, each acknowledged at once: a slow link or a slow tab fell behind.
test("a frame is acknowledged once the tab took the one before it: never a queue of old ones", async () => {
    const devtools = new FakeDevtools();
    const { browser } = await browserOn(devtools, { ackWaitMs: 60_000 });

    devtools.captures = ["ok"];
    browser.watch();
    await until(() => browser.lastFrame() !== undefined && devtools.count("Page.startScreencast") === 1, "the first picture and the cast");

    // The first picture is not taken yet: the cast's frame waits for it.
    devtools.cast();
    await until(() => browser.lastFrame()?.jpeg === "RlJBTUU=", "the frame");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(devtools.acked(), [], "not acknowledged while the tab is behind");

    // Taken: acknowledged, and the next frame (the tab keeping up) at once.
    browser.frameTaken(browser.lastFrame()!.seq);
    await until(() => devtools.acked().length === 1, "acknowledged once taken");
    devtools.cast();
    await until(() => devtools.acked().length === 2, "the next at once: the tab took the one before");

    // Not taken: the third waits again.
    devtools.cast();
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(devtools.acked().length, 2);
});

test("frames are as big as the largest picture a watching tab draws, at most twice the page", async () => {
    const devtools = new FakeDevtools();
    const { browser } = await browserOn(devtools);
    const panel = browser.watch({ width: 760, height: 475 });

    await until(() => devtools.castSizes().length === 1, "the cast");
    assert.deepEqual(devtools.castSizes()[0], { maxWidth: 760, maxHeight: 475 });

    // A smaller one watching too: the larger stays. A tab that grows: frames grow with it; a small change is no change.
    browser.watch({ width: 140, height: 90 });
    panel.resize({ width: 780, height: 487 });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(devtools.castSizes().length, 1);
    panel.resize({ width: 1200, height: 750 });
    await until(() => devtools.castSizes().length === 2, "a new size");
    assert.deepEqual(devtools.castSizes()[1], { maxWidth: 1200, maxHeight: 750 });
    panel.resize({ width: 5000, height: 4000 });
    await until(() => devtools.castSizes().length === 3, "the most");
    assert.deepEqual(devtools.castSizes()[2], { maxWidth: 1600, maxHeight: 1600 });
});

// PP-200: over a machine's link each of the panel's keys waited for a navigation 300 ms, and each command for its round
// trip; ten keys took 4.4 s on a 25 ms link.
test("Take over: a key goes without waiting for a navigation, a tap's two events at once", async () => {
    const devtools = new FakeDevtools();
    const { browser } = await browserOn(devtools);

    browser.takeOver(true);
    devtools.delays = { "Input.dispatchKeyEvent": 50, "Input.dispatchMouseEvent": 100 };

    let started = Date.now();

    assert.equal(await browser.input({ type: "key", key: "Enter" }), null, "no focus read after a key");
    assert.ok(Date.now() - started < 200, `a key took ${Date.now() - started} ms`);

    started = Date.now();
    await browser.input({ type: "tap", x: 10, y: 10 });
    assert.ok(Date.now() - started < 190, `a tap took ${Date.now() - started} ms (two round trips of 100 ms one after the other before)`);
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
