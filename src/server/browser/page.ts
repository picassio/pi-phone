/**
 * What Pi does on a page (`browser/pi-browser.ts`), over one DevTools connection: read it as numbered elements and visible
 * text (`snapshot.js`), and act on an element it read: click, type, select. Every target is an observed DOM node, never a
 * selector or a script the model wrote; just before input the element is checked to be the one observed, still in view,
 * and not covered, or the action is refused as stale and the page read again. Input is real (DevTools input events).
 * The loop's shape and the act-time checks follow jev-ultrafast (MIT, Browser Use).
 */
import { readFileSync } from "node:fs";
import type { Cdp } from "./cdp.ts";

const SNAPSHOT = readFileSync(new URL("./snapshot.js", import.meta.url), "utf8");

/** Addresses Pi's browser never loads (Fetch patterns): the app itself, this device, and the local network (a page could act as you). */
export const BLOCKED_URLS = [
    "*://127.*",
    "*://localhost*",
    "*://[::1]*",
    "*://0.0.0.0*",
    "*://10.*",
    "*://192.168.*",
    "*://169.254.*",
    ...Array.from({ length: 16 }, (_each, index) => `*://172.${16 + index}.*`),
    // Tailscale's addresses (100.64.0.0/10), where the owner's machines and this app's other address are.
    ...Array.from({ length: 64 }, (_each, index) => `*://100.${64 + index}.*`),
];

/** This device or its local network, by the address written (as PiBrowser.java's check): never opened. */
export function isLocalAddress(url: string): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]" || host === "0.0.0.0") {
        return true;
    }

    const octets = host.split(".").map(Number);

    if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet))) {
        return false;
    }

    const [a, b] = octets as [number, number, number, number];

    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

type RawAction = {
    node: number;
    role: string;
    label: string;
    rect: { x: number; y: number; w: number; h: number };
    kind: "click" | "fill" | "select";
    value?: string;
    option?: string;
    current_value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
};

/** The page as read: its controls (raw, per action) and the guards that tell whether it changed since. */
export type Observed = {
    url: string;
    title: string;
    w: number;
    h: number;
    text: string;
    scroll: { y: number; height: number };
    actions: RawAction[];
    marker: unknown;
    page_key: unknown;
    guards: Record<string, unknown>;
    omitted: number;
};

/** A control on the page, numbered for Pi: what it is, what it holds, and what can be done with it. */
export type Element = {
    index: number;
    node: number;
    role: string;
    label: string;
    value?: string;
    checked?: string;
    selected?: string;
    expanded?: string;
    click: boolean;
    fill: boolean;
    /** A drop-down list's other choices (the chosen one is `value`). */
    options?: { label: string; value: string }[];
};

/** The page changed (or the element moved, or something covers it) since it was read: read it again. */
/**
 * In every document Pi's browser loads (PP-79): alert, confirm and prompt answer at once, as Pi asked for the click or
 * key press under way (`__piDialogs.accept`), and keep what they showed (the last five) for the next read.
 */
const DIALOGS = `(() => {
    if (window.__piDialogs) return;
    const state = { accept: false, shown: [] };
    Object.defineProperty(window, "__piDialogs", { value: state });
    const show = (type, message, accepted) => {
        state.shown.push({ text: type + ": " + String(message ?? "").slice(0, 300), accepted });
        if (state.shown.length > 5) state.shown.shift();
    };
    window.alert = function (message) { show("alert", message, true); };
    window.confirm = function (message) { show("confirm", message, state.accept); return state.accept; };
    window.prompt = function (message, value) { show("prompt", message, state.accept); return state.accept ? String(value ?? "") : null; };
})()`;

export class StalePage extends Error {}

/** One element per observed node, in page order, numbered from 1. */
export function elementsOf(observed: Observed): Element[] {
    const byNode = new Map<number, Element>();

    for (const action of observed.actions) {
        let element = byNode.get(action.node);

        if (element === undefined) {
            element = {
                index: byNode.size + 1,
                node: action.node,
                role: action.role,
                label: action.label,
                click: false,
                fill: false,
                ...(action.checked === undefined ? {} : { checked: action.checked }),
                ...(action.selected === undefined ? {} : { selected: action.selected }),
                ...(action.expanded === undefined ? {} : { expanded: action.expanded }),
            };
            byNode.set(action.node, element);
        }

        if (action.kind === "select") {
            element.options = [...(element.options ?? []), { label: action.option ?? action.value ?? "", value: action.value ?? "" }];
            element.value = action.current_value ?? "";
        } else {
            element[action.kind] = true;

            if (action.value !== undefined && action.value !== "") {
                element.value = action.value;
            }
        }
    }

    return [...byNode.values()];
}

