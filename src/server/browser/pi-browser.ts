/**
 * Pi's browser: one page Pi reads and acts on (`page.ts`), that people watch live (the Browser panel's frames) and can
 * take over. The page comes from an engine: on the phone, a WebView of the app's own that its service makes for Pi
 * (`PiBrowser.java`), reached over the WebView's DevTools socket; elsewhere (tests, a computer), a headless Chrome.
 * Pi's actions run one at a time; frames flow only while someone watches.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PhoneRequests } from "../phone-requests.ts";
import { Cdp } from "./cdp.ts";
import { BrowserPage, type Element, type Observed, describe, elementsOf } from "./page.ts";

/** The page's size in CSS pixels: a phone's, as the WebView is a phone's browser. */
export const VIEWPORT = { width: 412, height: 860, mobile: true };

/** Where Pi's page comes from. */
export interface BrowserEngine {
    /** What it is, for messages ("the phone's WebView"). */
    readonly label: string;
    /** Make (or find again) Pi's page and connect to it. */
    open(): Promise<Cdp>;
    /** Remove Pi's page. */
    close(): Promise<void>;
}

const getJson = (options: http.RequestOptions): Promise<unknown> =>
    new Promise((resolve, reject) => {
        const request = http.request({ method: "GET", headers: { host: "localhost" }, timeout: 5000, ...options }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    reject(new Error(`The browser answered ${options.path} with no JSON.`));
                }
            });
        });

        request.on("error", reject);
        request.on("timeout", () => request.destroy(new Error("The browser did not answer in time.")));
        request.end();
    });

/** On the phone: the app's service makes a WebView for Pi; its DevTools socket is the app's (`\0webview_devtools_remote_<pid>`). */
export class PhoneEngine implements BrowserEngine {
    readonly label = "the phone's browser";
    readonly #requests: PhoneRequests;

    constructor(requests: PhoneRequests) {
        this.#requests = requests;
    }

    async open(): Promise<Cdp> {
        const marker = `pi-browser-${crypto.randomUUID()}`;
        const answer = await this.#requests.request({ op: "open", marker, width: VIEWPORT.width, height: VIEWPORT.height });
        const pid = Number(answer.pid);

        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error("The phone did not say which process its browser is in.");
        }

        const socket = `\0webview_devtools_remote_${pid}`;
        const until = Date.now() + 10_000;

        // The WebView's page shows in the DevTools list once it loaded `about:blank#<marker>`; a page kept from before
        // keeps the marker it was opened with, so the service answers with that one.
        const wanted = typeof answer.marker === "string" ? answer.marker : marker;

        while (Date.now() < until) {
            const targets = (await getJson({ socketPath: socket, path: "/json/list" })) as { id: string; url: string; webSocketDebuggerUrl?: string }[];
            const target = targets.find((each) => each.url.includes(wanted)) ?? targets.find((each) => each.id === answer.target);

            if (target !== undefined) {
                return Cdp.connect({ socket, path: `/devtools/page/${target.id}` });
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        throw new Error("The phone made its browser, but its page did not show up to connect to.");
    }

    async close(): Promise<void> {
        await this.#requests.request({ op: "close" }).catch(() => {});
    }
}

/** A headless Chrome of its own (tests, a computer): launched on first use, with a profile that goes with it. */
export class ChromeEngine implements BrowserEngine {
    readonly label = "Chrome";
    readonly #binary: string;
    readonly #flags: string[];
    #child: ChildProcess | undefined;
    #profile: string | undefined;
    #port: number | undefined;

    /** `flags`: more of Chrome's command line (a test maps a name to its local server: `--host-resolver-rules`). */
    constructor(binary: string, flags: string[] = []) {
        this.#binary = binary;
        this.#flags = flags;
    }

    async open(): Promise<Cdp> {
        if (this.#child === undefined || this.#child.exitCode !== null) {
            this.#profile = mkdtempSync(join(tmpdir(), "pi-browser-"));
            this.#child = spawn(
                this.#binary,
                ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.#profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...this.#flags, "about:blank"],
                { stdio: "ignore" },
            );

            const until = Date.now() + 15_000;

            while (Date.now() < until && this.#port === undefined) {
                try {
                    this.#port = Number(readFileSync(join(this.#profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 100));
                }
            }

            if (this.#port === undefined) {
                throw new Error(`Chrome (${this.#binary}) did not start.`);
            }
        }

