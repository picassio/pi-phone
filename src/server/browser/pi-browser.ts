/**
 * Pi's browser: the tabs Pi reads and acts on (`page.ts`), that people watch live (the Browser panel's frames) and can
 * take over. Tabs come from an engine: on the phone, WebViews of the app's own that its service makes for Pi
 * (`PiBrowser.java`), reached over the WebView's DevTools socket; elsewhere (tests, a computer), a headless Chrome.
 * Pi's actions run one at a time, on the tab in front; frames flow only while someone watches.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { PhoneRequests } from "../phone-requests.ts";
import { Cdp } from "./cdp.ts";
import { BrowserPage, type Element, type Observed, type PictureClip, type PictureOptions, describe, elementsOf, StalePage } from "./page.ts";
import { type Mark, type MarkArea, markUp } from "../markup.ts";

/** A mark on a page's picture (PP-119): on a control by its number, on a text shown, or on an area of the view (CSS pixels). */
export type PageMark = Omit<Mark, "area"> & { index?: number; text?: string; area?: MarkArea };
import { type Decider, type RunResult, runGoal } from "./run.ts";

/** The page's size in CSS pixels: a phone's, as the WebView is a phone's browser. */
export const VIEWPORT = { width: 412, height: 860, mobile: true };
/** Where the page's focus is: whether it takes text, and whether it is a password field (inside open shadow roots too). */
const FOCUS_SCRIPT = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e || e === document.body) return { editable: false, password: false };
  const tag = e.tagName.toLowerCase();
  const type = (e.getAttribute('type') || 'text').toLowerCase();
  const fields = ['text', 'password', 'email', 'search', 'tel', 'url', 'number'];
  const editable = e.isContentEditable || tag === 'textarea' || (tag === 'input' && fields.includes(type));
  return { editable, password: tag === 'input' && type === 'password' };
})()`;

/** The two sizes a session's browser lays pages out at (PP-15). */
export const SIZES = { phone: VIEWPORT, desktop: { width: 1280, height: 800, mobile: false } } as const;
export type BrowserSize = keyof typeof SIZES;
/** Tabs open at once, at most (each is a WebView on the phone). */
export const MAX_TABS = 6;

/** Where Pi's tabs come from. */
export interface BrowserEngine {
    /** What it is, for messages ("the phone's browser"). */
    readonly label: string;
    /** Whether pages open tabs of their own (a link to a new window): Chrome's do; the phone's WebView opens them in place. */
    readonly popups: boolean;
    /** Whether it may open local addresses: a machine's own Chrome may (its dev servers); the phone's WebView never. */
    readonly local: boolean;
    /** Whether its pages present themselves as a phone's (a desktop Chrome does; the phone's WebView is one). */
    readonly actAsPhone: boolean;
    /**
     * Whether a tab's view keeps the size it was opened at (the phone's WebView, on a display of that size, which draws its
     * pictures at it): a new size then reopens each tab at its address. Chrome lays a tab out at any size.
     */
    readonly reopensToResize: boolean;
    /** Pi's tabs there now (kept from before the server restarted, or opened by pages), by id, oldest first. */
    tabs(): Promise<string[]>;
    /** Make a new tab, laid out at `size` (CSS pixels; the phone's by default): its id. */
    newTab(size?: { width: number; height: number }): Promise<string>;
    /** Connect to a tab. */
    connect(id: string): Promise<Cdp>;
    closeTab(id: string): Promise<void>;
    /** Close every tab (and the browser). */
    close(): Promise<void>;
    /** The tab's page as a PDF, as printing it would make. */
    pdf(id: string, page: BrowserPage): Promise<Buffer>;
    /** What is in view in the tab now, as a JPEG (base64), or a PNG; or a part of it. */
    picture(id: string, page: BrowserPage, quality: number, timeoutMs?: number, options?: PictureOptions): Promise<string>;
    /** Put a file where the browser can read it, for an upload: its path there. */
    stage(name: string, bytes: Uint8Array): Promise<string>;
}

const request = (options: http.RequestOptions): Promise<string> =>
    new Promise((resolve, reject) => {
        const sent = http.request({ method: "GET", headers: { host: "localhost" }, timeout: 5000, ...options }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => resolve(body));
        });

        sent.on("error", reject);
        sent.on("timeout", () => sent.destroy(new Error("The browser did not answer in time.")));
        sent.end();
    });

const getJson = async (options: http.RequestOptions): Promise<unknown> => {
    const body = await request(options);

    try {
        return JSON.parse(body);
    } catch {
        throw new Error(`The browser answered ${options.path} with no JSON.`);
    }
};

/** Files for uploads, in this device's temporary folder (the phone's WebView and a local Chrome read them there). */
const UPLOADS = join(tmpdir(), "pi-browser-uploads");

/** Write a file for an upload, and remove ones a day old (the page reads a file when it sends it, not when it is chosen). */
export function stageLocally(name: string, bytes: Uint8Array): string {
    mkdirSync(UPLOADS, { recursive: true });

    for (const each of readdirSync(UPLOADS)) {
        const path = join(UPLOADS, each);

        if (Date.now() - statSync(path).mtimeMs > 86_400_000) {
            rmSync(path, { recursive: true, force: true });
        }
    }

    const folder = join(UPLOADS, crypto.randomUUID());
    const path = join(folder, basename(name));

    mkdirSync(folder);
    writeFileSync(path, bytes);

    return path;
}

/**
 * On the phone: the app's service makes a WebView per tab; their DevTools socket is the app's
 * (`\0webview_devtools_remote_<pid>`). A tab's id is the marker its WebView first loaded (`about:blank#<marker>`).
 */
export class PhoneEngine implements BrowserEngine {
    readonly label = "the phone's browser";
    readonly popups = false;
    readonly local = false;
    readonly actAsPhone = false;
    readonly reopensToResize = true;
    readonly #requests: PhoneRequests;
    #pid = 0;
    /** Each tab's address as the phone last said (a tab kept from before has moved on from its marker). */
    readonly #urls = new Map<string, string>();
    /** The DevTools target each connected tab is, so two tabs at one address are told apart. */
    readonly #targets = new Map<string, string>();