const quote = (text: string) => JSON.stringify(text);

/** The page in words for Pi: where it is, its numbered controls, and its visible text. */
export function describe(observed: Observed, elements: Element[]): string {
    const below = observed.scroll.height - (observed.scroll.y + observed.h);
    const lines = [
        `${observed.title || "(no title)"} — ${observed.url}`,
        observed.scroll.height > observed.h + 2
            ? `Scrolled ${Math.round(observed.scroll.y)} of ${Math.round(observed.scroll.height)} px${below > 2 ? ", more below" : ""}${observed.scroll.y > 0 ? ", more above" : ""}.`
            : "",
        "",
        elements.length === 0 ? "No controls in view." : "Controls in view:",
        ...elements.map((element) => {
            const parts = [`[${element.index}] ${element.role} ${quote(element.label)}`];

            if (element.options !== undefined) {
                parts.push(`chosen ${quote(element.value ?? "")}, other options: ${element.options.slice(0, 12).map((option) => quote(option.label)).join(", ")}${element.options.length > 12 ? `, … (${element.options.length - 12} more)` : ""}`);
            } else if (element.fill && element.role !== "password") {
                parts.push(`value ${quote(element.value ?? "")}`);
            }

            for (const state of ["checked", "selected", "expanded"] as const) {
                if (element[state] !== undefined) {
                    parts.push(`${state}=${element[state]}`);
                }
            }

            return parts.join(" ");
        }),
        observed.omitted > 0 ? `(${observed.omitted} more controls not listed: scroll, or open the section first)` : "",
        "",
        "Visible text:",
        observed.text || "(none)",
    ];

    return lines.filter((line, index, all) => line !== "" || (all[index - 1] ?? "") !== "").join("\n").trim();
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
    Enter: { code: "Enter", keyCode: 13, text: "\r" },
    Escape: { code: "Escape", keyCode: 27 },
    Tab: { code: "Tab", keyCode: 9 },
    Backspace: { code: "Backspace", keyCode: 8 },
    ArrowUp: { code: "ArrowUp", keyCode: 38 },
    ArrowDown: { code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { code: "ArrowRight", keyCode: 39 },
    PageDown: { code: "PageDown", keyCode: 34 },
    PageUp: { code: "PageUp", keyCode: 33 },
};

export const PRESSABLE = Object.keys(KEYS);

/**
 * A key to press: a named one, or one printable character (a list's type-ahead: "G" goes to Global Payments). Keys
 * without text go down raw, as a keyboard's do, so a page's own key handlers see them (PP-116).
 */
export function keyOf(key: string): { key: string; code: string; keyCode: number; text?: string } | undefined {
    const known = KEYS[key];

    if (known !== undefined) {
        return { key, ...known };
    }

    if ([...key].length !== 1 || /[\p{C}]/u.test(key)) {
        return undefined;
    }

    const upper = key.toUpperCase();

    if (/^[A-Z]$/.test(upper)) {
        return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
    }

    if (/^[0-9]$/.test(key)) {
        return { key, code: `Digit${key}`, keyCode: key.charCodeAt(0), text: key };
    }

    return key === " " ? { key, code: "Space", keyCode: 32, text: key } : { key, code: "", keyCode: 0, text: key };
}

/** An address as typed: words become a search, a bare name gets https. Only http and https pages. */
export function addressOf(input: string): string {
    const typed = input.trim();

    if (typed === "") {
        throw new Error("Give an address, or words to search for.");
    }

    if (/^https?:\/\//i.test(typed)) {
        return new URL(typed).href;
    }

    // A dev server as typed (localhost:3000, 10.0.0.5:8080/app): plain http, as they serve.
    if (/^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])(:\d+)?(\/\S*)?$/i.test(typed)) {
        return new URL(`http://${typed}`).href;
    }

    if (/^[a-z][a-z0-9+.-]*:/i.test(typed) && !/^[^\s/]+\.[^\s/]+:\d/.test(typed)) {
        throw new Error("Pi's browser opens http and https pages only.");
    }

    if (/\s/.test(typed) || !typed.includes(".")) {
        return `https://duckduckgo.com/?q=${encodeURIComponent(typed)}`;
    }

    return new URL(`https://${typed}`).href;
}