        const targets = (await getJson({ host: "127.0.0.1", port: this.#port, path: "/json/list", headers: { host: `127.0.0.1:${this.#port}` } })) as { id: string; type: string }[];
        const page = targets.find((each) => each.type === "page");

        if (page === undefined) {
            throw new Error("Chrome has no page to drive.");
        }

        // Its own address, not the one Chrome writes in the list (built from the request's Host header).
        return Cdp.connect({ url: `ws://127.0.0.1:${this.#port}/devtools/page/${page.id}` });
    }

    async close(): Promise<void> {
        const child = this.#child;

        this.#child = undefined;
        this.#port = undefined;

        // Chrome writes to its profile until it has gone: wait for it (5 s at most), then remove the profile.
        if (child !== undefined && child.exitCode === null) {
            const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));

            child.kill();
            await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 5000))]);
        }

        if (this.#profile !== undefined) {
            rmSync(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            this.#profile = undefined;
        }
    }
}

/** What the Browser panel shows: whether Pi's browser is open, where, what Pi does, and who has it. */
export type BrowserState = {
    open: boolean;
    url: string;
    title: string;
    /** What Pi is doing now ("Clicking [3] Search"), or null. */
    doing: string | null;
    /** The session that used it last. */
    session: number | null;
    /** A person took it over: Pi's actions wait until they hand it back. */
    takenOver: boolean;
    viewport: { width: number; height: number };
};

/** A frame of the page for the panel: a JPEG (base64) of the viewport. */
export type BrowserFrame = { jpeg: string; width: number; height: number };

export type PiBrowserOptions = {
    engine: BrowserEngine;
    /** The state changed: tabs that show the panel get it. */
    changed(state: BrowserState): void;
    /** A frame for those watching. */
    frame(frame: BrowserFrame): void;
    log(line: string): void;
};

export class PiBrowser {
    readonly #options: PiBrowserOptions;
    #page: BrowserPage | undefined;
    #opening: Promise<BrowserPage> | undefined;
    /** Pi's actions, one after another. */
    #queue: Promise<unknown> = Promise.resolve();
    #observed: Observed | undefined;
    #elements: Element[] = [];
    #state: BrowserState = { open: false, url: "", title: "", doing: null, session: null, takenOver: false, viewport: { width: VIEWPORT.width, height: VIEWPORT.height } };
    #watchers = 0;
    #casting = false;
    #stopFrames: (() => void) | undefined;

    constructor(options: PiBrowserOptions) {
        this.#options = options;
    }

    state(): BrowserState {
        return this.#state;
    }