    constructor(requests: PhoneRequests) {
        this.#requests = requests;
    }

    #socket(answer: Record<string, unknown>): string {
        const pid = Number(answer.pid);

        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error("The phone did not say which process its browser is in.");
        }

        this.#pid = pid;

        return `\0webview_devtools_remote_${pid}`;
    }

    async tabs(): Promise<string[]> {
        const answer = await this.#requests.request({ op: "tabs" });
        const tabs = (answer.tabs ?? []) as { marker: string; url: string }[];

        this.#socket(answer);

        for (const tab of tabs) {
            this.#urls.set(tab.marker, tab.url);
        }

        return tabs.map((tab) => tab.marker);
    }

    async newTab(size: { width: number; height: number } = VIEWPORT): Promise<string> {
        const marker = `pi-browser-${crypto.randomUUID()}`;

        this.#socket(await this.#requests.request({ op: "open", marker, width: size.width, height: size.height }));
        this.#urls.set(marker, `about:blank#${marker}`);

        return marker;
    }

    async connect(id: string): Promise<Cdp> {
        const socket = `\0webview_devtools_remote_${this.#pid}`;
        const until = Date.now() + 10_000;

        // A new tab shows in the DevTools list once it loaded `about:blank#<marker>`; one kept from before, at its address.
        while (Date.now() < until) {
            const targets = (await getJson({ socketPath: socket, path: "/json/list" })) as { id: string; url: string }[];
            const taken = new Set([...this.#targets].filter(([tab]) => tab !== id).map(([, target]) => target));
            const url = this.#urls.get(id);
            const target = targets.find((each) => !taken.has(each.id) && (each.url.includes(id) || (url !== undefined && url !== "" && each.url === url)));

            if (target !== undefined) {
                this.#targets.set(id, target.id);

                return Cdp.connect({ socket, path: `/devtools/page/${target.id}` });
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        throw new Error("The phone made the tab, but its page did not show up to connect to.");
    }

    async closeTab(id: string): Promise<void> {
        this.#targets.delete(id);
        this.#urls.delete(id);
        await this.#requests.request({ op: "close", marker: id });
    }

    async close(): Promise<void> {
        this.#targets.clear();
        this.#urls.clear();
        await this.#requests.request({ op: "close" }).catch(() => {});
    }

    /** The WebView prints it (Android's print to PDF, without the dialog): DevTools there has no printToPDF. */
    async pdf(id: string): Promise<Buffer> {
        const path = join(tmpdir(), `pi-browser-${crypto.randomUUID()}.pdf`);

        try {
            await this.#requests.request({ op: "pdf", marker: id, path }, 90_000);

            return readFileSync(path);
        } finally {
            rmSync(path, { force: true });
        }
    }

    /**
     * From the frames of the tab's own display (PiBrowser.java's `shot`): DevTools' capture of the phone's WebView hangs on
     * every other call (PP-114).
     */
    async picture(id: string, _page: BrowserPage, quality: number, timeoutMs = 30_000, { png = false, clip }: PictureOptions = {}): Promise<string> {
        const answer = await this.#requests.request({ op: "shot", marker: id, quality, png, ...(clip === undefined ? {} : { clip }) }, timeoutMs);

        if (typeof answer.jpeg !== "string" || answer.jpeg === "") {
            throw new Error("The phone answered no picture of the page.");
        }

        return answer.jpeg;
    }

    async stage(name: string, bytes: Uint8Array): Promise<string> {
        return stageLocally(name, bytes);
    }
}

/**
 * A headless Chrome of its own (tests, a computer, the server edition): launched on first use, with a profile that goes
 * with it, or one kept in `profile` (the server edition's, in its home: sign-ins stay across restarts).
 */
export class ChromeEngine implements BrowserEngine {
    readonly label = "Chrome";
    readonly popups = true;
    readonly local = false;
    readonly actAsPhone = true;
    readonly reopensToResize: boolean = false;
    readonly #binary: string;
    readonly #flags: string[];
    readonly #kept: string | undefined;
    #child: ChildProcess | undefined;
    #profile: string | undefined;
    #port: number | undefined;

    /** `flags`: more of Chrome's command line (a test maps a name to its local server: `--host-resolver-rules`). */
    constructor(binary: string, flags: string[] = [], { profile }: { profile?: string } = {}) {
        this.#binary = binary;
        this.#flags = flags;
        this.#kept = profile;
    }

    async #start(): Promise<number> {
        if (this.#child !== undefined && this.#child.exitCode === null && this.#port !== undefined) {
            return this.#port;
        }

        if (this.#kept !== undefined) {
            mkdirSync(this.#kept, { recursive: true, mode: 0o700 });
            // The port of a Chrome that ran before is not this one's.
            rmSync(join(this.#kept, "DevToolsActivePort"), { force: true });
        }

        this.#profile = this.#kept ?? mkdtempSync(join(tmpdir(), "pi-browser-"));
        this.#port = undefined;
        this.#child = spawn(
            this.#binary,
            ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${this.#profile}`, "--no-first-run", "--no-default-browser-check", "--disable-gpu", ...this.#flags, "about:blank"],
            { stdio: "ignore" },
        );

        // A cold start on a busy computer (CI) can take a while.
        const until = Date.now() + 45_000;

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

        return this.#port;
    }

    async #list(): Promise<{ id: string; type: string }[]> {
        const port = await this.#start();

        return (await getJson({ host: "127.0.0.1", port, path: "/json/list", headers: { host: `127.0.0.1:${port}` } })) as { id: string; type: string }[];
    }

    async tabs(): Promise<string[]> {
        // Chrome lists the newest first.
        return (await this.#list())
            .filter((each) => each.type === "page")
            .map((each) => each.id)
            .reverse();
    }

    async newTab(): Promise<string> {
        const port = await this.#start();
        const made = (await getJson({ method: "PUT", host: "127.0.0.1", port, path: "/json/new?about:blank", headers: { host: `127.0.0.1:${port}` } })) as { id: string };

        return made.id;
    }

    async connect(id: string): Promise<Cdp> {
        // Its own address, not the one Chrome writes in the list (built from the request's Host header).
        return Cdp.connect({ url: `ws://127.0.0.1:${await this.#start()}/devtools/page/${id}` });
    }

    async closeTab(id: string): Promise<void> {
        const port = await this.#start();

        await request({ host: "127.0.0.1", port, path: `/json/close/${id}`, headers: { host: `127.0.0.1:${port}` } });

        // Chrome closes it a moment later: until then it is still listed, and would be taken for a tab a page opened.
        const until = Date.now() + 5000;

        while (Date.now() < until && (await this.#list()).some((each) => each.id === id)) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    async close(): Promise<void> {
        const child = this.#child;

        this.#child = undefined;
        this.#port = undefined;

        // Chrome writes to its profile until it has gone: wait for it (5 s at most), then remove the profile. One that
        // does not stop is killed: a Chrome left running keeps this process alive (a CI job hung on it for 20 minutes).
        if (child !== undefined && child.exitCode === null && child.signalCode === null) {
            const gone = new Promise<void>((resolve) => child.once("exit", () => resolve()));
            const wait = (ms: number) => Promise.race([gone, new Promise((resolve) => setTimeout(resolve, ms))]);

            child.kill();
            await wait(5000);

            if (child.exitCode === null && child.signalCode === null) {
                child.kill("SIGKILL");
                await wait(2000);
            }
        }

        if (this.#profile !== undefined && this.#profile !== this.#kept) {
            rmSync(this.#profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
            this.#profile = undefined;
        }
    }

    async pdf(_id: string, page: BrowserPage): Promise<Buffer> {
        const printed = await page.cdp.send<{ data: string }>("Page.printToPDF", { printBackground: true });

        return Buffer.from(printed.data, "base64");
    }

    picture(_id: string, page: BrowserPage, quality: number, timeoutMs?: number, options?: PictureOptions): Promise<string> {
        return page.screenshot(quality, timeoutMs, options);
    }

    async stage(name: string, bytes: Uint8Array): Promise<string> {
        return stageLocally(name, bytes);
    }
}

/** What the Browser panel shows: whether Pi's browser is open, its tabs, what Pi does, and who has it. */
export type BrowserState = {
    /** Which browser: `phone`, or `machine:<id>` for a machine's Chrome; and where that is, in words. */
    place: string;
    where: string;
    open: boolean;
    url: string;
    title: string;
    /** Every tab, oldest first, and which is in front (0-based). */
    tabs: { url: string; title: string }[];
    tab: number;
    /** What Pi is doing now ("Clicking [3] Search"), or null. */
    doing: string | null;
    /** The session that used it last. */
    session: number | null;
    /** A person took it over: Pi's actions wait until they hand it back. */
    takenOver: boolean;
    viewport: { width: number; height: number };
    /** Phone or Desktop: the size its pages are laid out at. */
    size: BrowserSize;
};

/** A frame of the page for the panel: a JPEG (base64) of the viewport. */
export type BrowserFrame = { jpeg: string; width: number; height: number };

export type PiBrowserOptions = {
    engine: BrowserEngine;
    /** Which browser this is (`phone`, or `machine:<id>`), and where, in words ("the phone", a machine's name). */
    place?: string;
    where?: string;
    /** The session whose browser this is (PP-13): each session has its own tabs at a place. */
    session?: number;
    /** The size it starts at (PP-18: the one the session picked before), and where a new one is kept. */
    size?: BrowserSize;
    sized?(size: BrowserSize): void;
    /** The state changed: tabs that show the panel get it. */
    changed(state: BrowserState): void;
    /** A frame for those watching. */
    frame(frame: BrowserFrame): void;
    log(line: string): void;
};

/** A tab Pi has: its page, and what it read there last (for the next action's numbers). */
type Tab = { id: string; page: BrowserPage; observed: Observed | undefined; elements: Element[]; url: string; title: string };

export class PiBrowser {
    readonly #options: PiBrowserOptions;
    #tabs: Tab[] = [];
    /** The tab in front: Pi acts there, and people watch it. */
    #tab: Tab | undefined;
    #opening: Promise<Tab> | undefined;
    /** Pi's actions, one after another. */
    #queue: Promise<unknown> = Promise.resolve();
    #state: BrowserState = { place: "phone", where: "the phone", open: false, url: "", title: "", tabs: [], tab: 0, doing: null, session: null, takenOver: false, viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, size: "phone" };
    #watchers = 0;
    /** When Pi or a person last used it (an action, a tap, a tab shown): idle tabs close (`idleFor`). */
    #usedAt = Date.now();
    #casting: BrowserPage | undefined;
    #stopFrames: (() => void) | undefined;

    constructor(options: PiBrowserOptions) {
        this.#options = options;
        const size = options.size ?? "phone";

        this.#state = { ...this.#state, place: options.place ?? "phone", where: options.where ?? "the phone", session: options.session ?? null, size, viewport: { width: SIZES[size].width, height: SIZES[size].height } };
    }

    /** Which browser this is: `phone`, or `machine:<id>`. */
    get place(): string {
        return this.#state.place;
    }

    state(): BrowserState {
        return this.#state;
    }

    #set(patch: Partial<BrowserState>): void {
        const front = this.#tab;

        this.#state = {
            ...this.#state,
            ...patch,
            open: this.#tabs.length > 0,
            tabs: this.#tabs.map((tab) => ({ url: tab.url, title: tab.title })),
            tab: front === undefined ? 0 : Math.max(0, this.#tabs.indexOf(front)),
            url: front?.url ?? "",
            title: front?.title ?? "",
        };
        this.#options.changed(this.#state);
    }

    /** Connect to a tab the engine has, and keep it. */
    async #attach(id: string): Promise<Tab> {
        const cdp = await this.#options.engine.connect(id);
        const page = new BrowserPage(cdp);
        const tab: Tab = { id, page, observed: undefined, elements: [], url: "", title: "" };

        await page.init(SIZES[this.#state.size], { local: this.#options.engine.local, phone: this.#options.engine.actAsPhone });
        cdp.onClose = () => {
            if (!this.#tabs.includes(tab)) {
                return;
            }

            this.#tabs = this.#tabs.filter((each) => each !== tab);

            if (this.#tab === tab) {
                this.#front(this.#tabs.at(-1));
            }

            this.#set({ ...(this.#tabs.length === 0 ? { doing: null } : {}) });
        };
        cdp.on("Page.frameNavigated", (params) => {
            const frame = params.frame as { parentId?: string; url?: string } | undefined;

            if (frame !== undefined && frame.parentId === undefined) {
                tab.url = frame.url ?? "";
                this.#set({});
            }
        });
        tab.url = await page.evaluate<string>("location.href").catch(() => "");
        tab.title = await page.evaluate<string>("document.title").catch(() => "");
        this.#tabs.push(tab);

        return tab;
    }

    /** Bring a tab to the front: frames for those watching follow it. */
    #front(tab: Tab | undefined): void {
        if (this.#tab === tab) {
            return;
        }

        this.#stopFrames?.();
        this.#tab = tab;

        // Pictures for those watching are extra: their failure never fails Pi's work.
        if (tab !== undefined && this.#watchers > 0) {
            void this.#startFrames().catch((error: unknown) => this.#options.log(`browser frames: ${String(error)}`));
        }
    }

    /** The tab in front, opened on first use: the tabs the engine kept (a server restart), or a new one. */
    async #ensure(): Promise<Tab> {
        if (this.#tab !== undefined && !this.#tab.page.cdp.closed) {
            return this.#tab;
        }

        this.#opening ??= (async () => {
            const engine = this.#options.engine;
            const kept = await engine.tabs();

            for (const id of kept.length === 0 ? [await engine.newTab(SIZES[this.#state.size])] : kept) {
                if (!this.#tabs.some((tab) => tab.id === id)) {
                    await this.#attach(id);
                }
            }

            this.#front(this.#tabs.at(-1));
            this.#set({});

            return this.#tab!;
        })().finally(() => {
            this.#opening = undefined;
        });

        return this.#opening;
    }

    /**
     * Tabs a page opened (a link to a new window, in Chrome): kept, and the newest brought to the front, as a person's
     * browser shows it. Answers what to tell Pi.
     */
    async #adoptPopups(): Promise<string> {
        if (!this.#options.engine.popups || this.#tabs.length === 0) {
            return "";
        }

        const fresh = (await this.#options.engine.tabs()).filter((id) => !this.#tabs.some((tab) => tab.id === id));

        for (const id of fresh) {
            this.#front(await this.#attach(id));
        }

        return fresh.length === 0 ? "" : `The page opened ${fresh.length === 1 ? "a new tab" : `${fresh.length} new tabs`}; now on tab ${this.#tabs.length} of ${this.#tabs.length}.\n`;
    }

    /** Run one of Pi's actions after the ones before, on the tab in front, with what it is doing shown in the panel. */
    #run<T>(session: number, doing: string, work: (tab: Tab) => Promise<T>): Promise<T> {
        const next = this.#queue.then(async () => {
            if (this.#state.takenOver) {
                throw new Error("The person took over Pi's browser: wait until they hand it back (or ask them to).");
            }

            this.#set({ doing, session });
            this.#usedAt = Date.now();

            try {
                return await work(await this.#ensure());
            } finally {
                this.#usedAt = Date.now();
                this.#set({ doing: null });
            }
        });

        this.#queue = next.catch(() => {});

        return next;
    }

    /** Read the tab in front (after taking in tabs the page opened), keep what was read, and describe it for Pi. */
    async #read(): Promise<string> {
        const opened = await this.#adoptPopups();
        const tab = this.#tab ?? (await this.#ensure());
        const page = tab.page;
        const observed = await page.observe();

        tab.observed = observed;
        tab.elements = elementsOf(observed);
        tab.url = observed.url;
        tab.title = observed.title;
        this.#set({});

        // The dialogs it showed: answered in the page (most), or by DevTools (one the page did not answer itself).
        const dialogs = (await page.takeDialogs()).map((each) => `The page showed a dialog (${each.text}); it was ${each.accepted ? "accepted" : "declined"}.\n`);

        if (page.dialog !== undefined) {
            dialogs.push(`The page showed a dialog (${page.dialog}); it was ${page.acceptDialogs ? "accepted" : "declined"}.\n`);
            page.dialog = undefined;
        }

        return `${opened}${this.#tabs.length > 1 ? `Tab ${this.#tabs.indexOf(tab) + 1} of ${this.#tabs.length}. ` : ""}${dialogs.join("")}${describe(observed, tab.elements)}`;
    }

    #element(index: number): { observed: Observed; element: Element } {
        const observed = this.#tab?.observed;
        const elements = this.#tab?.elements ?? [];
        const element = elements.find((each) => each.index === index);

        if (observed === undefined) {
            throw new Error("Read the page first (browser_snapshot or browser_open).");
        }

        if (element === undefined) {
            throw new Error(`There is no [${index}] on the page as last read (it has ${elements.length}).`);
        }

        return { observed, element };
    }

    open(session: number, url: string): Promise<string> {
        return this.#run(session, `Opening ${url}`, async (tab) => {
            await tab.page.navigate(url);

            return this.#read();
        });
    }

    snapshot(session: number): Promise<string> {
        return this.#run(session, "Reading the page", () => this.#read());
    }

    /** What Pi is doing to [index], named as the page last read it. */
    #doing(verb: string, index: number): string {
        const element = this.#tab?.elements.find((each) => each.index === index);

        return `${verb} [${index}]${element === undefined ? "" : ` ${element.label}`}`;
    }

    click(session: number, index: number, acceptDialog = false): Promise<string> {
        return this.#run(session, this.#doing("Clicking", index), async ({ page }) => {
            const { observed, element } = this.#element(index);

            await page.setAcceptDialogs(acceptDialog);

            try {
                await page.click(observed, element);

                return await this.#read();
            } finally {
                await page.setAcceptDialogs(false);
            }
        });
    }

    hover(session: number, index: number): Promise<string> {
        return this.#run(session, this.#doing("Pointing at", index), async ({ page }) => {
            const { observed, element } = this.#element(index);

            await page.hover(observed, element);

            return this.#read();
        });
    }

    type(session: number, index: number, text: string, options: { clear?: boolean; submit?: boolean }): Promise<string> {
        return this.#run(session, this.#doing("Typing into", index), async ({ page }) => {
            const { observed, element } = this.#element(index);

            await page.type(observed, element, text, options);

            return this.#read();
        });
    }

    /**
     * Type one of the owner's secrets into field `index`, password fields too (PP-32). Its value comes from the app, not
     * from Pi; what Pi is told is the page read again, and a password field's value is never read. `name` is for the
     * panel ("Typing [secret NAME] into [3]").
     */
    typeSecret(session: number, index: number, name: string, value: string, options: { clear?: boolean; submit?: boolean }): Promise<string> {
        return this.#run(session, `Typing [secret ${name}] into [${index}]`, async ({ page }) => {
            const { observed, element } = this.#element(index);

            await page.fill(observed, element, value, options);

            return this.#read();
        });
    }

    select(session: number, index: number, option: string): Promise<string> {
        return this.#run(session, this.#doing(`Choosing ${JSON.stringify(option)} in`, index), async (tab) => {
            const { observed, element } = this.#element(index);

            if (element.options === undefined && ["combobox", "button", "listbox"].includes(element.role)) {
                return this.#chooseOption(tab, observed, element, option);
            }

            const chosen = await tab.page.select(observed, element, option);

            return `Chose ${JSON.stringify(chosen)}.\n${await this.#read()}`;
        });
    }

    /**
     * A list a page draws itself (a Radix or ARIA select: a button that opens options): open it unless it is open, then
     * click the option, scrolled into view in the list (PP-116).
     */
    async #chooseOption(tab: Tab, observed: Observed, element: Element, option: string): Promise<string> {
        const wanted = option.trim().toLowerCase();
        const find = (elements: Element[]) => {
            const options = elements.filter((each) => each.role === "option");

            return {
                options,
                match: options.find((each) => each.label.trim().toLowerCase() === wanted) ?? options.find((each) => each.label.toLowerCase().includes(wanted)),
            };
        };
        let found = find(tab.elements);

        if (found.match === undefined && element.expanded !== "true") {
            await tab.page.click(observed, element);
            await this.#read();
            found = find(tab.elements);
        }

        if (found.match === undefined) {
            throw new Error(
                found.options.length === 0
                    ? `[${element.index}] ${element.label} showed no options to choose from: read the page, and click the option itself.`
                    : `[${element.index}] ${element.label} has no option ${JSON.stringify(option)}: its options are ${found.options.map((each) => JSON.stringify(each.label)).join(", ")}.`,
            );
        }

        const target = this.#element(found.match.index);

        await tab.page.click(target.observed, target.element);

        return `Chose ${JSON.stringify(found.match.label)}.\n${await this.#read()}`;
    }

    /** Files (name and bytes, from wherever the session works) into a file field or the button that opens one. */
    upload(session: number, index: number, files: { name: string; bytes: Uint8Array }[]): Promise<string> {
        return this.#run(session, this.#doing(`Uploading ${files.map((file) => file.name).join(", ")} with`, index), async ({ page }) => {
            const { observed, element } = this.#element(index);
            const paths: string[] = [];

            for (const file of files) {
                paths.push(await this.#options.engine.stage(file.name, file.bytes));
            }

            await page.upload(observed, element, paths);

            return `Chose ${files.map((file) => file.name).join(", ")}.\n${await this.#read()}`;
        });
    }

    /** Scroll the page, or with `index`, what scrolls around that control (an open list). */
    scroll(session: number, direction: "up" | "down", screens: number, index?: number): Promise<string> {
        return this.#run(session, index === undefined ? `Scrolling ${direction}` : this.#doing(`Scrolling ${direction} at`, index), async ({ page }) => {
            await page.scroll(direction, screens, index === undefined ? undefined : this.#element(index));

            return this.#read();
        });
    }

    press(session: number, key: string, acceptDialog = false): Promise<string> {
        return this.#run(session, `Pressing ${key}`, async ({ page }) => {
            await page.setAcceptDialogs(acceptDialog);

            try {
                await page.press(key);

                return await this.#read();
            } finally {
                await page.setAcceptDialogs(false);
            }
        });
    }

    history(session: number, step: -1 | 1): Promise<string> {
        return this.#run(session, step < 0 ? "Going back" : "Going forward", async ({ page }) => {
            if (!(await page.history(step))) {
                return `There is no page to go ${step < 0 ? "back" : "forward"} to.\n${await this.#read()}`;
            }

            return this.#read();
        });
    }

    text(session: number, max: number): Promise<{ title: string; url: string; text: string; cut: boolean }> {
        return this.#run(session, "Reading the whole page", ({ page }) => page.text(max));
    }

    /**
     * What is in view, as a JPEG (or a PNG, to keep); with `index`, only the dialog, menu or list that control is in, or
     * the control (PP-118). `whole` says which.
     */
    screenshot(session: number, { png = false, index, marks = [] }: { png?: boolean; index?: number; marks?: PageMark[] } = {}): Promise<{ data: string; whole?: string }> {
        return this.#run(session, index === undefined ? "Looking at the page" : this.#doing("Looking at", index), async ({ id, page }) => {
            let clip: PictureClip | undefined;
            let whole: string | undefined;

            if (index !== undefined) {
                const { observed, element } = this.#element(index);

                ({ clip, whole } = await page.area(observed, element));
            }

            // Where each mark goes, read just before the picture (PP-119).
            const placed = marks.length === 0 ? [] : await this.#place(page, marks, clip);
            const data = await this.#options.engine.picture(id, page, placed.length === 0 ? (index === undefined ? 70 : 80) : 92, undefined, { png, ...(clip === undefined ? {} : { clip }) });

            if (placed.length === 0) {
                return { data, ...(whole === undefined ? {} : { whole }) };
            }

            const marked = markUp(Buffer.from(data, "base64"), placed, { png, cssWidth: clip?.width ?? this.#state.viewport.width });

            return { data: Buffer.from(marked.bytes).toString("base64"), ...(whole === undefined ? {} : { whole }) };
        });
    }

    /**
     * Marks by control number, by a text shown, or by an area of the view (CSS pixels), as areas of the picture: of the
     * view, or of `clip`. A control out of view, or a text not shown, is an error: a secret left showing must not pass.
     */
    async #place(page: BrowserPage, marks: PageMark[], clip: PictureClip | undefined): Promise<Mark[]> {
        const targets = marks.map((mark) => {
            const named = [mark.index, mark.text, mark.area].filter((each) => each !== undefined).length;

            if (named !== 1) {
                throw new Error("Each mark names one of index, text, or area.");
            }

            return mark.index !== undefined ? { node: this.#element(mark.index).element.node } : mark.text !== undefined ? { text: mark.text } : undefined;
        });
        const asked = targets.filter((each) => each !== undefined);
        const found = asked.length === 0 ? [] : await page.areasOf(asked);
        const placed: Mark[] = [];
        let next = 0;

        marks.forEach((mark, at) => {
            const { index, text, area, ...style } = mark;
            let areas: MarkArea[];

            if (targets[at] === undefined) {
                areas = [area!];
            } else {
                const where = found[next++];

                if (where === null || where === undefined) {
                    throw new StalePage(`[${index}] is gone or out of view: scroll to it, read the page, and try again.`);
                }

                if (where.length === 0) {
                    throw new Error(`${JSON.stringify(text)} does not show in view: scroll to it first (or give its area).`);
                }

                areas = where;
            }

            areas.forEach((each, n) => {
                const shifted = clip === undefined ? each : { ...each, x: each.x - clip.x, y: each.y - clip.y };

                // A text shown in several places: all hidden or boxed; its number, label and arrow on the first.
                placed.push(n === 0 ? { ...style, area: shifted } : { box: style.box, hide: style.hide, spotlight: style.spotlight, color: style.color, area: shifted });
            });
        });

        return placed;
    }

    /** The page in front as a PDF. */
    pdf(session: number): Promise<{ pdf: Buffer; title: string; url: string }> {
        return this.#run(session, "Saving the page as a PDF", async (tab) => ({ pdf: await this.#options.engine.pdf(tab.id, tab.page), title: tab.title, url: tab.url }));
    }

    wait(session: number, wait: { text?: string; seconds?: number }): Promise<string> {
        return this.#run(session, wait.text ? `Waiting for ${JSON.stringify(wait.text)}` : "Waiting", async ({ page }) => {
            const showed = await page.wait(wait);

            return `${showed ? "" : `${JSON.stringify(wait.text)} did not show within 30 seconds.\n`}${await this.#read()}`;
        });
    }

    // ─── Tabs ─────────────────────────────────────────────────────────────────

    /** The tabs, numbered from 1, and which is in front. */
    #tabList(): string {
        return this.#tabs.map((tab, index) => `${tab === this.#tab ? "→" : " "} ${index + 1}. ${tab.title || "(no title)"} — ${tab.url}`).join("\n");
    }

    tabs(session: number): Promise<string> {
        return this.#run(session, "Listing the tabs", async () => `Tabs (→ in front):\n${this.#tabList()}`);
    }

    /** Open a new tab in front (at an address, or blank). */
    newTab(session: number, url: string | undefined): Promise<string> {
        return this.#run(session, url === undefined ? "Opening a new tab" : `Opening ${url} in a new tab`, async () => {
            if (this.#tabs.length >= MAX_TABS) {
                throw new Error(`Pi's browser has ${MAX_TABS} tabs open, the most it keeps: close one first (browser_tabs with close).`);
            }

            const tab = await this.#attach(await this.#options.engine.newTab(SIZES[this.#state.size]));

            this.#front(tab);
            this.#set({});

            if (url !== undefined) {
                await tab.page.navigate(url);
            }

            return this.#read();
        });
    }

    /** Bring tab `number` (from 1) to the front. */
    switchTab(session: number, number: number): Promise<string> {
        return this.#run(session, `Switching to tab ${number}`, async () => {
            const tab = this.#tabs[number - 1];

            if (tab === undefined) {
                throw new Error(`There is no tab ${number}: Pi's browser has ${this.#tabs.length}.\n${this.#tabList()}`);
            }

            this.#front(tab);
            this.#set({});

            return this.#read();
        });
    }

    /** Close tab `number` (from 1); the one before it comes to the front. The last tab closes the browser. */
    closeTab(session: number, number: number): Promise<string> {
        return this.#run(session, `Closing tab ${number}`, async () => {
            const tab = this.#tabs[number - 1];

            if (tab === undefined) {
                throw new Error(`There is no tab ${number}: Pi's browser has ${this.#tabs.length}.\n${this.#tabList()}`);
            }

            if (this.#tabs.length === 1) {
                await this.#closeAll();

                return "That was the last tab: Pi's browser is closed.";
            }

            const at = this.#tabs.indexOf(tab);

            this.#tabs = this.#tabs.filter((each) => each !== tab);

            if (this.#tab === tab) {
                this.#front(this.#tabs[Math.max(0, at - 1)]);
            }

            tab.page.cdp.close();
            await this.#options.engine.closeTab(tab.id);
            this.#set({});

            return `Closed tab ${number}.\n${await this.#read()}`;
        });
    }

    /**
     * Carry out a goal, a decision a step by the run model (`run.ts`), as one of Pi's actions: what it did, and the page
     * as it is after.
     */
    run(session: number, options: { goal: string; values: Record<string, string>; secrets?: readonly string[]; maxSteps: number; decider: Decider }): Promise<{ result: RunResult; page: string }> {
        return this.#run(session, `Running: ${options.goal.slice(0, 80)}`, async (tab) => {
            const page = tab.page;
            const element = (observed: Observed, node: number): Element => {
                const found = elementsOf(observed).find((each) => each.node === node);

                if (found === undefined) {
                    throw new StalePage("The control is gone from the page.");
                }

                return found;
            };
            const result = await runGoal(
                {
                    observe: () => page.observe(),
                    click: (observed, node) => page.click(observed, element(observed, node)),
                    // A secret may go into a password field (`fill`); anything else goes through `type`, which refuses them.
                    type: (observed, node, text, secret) => (secret ? page.fill(observed, element(observed, node), text, { clear: true }) : page.type(observed, element(observed, node), text, { clear: true })),
                    select: async (observed, node, option) => {
                        await page.select(observed, element(observed, node), option);
                    },
                    scroll: (direction) => page.scroll(direction, 0.85),
                    wait: async () => {
                        await page.wait({ seconds: 1 });
                    },
                    stale: (error) => error instanceof StalePage,
                },
                options.decider,
                {
                    goal: options.goal,
                    values: options.values,
                    ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
                    maxSteps: options.maxSteps,
                    timeMs: 180_000,
                    progress: (what) => this.#set({ doing: what }),
                },
            );

            tab.observed = result.observed;
            tab.elements = elementsOf(result.observed);
            tab.url = result.observed.url;
            tab.title = result.observed.title;
            this.#set({});

            return { result, page: describe(result.observed, tab.elements) };
        });
    }

    /** A control on the page as last read, by its number: what it is, and whether it takes typing. */
    field(index: number): { label: string; role: string; fill: boolean } {
        const { element } = this.#element(index);

        return { label: element.label, role: element.role, fill: element.fill };
    }

    /**
     * What the person typed on a sign-in or code card, into the page's fields by number (as last read): password fields
     * too. It never goes to Pi; the page is read again afterwards, and a password field's value is never read. With
     * `hide` (a password, a code), the page keeps it out of everything Pi reads of it from now on (PP-93).
     */
    fillFields(session: number, fields: { index: number; value: string; hide: boolean }[]): Promise<void> {
        return this.#run(session, "Filling in what you typed", async (tab) => {
            const page = tab.page;
            // By node, from the read the card was made from: filling one field may renumber the others.
            const nodes = fields.map((field) => ({ node: this.#element(field.index).element.node, index: field.index, value: field.value, hide: field.hide }));

            for (const field of nodes) {
                const observed = await page.observe();
                const element = elementsOf(observed).find((each) => each.node === field.node);

                if (element === undefined) {
                    throw new StalePage(`Field [${field.index}] is gone from the page: read it again and ask once more.`);
                }

                await page.fill(observed, element, field.value, { clear: true, hide: field.hide });
            }

            tab.observed = await page.observe();
            tab.elements = elementsOf(tab.observed);
        });
    }

    async #closeAll(): Promise<void> {
        this.#stopFrames?.();

        for (const tab of this.#tabs) {
            tab.page.cdp.close();
        }

        this.#tabs = [];
        this.#tab = undefined;
        await this.#options.engine.close();
        this.#set({ doing: null, takenOver: false });
    }

    /** Close Pi's browser, every tab (Settings, or the panel's Close). */
    async close(): Promise<void> {
        await this.#queue;
        await this.#closeAll();
    }

    // ─── Watching and taking over ─────────────────────────────────────────────

    /** A tab started showing the panel: frames flow while anyone watches. Returns how to stop. */
    watch(): () => void {
        this.#watchers += 1;

        if (this.#tab !== undefined && !this.#tab.page.cdp.closed) {
            void this.#startFrames().catch((error: unknown) => this.#options.log(`browser frames: ${String(error)}`));
        }

        let stopped = false;

        return () => {
            if (stopped) {
                return;
            }

            stopped = true;
            this.#watchers -= 1;
            this.#usedAt = Date.now();

            if (this.#watchers === 0) {
                this.#stopFrames?.();
            }
        };
    }

    async #startFrames(): Promise<void> {
        const tab = this.#tab;
        const page = tab?.page;

        if (tab === undefined || page === undefined || this.#casting === page) {
            return;
        }

        this.#stopFrames?.();
        this.#casting = page;

        // A still page sends no new frames: one first, so the panel has a picture at once. Before the screencast: the
        // phone's WebView does not answer a capture while it casts (the panel opened again showed nothing, 30 s later
        // an error). A capture that does not come in 5 s is left out; the cast's frames follow.
        try {
            this.#options.frame({ jpeg: await this.#options.engine.picture(tab.id, page, 60, 5000), width: this.#state.viewport.width, height: this.#state.viewport.height });
        } catch (error) {
            this.#options.log(`browser frames: the first picture: ${String(error)}`);
        }

        if (this.#casting !== page) {
            return;
        }

        const off = page.cdp.on("Page.screencastFrame", (params) => {
            const metadata = params.metadata as { deviceWidth?: number; deviceHeight?: number } | undefined;

            this.#options.frame({ jpeg: String(params.data), width: metadata?.deviceWidth ?? this.#state.viewport.width, height: metadata?.deviceHeight ?? this.#state.viewport.height });
            void page.cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
        });

        this.#stopFrames = () => {
            off();
            this.#casting = undefined;
            this.#stopFrames = undefined;
            void page.cdp.send("Page.stopScreencast").catch(() => {});
        };
        await page.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: Math.min(this.#state.viewport.width * 2, 1600), maxHeight: Math.min(this.#state.viewport.height * 2, 1720), everyNthFrame: 1 });
    }

    /**
     * Lay this session's pages out as a phone's or a desktop's (PP-15): its open tabs now, and every tab it opens after.
     * Pi's tool and the panel's Phone/Desktop both come here. Answers the page as it is, for Pi.
     */
    async resize(session: number, size: BrowserSize): Promise<string> {
        const resized = this.#queue.then(async () => {
            this.#usedAt = Date.now();
            this.#set({ size, viewport: { width: SIZES[size].width, height: SIZES[size].height } });
            this.#options.sized?.(size);

            for (const tab of [...this.#tabs]) {
                if (this.#options.engine.reopensToResize) {
                    await this.#reopen(tab, size);
                } else {
                    tab.observed = undefined;
                    await tab.page.resize(SIZES[size], { phone: this.#options.engine.actAsPhone });
                }
            }

            // Frames for those watching come again at the new size.
            if (this.#casting !== undefined) {
                this.#stopFrames?.();
                await this.#startFrames().catch((error: unknown) => this.#options.log(`browser frames: ${String(error)}`));
            }

        });

        this.#queue = resized.catch(() => {});
        await resized;

        return this.#tabs.length === 0 ? `Pi's browser will lay pages out as a ${size}.` : `Now laid out as a ${size} (${SIZES[size].width}×${SIZES[size].height}).\n${await this.snapshot(session)}`;
    }

    /** A person takes Pi's browser over (their taps and typing go to the page), or hands it back. */
    takeOver(on: boolean): void {
        this.#usedAt = Date.now();
        this.#set({ takenOver: on });
    }

    /**
     * How long it has had tabs open with nothing using them, in ms at `now`: 0 while it has none, while Pi acts there,
     * while someone watches the panel, or while a person has taken it over. Over a limit, the app closes its tabs.
     */
    idleFor(now: number): number {
        if (this.#tabs.length === 0 || this.#state.doing !== null || this.#watchers > 0 || this.#state.takenOver) {
            return 0;
        }

        return Math.max(0, now - this.#usedAt);
    }

    /**
     * Open `tab` again at `size` in its place, at its address, and close it (the phone's WebView, whose view keeps its
     * size): the page loads again, as a size change loads it anyway; sign-ins stay in the profile.
     */
    async #reopen(tab: Tab, size: BrowserSize): Promise<void> {
        const engine = this.#options.engine;
        const fresh = await this.#attach(await engine.newTab(SIZES[size]));
        const index = this.#tabs.indexOf(tab);

        // #attach put it last: it takes the old tab's place, and the front if it had it.
        this.#tabs = this.#tabs.filter((each) => each !== fresh && each !== tab);
        this.#tabs.splice(index, 0, fresh);

        if (this.#tab === tab) {
            this.#front(fresh);
        }

        if (/^https?:/.test(tab.url)) {
            await fresh.page.navigate(tab.url);
        }

        fresh.url = await fresh.page.evaluate<string>("location.href").catch(() => tab.url);
        fresh.title = await fresh.page.evaluate<string>("document.title").catch(() => tab.title);

        tab.page.cdp.close();
        await engine.closeTab(tab.id);
        this.#set({});
    }

    /** Whether it has tabs open. */
    get hasTabs(): boolean {
        return this.#tabs.length > 0;
    }

    /** The person's input while they have it: a tap or a scroll at CSS pixels of the page, text, or a key. */
    /**
     * A person's input while they have the page: a tap, a scroll, text as they type it, or a key. Answers where the focus
     * is then (PP-14): whether it takes text, and whether it is a password, so the panel raises the keyboard in that mode.
     * Nothing typed is kept or logged.
     */
    async input(
        event: { type: "tap"; x: number; y: number } | { type: "scroll"; x: number; y: number; dx?: number; dy: number } | { type: "text"; text: string } | { type: "key"; key: string },
    ): Promise<{ editable: boolean; password: boolean }> {
        if (!this.#state.takenOver) {
            throw new Error("Take over Pi's browser first.");
        }

        this.#usedAt = Date.now();

        const page = (await this.#ensure()).page;

        if (event.type === "tap") {
            for (const type of ["mousePressed", "mouseReleased"]) {
                await page.cdp.send("Input.dispatchMouseEvent", { type, x: event.x, y: event.y, button: "left", clickCount: 1 });
            }
        } else if (event.type === "scroll") {
            // A wheel at the point: the page scrolls what is under it (an open panel's own list first), as a browser does.
            await page.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: event.x, y: event.y, deltaX: event.dx ?? 0, deltaY: event.dy });
        } else if (event.type === "text") {
            await page.cdp.send("Input.insertText", { text: event.text });
        } else {
            await page.press(event.key);
        }

        return await page.evaluate<{ editable: boolean; password: boolean }>(FOCUS_SCRIPT).catch(() => ({ editable: false, password: false }));
    }

    /** Open an address for the person (the panel's address bar, while they have it). */
    async navigateFor(url: string): Promise<void> {
        if (!this.#state.takenOver) {
            throw new Error("Take over Pi's browser first.");
        }

        await (await this.#ensure()).page.navigate(url);
    }

    /** Bring tab `number` (from 1) to the front for the person (the panel's tab strip). */
    async showTab(number: number): Promise<void> {
        this.#usedAt = Date.now();
        await this.#ensure();

        const tab = this.#tabs[number - 1];

        if (tab === undefined) {
            throw new Error(`There is no tab ${number}.`);
        }

        this.#front(tab);
        this.#set({});
    }
}