export class BrowserPage {
    readonly cdp: Cdp;
    /** The element Pi typed into or clicked last, waited on before the next read (menus, suggestions). */
    #afterInput: RawAction | undefined;
    /** The last dialog the page opened (alert, confirm, prompt), dismissed: told to Pi with the next read. */
    dialog: string | undefined;
    /** The main frame's id, and whether it is loading a document now; how many loads it started. */
    #mainFrame = "";
    #loading = false;
    #loads = 0;

    constructor(cdp: Cdp) {
        this.cdp = cdp;
    }

    /**
     * What a person typed into this page through a card (a password, a one-time code; not a username), kept in memory
     * only: everything Pi reads of the page has them as `[typed by the person]` (PP-93). A code in a plain text field
     * would otherwise show in the next read.
     */
    readonly #typed = new Set<string>();

    /** `text` with what the person typed through a card taken out, longest first. */
    hideTyped(text: string): string {
        let result = text;

        for (const value of [...this.#typed].sort((a, b) => b.length - a.length)) {
            result = result.split(value).join("[typed by the person]");
        }

        return result;
    }

    /** A read with the person's typing hidden in what Pi is told; its guards stay, so a stale read is still seen. */
    #hidden(observed: Observed): Observed {
        if (this.#typed.size === 0) {
            return observed;
        }

        const hide = (text: string | undefined) => (text === undefined ? undefined : this.hideTyped(text));

        return {
            ...observed,
            url: this.hideTyped(observed.url),
            title: this.hideTyped(observed.title),
            text: this.hideTyped(observed.text),
            actions: observed.actions.map((action) => ({
                ...action,
                label: this.hideTyped(action.label),
                ...(action.value === undefined ? {} : { value: hide(action.value) }),
                ...(action.current_value === undefined ? {} : { current_value: hide(action.current_value) }),
            })),
        };
    }

    /** Whether pictures come from the GPU surface (a desktop Chrome: at the device scale) or the view (the phone's WebView). */
    #fromSurface = false;

    /** Whether local addresses are refused: on the phone, where the app's own server is; not on a machine's own Chrome. */
    #blockLocal = true;