    #set(patch: Partial<BrowserState>): void {
        this.#state = { ...this.#state, ...patch };
        this.#options.changed(this.#state);
    }

    /** The page, opened on first use; a closed connection opens it again. */
    async #ensure(): Promise<BrowserPage> {
        if (this.#page !== undefined && !this.#page.cdp.closed) {
            return this.#page;
        }

        this.#opening ??= (async () => {
            const cdp = await this.#options.engine.open();
            const page = new BrowserPage(cdp);

            await page.init(VIEWPORT);
            cdp.onClose = () => {
                if (this.#page === page) {
                    this.#page = undefined;
                    this.#casting = false;
                    this.#observed = undefined;
                    this.#set({ open: false, doing: null });
                }
            };
            cdp.on("Page.frameNavigated", (params) => {
                const frame = params.frame as { parentId?: string; url?: string } | undefined;

                if (frame !== undefined && frame.parentId === undefined) {
                    this.#set({ url: frame.url ?? "" });
                }
            });
            this.#page = page;
            this.#set({ open: true });

            // Pictures for those watching are extra: their failure never fails Pi's work.
            if (this.#watchers > 0) {
                void this.#startFrames().catch((error: unknown) => this.#options.log(`browser frames: ${String(error)}`));
            }

            return page;
        })().finally(() => {
            this.#opening = undefined;
        });

        return this.#opening;
    }

    /** Run one of Pi's actions after the ones before, with what it is doing shown in the panel. */
    #run<T>(session: number, doing: string, work: (page: BrowserPage) => Promise<T>): Promise<T> {
        const next = this.#queue.then(async () => {
            if (this.#state.takenOver) {
                throw new Error("The person took over Pi's browser: wait until they hand it back (or ask them to).");
            }

            this.#set({ doing, session });

            try {
                return await work(await this.#ensure());
            } finally {
                this.#set({ doing: null });
            }
        });

        this.#queue = next.catch(() => {});

        return next;
    }

    /** Read the page, keep what was read (for the next action's numbers), and describe it for Pi. */
    async #read(page: BrowserPage): Promise<string> {
        const observed = await page.observe();

        this.#observed = observed;
        this.#elements = elementsOf(observed);
        this.#set({ url: observed.url, title: observed.title });

        const dialog = page.dialog;

        page.dialog = undefined;

        return `${dialog === undefined ? "" : `The page showed a dialog (${dialog}); it was ${page.acceptDialogs ? "accepted" : "declined"}.\n`}${describe(observed, this.#elements)}`;
    }

    #element(index: number): { observed: Observed; element: Element } {
        const observed = this.#observed;
        const element = this.#elements.find((each) => each.index === index);

        if (observed === undefined) {
            throw new Error("Read the page first (browser_snapshot or browser_open).");
        }

        if (element === undefined) {
            throw new Error(`There is no [${index}] on the page as last read (it has ${this.#elements.length}).`);
        }

        return { observed, element };
    }

    open(session: number, url: string): Promise<string> {
        return this.#run(session, `Opening ${url}`, async (page) => {
            await page.navigate(url);

            return this.#read(page);
        });
    }

    snapshot(session: number): Promise<string> {
        return this.#run(session, "Reading the page", (page) => this.#read(page));
    }

    /** What Pi is doing to [index], named as the page last read it. */
    #doing(verb: string, index: number): string {
        const element = this.#elements.find((each) => each.index === index);

        return `${verb} [${index}]${element === undefined ? "" : ` ${element.label}`}`;
    }

    click(session: number, index: number, acceptDialog = false): Promise<string> {
        return this.#run(session, this.#doing("Clicking", index), async (page) => {
            const { observed, element } = this.#element(index);

            page.acceptDialogs = acceptDialog;

            try {
                await page.click(observed, element);

                return this.#read(page);
            } finally {
                page.acceptDialogs = false;
            }
        });
    }

    type(session: number, index: number, text: string, options: { clear?: boolean; submit?: boolean }): Promise<string> {
        return this.#run(session, this.#doing("Typing into", index), async (page) => {
            const { observed, element } = this.#element(index);

            await page.type(observed, element, text, options);

            return this.#read(page);
        });
    }

    select(session: number, index: number, option: string): Promise<string> {
        return this.#run(session, this.#doing(`Choosing ${JSON.stringify(option)} in`, index), async (page) => {
            const { observed, element } = this.#element(index);
            const chosen = await page.select(observed, element, option);

            return `Chose ${JSON.stringify(chosen)}.\n${await this.#read(page)}`;
        });
    }

    scroll(session: number, direction: "up" | "down", screens: number): Promise<string> {
        return this.#run(session, `Scrolling ${direction}`, async (page) => {
            await page.scroll(direction, screens);

            return this.#read(page);
        });
    }

    press(session: number, key: string, acceptDialog = false): Promise<string> {
        return this.#run(session, `Pressing ${key}`, async (page) => {
            page.acceptDialogs = acceptDialog;

            try {
                await page.press(key);

                return this.#read(page);
            } finally {
                page.acceptDialogs = false;
            }
        });
    }

    history(session: number, step: -1 | 1): Promise<string> {
        return this.#run(session, step < 0 ? "Going back" : "Going forward", async (page) => {
            if (!(await page.history(step))) {
                return `There is no page to go ${step < 0 ? "back" : "forward"} to.\n${await this.#read(page)}`;
            }

            return this.#read(page);
        });
    }

    text(session: number, max: number): Promise<{ title: string; url: string; text: string; cut: boolean }> {
        return this.#run(session, "Reading the whole page", (page) => page.text(max));
    }

    screenshot(session: number): Promise<string> {
        return this.#run(session, "Looking at the page", (page) => page.screenshot());
    }

    wait(session: number, wait: { text?: string; seconds?: number }): Promise<string> {
        return this.#run(session, wait.text ? `Waiting for ${JSON.stringify(wait.text)}` : "Waiting", async (page) => {
            const showed = await page.wait(wait);

            return `${showed ? "" : `${JSON.stringify(wait.text)} did not show within 30 seconds.\n`}${await this.#read(page)}`;
        });
    }

    /** Close Pi's page (Settings, or the panel's Close). */
    async close(): Promise<void> {
        await this.#queue;
        this.#stopFrames?.();
        this.#page?.cdp.close();
        this.#page = undefined;
        this.#observed = undefined;
        await this.#options.engine.close();
        this.#set({ open: false, doing: null, url: "", title: "", takenOver: false });
    }

    // ─── Watching and taking over ─────────────────────────────────────────────

    /** A tab started showing the panel: frames flow while anyone watches. Returns how to stop. */
    watch(): () => void {
        this.#watchers += 1;

        if (this.#page !== undefined && !this.#page.cdp.closed) {
            void this.#startFrames().catch((error: unknown) => this.#options.log(`browser frames: ${String(error)}`));
        }

        let stopped = false;

        return () => {
            if (stopped) {
                return;
            }

            stopped = true;
            this.#watchers -= 1;

            if (this.#watchers === 0) {
                this.#stopFrames?.();
            }
        };
    }

    async #startFrames(): Promise<void> {
        const page = this.#page;

        if (page === undefined || this.#casting) {
            return;
        }

        this.#casting = true;

        const off = page.cdp.on("Page.screencastFrame", (params) => {
            const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;

            this.#options.frame({ jpeg: String(params.data), width: metadata?.deviceWidth ?? VIEWPORT.width, height: metadata?.deviceHeight ?? VIEWPORT.height });
            void page.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        });

        this.#stopFrames = () => {
            off();
            this.#casting = false;
            this.#stopFrames = undefined;
            void page.cdp.send("Page.stopScreencast").catch(() => {});
        };
        await page.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width * 2, maxHeight: VIEWPORT.height * 2, everyNthFrame: 1 });
        // A still page sends no new frames: one now, so the panel has a picture at once.
        this.#options.frame({ jpeg: await page.screenshot(60), width: VIEWPORT.width, height: VIEWPORT.height });
    }

    /** A person takes Pi's browser over (their taps and typing go to the page), or hands it back. */
    takeOver(on: boolean): void {
        this.#set({ takenOver: on });
    }

    /** The person's input while they have it: a tap or a scroll at CSS pixels of the page, text, or a key. */
    async input(event: { type: "tap"; x: number; y: number } | { type: "scroll"; x: number; y: number; dy: number } | { type: "text"; text: string } | { type: "key"; key: string }): Promise<void> {
        if (!this.#state.takenOver) {
            throw new Error("Take over Pi's browser first.");
        }

        const page = await this.#ensure();

        if (event.type === "tap") {
            for (const type of ["mousePressed", "mouseReleased"]) {
                await page.cdp.send("Input.dispatchMouseEvent", { type, x: event.x, y: event.y, button: "left", clickCount: 1 });
            }
        } else if (event.type === "scroll") {
            await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: 0, deltaY: event.dy });
        } else if (event.type === "text") {
            await page.cdp.send("Input.insertText", { text: event.text });
        } else {
            await page.press(event.key);
        }
    }

    /** Open an address for the person (the panel's address bar, while they have it). */
    async navigateFor(url: string): Promise<void> {
        if (!this.#state.takenOver) {
            throw new Error("Take over Pi's browser first.");
        }

        await (await this.#ensure()).navigate(url);
    }
}