    /**
     * Turn on what reading and acting need, block the local addresses (unless `local`: a machine's Chrome may open that
     * machine's dev servers), and dismiss dialogs (accepted only when asked).
     */
    async init(viewport: { width: number; height: number; mobile: boolean }, { local = false, phone = false }: { local?: boolean; phone?: boolean } = {}): Promise<void> {
        await this.cdp.send("Page.enable");
        this.#blockLocal = !local;

        if (phone) {
            await this.#actAsPhone();
        }

        this.#fromSurface = phone;

        if (!local) {
            // Requests to the local addresses pause (only those) and fail: navigations, frames, scripts, fetches alike.
            // (Network.setBlockedURLs no longer blocks in Chrome 155.)
            this.cdp.on("Fetch.requestPaused", (params) => {
                void this.cdp.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
            });
            await this.cdp.send("Fetch.enable", { patterns: BLOCKED_URLS.map((urlPattern) => ({ urlPattern })) });
        }

        this.#ownAgent = await this.evaluate<string>("navigator.userAgent").catch(() => "");
        await this.#metrics(viewport, phone);

        if (!viewport.mobile) {
            await this.#actAsDesktop();
        }

        await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
        this.#mainFrame = ((await this.cdp.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree")).frameTree.frame.id);
        this.cdp.on("Page.frameStartedLoading", (params) => {
            if (params.frameId === this.#mainFrame) {
                this.#loading = true;
                this.#loads += 1;
            }
        });
        this.cdp.on("Page.frameStoppedLoading", (params) => {
            if (params.frameId === this.#mainFrame) {
                this.#loading = false;
            }
        });
        // Dialogs are answered in the page (PP-79): the phone's WebView has no dialog UI, and answers confirm() with false
        // before DevTools hears of it. Every document gets alert, confirm and prompt that answer as Pi asked and say what
        // they showed; DevTools' dialogs (beforeunload, a page that kept the originals) are still answered below.
        await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: DIALOGS }).catch(() => {});
        await this.evaluate<unknown>(DIALOGS).catch(() => {});
        this.cdp.on("Page.javascriptDialogOpening", (params) => {
            this.dialog = `${String(params.type)}: ${String(params.message ?? "").slice(0, 300)}`;
            void this.cdp.send("Page.handleJavaScriptDialog", { accept: this.acceptDialogs }).catch(() => {});
        });
    }

    /**
     * A desktop Chrome (a machine's, CI's) presents itself as Chrome on an Android phone, as the phone's own WebView is:
     * sites then serve their phone pages to the 412-pixel viewport, not a desktop page shrunk to fit (Wikipedia's is
     * 1120 wide). Its own version, with the user agent, client hints, and touch a phone has.
     */
    async #actAsPhone(): Promise<void> {
        const version = /\/([\d.]+)/.exec((await this.cdp.send<{ product: string }>("Browser.getVersion")).product)?.[1] ?? "155.0.0.0";
        const major = version.split(".")[0]!;
        const brands = [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not.A/Brand", version: "99" },
        ];

        await this.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
            platform: "Linux armv8l",
            userAgentMetadata: {
                brands,
                fullVersionList: brands.map((brand) => ({ ...brand, version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : version })),
                fullVersion: version,
                platform: "Android",
                platformVersion: "14.0.0",
                architecture: "",
                model: "Pixel 8",
                mobile: true,
            },
        });
        await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }

    /** The browser's own user agent, before any override: the phone's WebView's, to go back to it from Desktop. */
    #ownAgent = "";
    /** Lay the page out at `viewport` (a desktop Chrome at twice its CSS pixels, as a phone has them). */
    async #metrics(viewport: { width: number; height: number; mobile: boolean }, phone: boolean): Promise<void> {
        await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: viewport.width, height: viewport.height, deviceScaleFactor: phone ? 2 : 0, mobile: viewport.mobile });
    }

    /**
     * Lay the page out at another size (PP-15): a phone's (`mobile`, touch, a phone's user agent) or a desktop's (no touch,
     * a desktop Chrome's user agent). An open page loads again, so its site serves the page for that size.
     */
    async resize(viewport: { width: number; height: number; mobile: boolean }, { phone = false }: { phone?: boolean } = {}): Promise<void> {
        await this.#metrics(viewport, phone);

        if (!viewport.mobile) {
            await this.#actAsDesktop();
        } else if (phone) {
            await this.#actAsPhone();
        } else {
            await this.cdp.send("Emulation.setUserAgentOverride", { userAgent: this.#ownAgent });
            await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
        }

        const url = await this.evaluate<string>("location.href").catch(() => "");

        if (/^https?:/.test(url)) {
            await this.cdp.send("Page.reload", {});
            await this.settle(1500);
        }
    }

    /** Present as Chrome on a Windows desktop, without touch: sites serve their desktop pages. */
    async #actAsDesktop(): Promise<void> {
        const version = /\/([\d.]+)/.exec((await this.cdp.send<{ product: string }>("Browser.getVersion").catch(() => ({ product: "Chrome/155.0.0.0" }))).product)?.[1] ?? "155.0.0.0";
        const major = version.split(".")[0]!;
        const brands = [
            { brand: "Chromium", version: major },
            { brand: "Google Chrome", version: major },
            { brand: "Not.A/Brand", version: "99" },
        ];

        await this.cdp.send("Emulation.setUserAgentOverride", {
            userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
            platform: "Win32",
            userAgentMetadata: {
                brands,
                fullVersionList: brands.map((brand) => ({ ...brand, version: brand.brand === "Not.A/Brand" ? "99.0.0.0" : version })),
                fullVersion: version,
                platform: "Windows",
                platformVersion: "15.0.0",
                architecture: "x86",
                model: "",
                mobile: false,
            },
        });
        await this.cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }

    /** Whether the next dialog is accepted (a click or key press Pi asked to accept them for); declined otherwise. */
    acceptDialogs = false;

    /** Accept dialogs (or not) from now: here, for DevTools' dialogs, and in the page, for its own. */
    async setAcceptDialogs(accept: boolean): Promise<void> {
        this.acceptDialogs = accept;
        await this.evaluate<unknown>(`window.__piDialogs && (window.__piDialogs.accept = ${accept})`).catch(() => {});
    }

    /** The dialogs the page showed since the last time, each with how it was answered; then none. */
    async takeDialogs(): Promise<{ text: string; accepted: boolean }[]> {
        const shown = await this.evaluate<{ text: string; accepted: boolean }[] | null>("(() => { const d = window.__piDialogs; if (!d) return null; const s = d.shown.slice(); d.shown.length = 0; return s; })()").catch(() => null);

        return shown ?? [];
    }

    async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
        const answer = await this.cdp.send<{ result?: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }>("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
        });

        if (answer.exceptionDetails !== undefined) {
            throw new StalePage(`The page changed while it was read (${answer.exceptionDetails.exception?.description?.split("\n")[0] ?? answer.exceptionDetails.text ?? "an error"}).`);
        }

        return answer.result?.value as T;
    }

    /** Open an address, and wait for it to load (15 seconds at most; a slow page is read as it is). */
    async navigate(url: string): Promise<void> {
        if (this.#blockLocal && isLocalAddress(url)) {
            throw new Error(`Pi's browser does not open ${url}: it is this device or its local network.`);
        }

        const answer = await this.cdp.send<{ errorText?: string }>("Page.navigate", { url });

        if (answer.errorText !== undefined && answer.errorText !== "") {
            throw new Error(answer.errorText === "net::ERR_BLOCKED_BY_CLIENT" ? `Pi's browser does not open ${url}: it is this device or its local network.` : `Could not open ${url}: ${answer.errorText}`);
        }

        await this.settle(15_000);
    }

    /** Wait until the document is loaded, up to `ms`. */
    async settle(ms: number): Promise<void> {
        const until = Date.now() + ms;

        while (Date.now() < until) {
            const state = await this.evaluate<string>("document.readyState").catch(() => "loading");

            if (state === "complete") {
                return;
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    /** Read the page: retried while it navigates (a read that finds no document, or one that changes under it). */
    async observe(): Promise<Observed> {
        const after = this.#afterInput;

        this.#afterInput = undefined;

        if (after !== undefined) {
            // Menus and suggestions a click or typing opens: two frames, or up to 200 ms for a combobox's options.
            await this.evaluate(
                `(action => new Promise(resolve => {
                    const field=window.__piBrowser?.nodes.get(action.node);
                    const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
                    let frames=0, stopped=false;
                    const finish=()=>{stopped=true;resolve()};
                    setTimeout(finish,autocomplete ? 200 : 50);
                    const ready=()=>{
                      if (stopped) return;
                      const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'').split(/\\s+/).filter(Boolean);
                      const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
                      const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
                      if (++frames>=2 && (!autocomplete || options.some(e=>{const r=e.getBoundingClientRect();
                        return r.width && r.height && r.bottom>0 && r.top<innerHeight && e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});}))) finish();
                      else requestAnimationFrame(ready);
                    };
                    requestAnimationFrame(ready);
                  }))(${JSON.stringify({ node: after.node, kind: after.kind })})`,
                true,
            ).catch(() => {});
        }

        for (let attempt = 0; attempt < 30; attempt++) {
            try {
                const observed = await this.evaluate<Observed | null>(SNAPSHOT);

                if (observed !== null && observed !== undefined) {
                    return this.#hidden(observed);
                }
            } catch (error) {
                if (!(error instanceof StalePage)) {
                    throw error;
                }
            }

            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        throw new StalePage("The page did not settle: it is still loading or changing.");
    }

    /** Whether the element (or, for none, the page) is as it was read. */
    async #fresh(observed: Observed, node: number | undefined): Promise<boolean> {
        if (node === undefined) {
            return true;
        }

        const now = await this.evaluate<unknown>(`(() => { const c=window.__piBrowser; return c ? [c.pageKey(), c.guard(c.nodes.get(${node}))] : null; })()`);

        return JSON.stringify(now) === JSON.stringify([observed.page_key, observed.guards[String(node)] ?? null]);
    }

    /**
     * The element's centre now, if it is still there, in view, enabled, and not covered. One out of view (below the fold
     * of a list with its own scroll area, PP-116) is scrolled into view first, as a person would, and as Playwright does.
     */
    async #point(element: Element, fill: boolean): Promise<{ x: number; y: number }> {
        const point = await this.evaluate<{ x: number; y: number } | null>(
            `(async node => {
            const e=window.__piBrowser?.nodes.get(node);
            if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
                !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
            ${fill ? `if (e.readOnly || e.getAttribute('aria-readonly')==='true') return null;` : ""}
            const at=()=>{
              const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
              if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
              return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null;
            };
            const now=at();
            if (now) return now;
            e.scrollIntoView({block:'nearest',inline:'nearest',behavior:'instant'});
            await new Promise(done=>{ requestAnimationFrame(()=>requestAnimationFrame(done)); setTimeout(done,150); });
            return at();
          })(${element.node})`,
            true,
        );

        if (point === null || point === undefined) {
            throw new StalePage(`[${element.index}] ${element.label} changed, moved out of view, or is covered: read the page again.`);
        }

        return point;
    }

    async #click(point: { x: number; y: number }): Promise<void> {
        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });

        for (const type of ["mousePressed", "mouseReleased"]) {
            await this.cdp.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
        }
    }

    /**
     * After input that may navigate (a link, a submit, Enter): if the main frame starts loading within a moment, wait
     * for it to finish (15 seconds at most), so the next read is of the new page, not the old one.
     */
    async #followNavigation(before: number): Promise<void> {
        const until = Date.now() + 300;

        while (Date.now() < until && this.#loads === before) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }

        if (this.#loads === before) {
            return;
        }

        const done = Date.now() + 15_000;

        while (Date.now() < done && this.#loading) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await this.settle(Math.max(0, done - Date.now()));
    }

    async click(observed: Observed, element: Element): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        const before = this.#loads;

        await this.#click(await this.#point(element, false));
        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
        await this.#followNavigation(before);
    }

    /** Move the pointer over the element (menus and tooltips that open on hover), without clicking. */
    async hover(observed: Observed, element: Element): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        const point = await this.#point(element, false);

        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
    }

    /**
     * Give files (paths the browser can read) to a file field, or to the button that opens one (a styled "Upload" that
     * hides its field): the button is clicked with the file chooser caught, and the files go to the field it opened.
     */
    async upload(observed: Observed, element: Element, paths: string[]): Promise<void> {
        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        if (element.role === "file") {
            await this.#point(element, false);

            const field = await this.cdp.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: `window.__piBrowser?.nodes.get(${element.node})` });
            const multiple = await this.evaluate<boolean>(`!!window.__piBrowser?.nodes.get(${element.node})?.multiple`);

            if (field.result.objectId === undefined) {
                throw new StalePage(`[${element.index}] ${element.label} is gone: read the page again.`);
            }

            if (paths.length > 1 && !multiple) {
                throw new Error(`[${element.index}] ${element.label} takes one file.`);
            }

            await this.cdp.send("DOM.setFileInputFiles", { files: paths, objectId: field.result.objectId });
        } else {
            const point = await this.#point(element, false);
            let off = () => {};
            const opened = new Promise<{ backendNodeId: number; mode: string } | undefined>((resolve) => {
                const timer = setTimeout(() => resolve(undefined), 3000);

                off = this.cdp.on("Page.fileChooserOpened", (params) => {
                    clearTimeout(timer);
                    resolve(params as { backendNodeId: number; mode: string });
                });
            });
            let chooser: { backendNodeId: number; mode: string } | undefined;

            await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });

            try {
                await this.#click(point);
                chooser = await opened;
            } finally {
                off();
                await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
            }

            if (chooser === undefined) {
                throw new Error(`Clicking [${element.index}] ${element.label} did not ask for a file: name the page's upload button or its file field.`);
            }

            if (paths.length > 1 && chooser.mode !== "selectMultiple") {
                throw new Error(`[${element.index}] ${element.label} takes one file.`);
            }

            await this.cdp.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId });
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;
    }

    async type(observed: Observed, element: Element, text: string, { clear = true, submit = false }: { clear?: boolean; submit?: boolean } = {}): Promise<void> {
        if (element.role === "password") {
            throw new Error(`[${element.index}] ${element.label} is a password field: type a saved secret into it (browser_type with secret: NAME), or ask the person with browser_sign_in.`);
        }

        await this.fill(observed, element, text, { clear, submit });
    }

    /**
     * Type into a field, password fields too: Pi's own typing goes through `type`, which refuses passwords; this is for
     * what the person typed on a sign-in or code card, which goes into the page without passing through Pi.
     */
    /** `hide`: the person typed it on a card (a password, a code), so Pi's reads of this page never show it (`hideTyped`). */
    async fill(
        observed: Observed,
        element: Element,
        text: string,
        { clear = true, submit = false, hide = false }: { clear?: boolean; submit?: boolean; hide?: boolean } = {},
    ): Promise<void> {
        if (!element.fill) {
            throw new Error(`[${element.index}] ${element.label} is not a field to type into.`);
        }

        // Kept before it is typed: a read the typing sets off already hides it. Very short values would hide too much.
        if (hide && text.length >= 3) {
            this.#typed.add(text);
        }

        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        await this.#click(await this.#point(element, true));

        if (clear) {
            for (const type of ["keyDown", "keyUp"]) {
                await this.cdp.send("Input.dispatchKeyEvent", { type, key: "a", code: "KeyA", modifiers: 2, windowsVirtualKeyCode: 65, ...(type === "keyDown" ? { commands: ["selectAll"] } : {}) });
            }
        }

        await this.cdp.send("Input.insertText", { text });
        this.#afterInput = { node: element.node, kind: "fill" } as RawAction;

        if (submit) {
            await this.press("Enter");
        }
    }

    /** Choose an option of a drop-down list, by its text (or value), as a person picking it would. */
    async select(observed: Observed, element: Element, option: string): Promise<string> {
        const wanted = option.trim().toLowerCase();
        const match =
            element.options?.find((each) => each.label.trim().toLowerCase() === wanted) ??
            element.options?.find((each) => each.value.trim().toLowerCase() === wanted) ??
            element.options?.find((each) => each.label.toLowerCase().includes(wanted));

        if (match === undefined) {
            throw new Error(
                element.options === undefined
                    ? `[${element.index}] ${element.label} is not a drop-down list.`
                    : `[${element.index}] ${element.label} has no option ${quote(option)}: its options are ${element.options.map((each) => quote(each.label)).join(", ")}.`,
            );
        }

        if (!(await this.#fresh(observed, element.node))) {
            throw new StalePage("The page changed since it was read: read it again.");
        }

        await this.#point(element, false);

        const done = await this.evaluate<boolean>(`((node, value) => {
            const e=window.__piBrowser?.nodes.get(node);
            if (!e || e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===value && !o.disabled)) return false;
            e.value=value;
            e.dispatchEvent(new Event('input',{bubbles:true}));
            e.dispatchEvent(new Event('change',{bubbles:true}));
            return true;
          })(${element.node}, ${JSON.stringify(match.value)})`);

        if (!done) {
            throw new StalePage(`[${element.index}] ${element.label} changed: read the page again.`);
        }

        this.#afterInput = { node: element.node, kind: "click" } as RawAction;

        return match.label;
    }

    /**
     * Scroll by screens, down or up: a wheel over the middle of the page, or, given a control, over the part in view of
     * what scrolls around it (an open list's own scroll area, PP-116), by its height.
     */
    async scroll(direction: "up" | "down", screens: number, within?: { observed: Observed; element: Element }): Promise<void> {
        let area: { x: number; y: number; h: number } | null;

        if (within === undefined) {
            area = await this.evaluate<{ x: number; y: number; h: number }>("({x: innerWidth/2, y: innerHeight/2, h: innerHeight})");
        } else {
            const { observed, element } = within;

            if (!(await this.#fresh(observed, element.node))) {
                throw new StalePage("The page changed since it was read: read it again.");
            }

            area = await this.evaluate<{ x: number; y: number; h: number } | null>(`((node, down) => {
                const e=window.__piBrowser?.nodes.get(node);
                if (!e?.isConnected) return null;
                for (let s=e; s && s!==document.body && s!==document.documentElement; s=s.parentElement) {
                  const style=getComputedStyle(s);
                  if (!/(auto|scroll|overlay)/.test(style.overflowY) || s.scrollHeight<=s.clientHeight+1) continue;
                  if (down ? s.scrollTop+s.clientHeight>=s.scrollHeight-1 : s.scrollTop<=0) continue;
                  const r=s.getBoundingClientRect(), top=Math.max(0,r.top), bottom=Math.min(innerHeight,r.bottom);
                  const left=Math.max(0,r.left), right=Math.min(innerWidth,r.right);
                  if (bottom-top<4 || right-left<4) continue;
                  return {x:(left+right)/2, y:(top+bottom)/2, h:s.clientHeight};
                }
                return {x: innerWidth/2, y: innerHeight/2, h: innerHeight};
              })(${element.node}, ${direction === "down"})`);

            if (area === null || area === undefined) {
                throw new StalePage(`[${element.index}] ${element.label} is gone: read the page again.`);
            }
        }

        const delta = Math.round(area.h * 0.85 * screens) * (direction === "down" ? 1 : -1);

        await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(area.x), y: Math.round(area.y), deltaX: 0, deltaY: delta });
        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    async press(key: string): Promise<void> {
        const known = keyOf(key);

        if (known === undefined) {
            throw new Error(`Pi's browser presses ${PRESSABLE.join(", ")}, or one character (a list's type-ahead); for text, type it.`);
        }

        const before = this.#loads;
        const keys = { key: known.key, code: known.code, windowsVirtualKeyCode: known.keyCode };

        await this.cdp.send("Input.dispatchKeyEvent", known.text === undefined ? { type: "rawKeyDown", ...keys } : { type: "keyDown", ...keys, text: known.text });
        await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...keys });
        await this.#followNavigation(before);
    }

    /** Back or forward in this tab's history; false when there is nothing that way. */
    async history(step: -1 | 1): Promise<boolean> {
        const history = await this.cdp.send<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
        const entry = history.entries[history.currentIndex + step];

        if (entry === undefined) {
            return false;
        }

        const before = this.#loads;

        await this.cdp.send("Page.navigateToHistoryEntry", { entryId: entry.id });
        await this.#followNavigation(before);

        return true;
    }

    /** All of the page's text at once (an article, docs, a table), up to `max` characters. */
    async text(max: number): Promise<{ title: string; url: string; text: string; cut: boolean }> {
        const page = await this.evaluate<{ title: string; url: string; text: string }>("({title: document.title, url: location.href, text: document.body ? document.body.innerText : ''})");
        const text = this.hideTyped(page.text.replace(/\n{3,}/g, "\n\n").trim());

        return { title: this.hideTyped(page.title), url: this.hideTyped(page.url), text: text.slice(0, max), cut: text.length > max };
    }

    /**
     * What is in view now, as a JPEG (base64), by DevTools: a Chrome's (`BrowserEngine.picture`). The phone's WebView
     * answers a capture only every other time (PP-114): its pictures come from its display's frames instead.
     */
    async screenshot(quality = 70, timeoutMs?: number): Promise<string> {
        // A desktop Chrome from its surface, which alone has the device scale (twice the CSS pixels: sharp text).
        const shot = await this.cdp.send<{ data: string }>("Page.captureScreenshot", { format: "jpeg", quality, fromSurface: this.#fromSurface }, timeoutMs);

        return shot.data;
    }

    /** Wait until the text shows (up to 30 s), or for some seconds (up to 10); true when the text showed. */
    async wait({ text, seconds }: { text?: string; seconds?: number }): Promise<boolean> {
        if (text !== undefined && text !== "") {
            const until = Date.now() + 30_000;

            while (Date.now() < until) {
                const found = await this.evaluate<boolean>(`(document.body?.innerText ?? '').toLowerCase().includes(${JSON.stringify(text.toLowerCase())})`).catch(() => false);

                if (found) {
                    return true;
                }

                await new Promise((resolve) => setTimeout(resolve, 250));
            }

            return false;
        }

        await new Promise((resolve) => setTimeout(resolve, Math.min(10, Math.max(0, seconds ?? 1)) * 1000));

        return true;
    }
}
