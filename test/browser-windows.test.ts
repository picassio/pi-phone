// Windows a page opens in Pi's browser on the phone (PP-249: window.open, a link to a new window, an MSAL sign-in popup),
// against a stand-in for the phone's WebView: a fake DevTools with a page per target, and an engine that asks before
// each window opens, as PiBrowser.java asks the app. A window becomes a tab in front, with a note; when it closes
// itself the page that opened it comes back, with a note; with browser.popups off the page gets none, and Pi hears why;
// with ask, the person answers a card on the call that opened it first.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Cdp } from "../src/server/browser/cdp.ts";
import { type BrowserEngine, PiBrowser, type PopupMode, type WindowAsk } from "../src/server/browser/pi-browser.ts";

/** A page of the fake WebView: where it is, its title, the page that opened it, and what a click on its button does. */
type Target = { url: string; title: string; openerId?: string; socket?: WebSocket; onClick?: () => void };

/** DevTools for pages that each show one button, "Sign in": as much of Chrome's protocol as Pi's browser asks of a page. */
class FakeWebView {
    readonly #server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    readonly targets = new Map<string, Target>();

    constructor() {
        this.#server.on("connection", (socket, request) => {
            const id = /\/devtools\/page\/(.+)$/.exec(request.url ?? "")?.[1] ?? "";
            const target = this.targets.get(id);

            if (target === undefined) {
                socket.close();

                return;
            }

            target.socket = socket;
            socket.on("message", (raw) => {
                const { id: call, method, params = {} } = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> };
                const answer = (result: Record<string, unknown>) => socket.send(JSON.stringify({ id: call, result }));

                if (method === "Runtime.evaluate") {
                    return answer({ result: { value: this.#evaluate(target, String(params.expression)) } });
                }

                if (method === "Page.getFrameTree") {
                    return answer({ frameTree: { frame: { id: "main" } } });
                }

                if (method === "Page.navigate") {
                    target.url = String(params.url);
                    answer({});

                    return socket.send(JSON.stringify({ method: "Page.frameNavigated", params: { frame: { id: "main", url: target.url } } }));
                }

                if (method === "Input.dispatchMouseEvent" && params.type === "mouseReleased") {
                    answer({});

                    return target.onClick?.();
                }

                if (method === "Target.getTargetInfo") {
                    return answer({ targetInfo: { targetId: id, type: "page", ...(target.openerId === undefined ? {} : { openerId: target.openerId }) } });
                }

                answer({});
            });
        });
    }

    #evaluate(target: Target, expression: string): unknown {
        if (expression === "location.href") {
            return target.url;
        }

        if (expression === "document.title") {
            return target.title;
        }

        if (expression === "[document.title, location.href]") {
            return [target.title, target.url];
        }

        if (expression === "document.readyState") {
            return "complete";
        }

        // The page as Pi reads it (snapshot.js): one button.
        if (expression.startsWith("// The page as Pi reads it")) {
            return {
                url: target.url,
                title: target.title,
                w: 412,
                h: 860,
                text: `${target.title} page`,
                scroll: { y: 0, height: 860 },
                actions: [{ node: 1, role: "button", label: "Sign in", rect: { x: 0, y: 0, w: 100, h: 30 }, kind: "click", value: "" }],
                marker: [],
                page_key: [],
                guards: {},
                omitted: 0,
            };
        }

        // A control as it was read, and where to click it.
        if (expression.includes("c.pageKey()")) {
            return [[], null];
        }

        if (expression.includes("elementFromPoint")) {
            return { x: 10, y: 10 };
        }

        return undefined;
    }

    url(id: string): string {
        return `ws://127.0.0.1:${(this.#server.address() as AddressInfo).port}/devtools/page/${id}`;
    }

    /** An event of a page's, as Chrome sends one. */
    emit(id: string, method: string, params: Record<string, unknown>): void {
        this.targets.get(id)?.socket?.send(JSON.stringify({ method, params }));
    }

    /** A page gone (its window closed itself): its DevTools connection ends. */
    gone(id: string): void {
        this.targets.get(id)?.socket?.terminate();
        this.targets.delete(id);
    }

    listening(): Promise<void> {
        return this.#server.address() === null ? new Promise((resolve) => this.#server.once("listening", () => resolve())) : Promise.resolve();
    }

    close(): Promise<void> {
        for (const client of this.#server.clients) {
            client.terminate();
        }

        return new Promise((resolve) => this.#server.close(() => resolve()));
    }
}

/**
 * The phone's engine as PiBrowser.java makes it: Teams in tab `t1`; a window a page opens is asked about first (none
 * while popups is off: the WebView refuses it itself), and its tab is made when Pi's browser opens it.
 */
class FakePhone implements BrowserEngine {
    readonly label = "the fake phone";
    readonly popups = true;
    readonly asksWindows = true;
    readonly local = false;
    readonly actAsPhone = false;
    readonly reopensToResize = false;
    readonly view = new FakeWebView();
    readonly #watchers = new Set<(ask: WindowAsk) => boolean>();
    readonly #mode: () => PopupMode;
    /** Windows given to the page (opened), and refused. */
    readonly opened: string[] = [];
    readonly refused: string[] = [];

    constructor(mode: () => PopupMode) {
        this.#mode = mode;
    }

    watchWindows(asked: (ask: WindowAsk) => boolean): () => void {
        this.#watchers.add(asked);

        return () => this.#watchers.delete(asked);
    }

    /** The page in `opener` opens `url` in a window, with a click: DevTools says so, and the phone asks (unless off). */
    windowOpen(opener: string, tab: string, url: string): void {
        this.view.emit(opener, "Page.windowOpen", { url, windowName: "msal", windowFeatures: [], userGesture: true });

        if (this.#mode() === "off") {
            return;
        }

        const ask: WindowAsk = {
            opener,
            tab,
            gesture: true,
            open: async () => {
                this.view.targets.set(tab, { url, title: "Sign in to your account", openerId: opener });
                this.opened.push(tab);
            },
            refuse: async () => {
                this.refused.push(tab);
            },
        };

        if (![...this.#watchers].some((watcher) => watcher(ask))) {
            void ask.refuse();
        }
    }

    tabs = async () => [];
    newTab = async () => {
        this.view.targets.set("t1", { url: "about:blank", title: "Teams" });

        return "t1";
    };
    connect = (id: string) => Cdp.connect({ url: this.view.url(id) });
    closeTab = async (id: string) => this.view.gone(id);
    close = async () => {
        for (const id of [...this.view.targets.keys()]) {
            this.view.gone(id);
        }
    };
    pdf = async () => Buffer.alloc(0);
    picture = async () => "";
    stage = async (name: string) => name;
}

const opened: { browser?: PiBrowser; phone: FakePhone }[] = [];
let app: App | undefined;

after(async () => {
    for (const { browser, phone } of opened) {
        await browser?.close().catch(() => {});
        await phone.view.close();
    }

    await app?.close();
    cleanUp();
});

async function teams(mode: { now: PopupMode }) {
    const phone = new FakePhone(() => mode.now);

    await phone.view.listening();

    const browser = new PiBrowser({ engine: phone, session: 1, changed: () => {}, frame: () => {}, log: () => {}, popups: () => mode.now });

    opened.push({ browser, phone });
    // Teams' "Sign in again" opens the sign-in in a window (MSAL's popup).
    await browser.open(1, "https://teams.test/");
    phone.view.targets.get("t1")!.onClick = () => phone.windowOpen("t1", "w1", "https://login.test/authorize");

    return { browser, phone };
}

test("a window a page opens becomes a tab in front, and Pi is told; when it closes itself, the page that opened it is in front again, and Pi is told (PP-249)", async () => {
    const { browser, phone } = await teams({ now: "allow" });
    const clicked = await browser.click(1, 1);

    assert.deepEqual(phone.opened, ["w1"]);
    assert.match(clicked, /^The page opened a window: https:\/\/login\.test\/authorize; it is tab 2 now \(in front\)\.\nTab 2 of 2\. Sign in to your account — https:\/\/login\.test\/authorize\n/);
    assert.equal(browser.state().tabs.length, 2);
    assert.equal(browser.state().tab, 1);
    assert.match(await browser.tabs(1), /^Tabs \(→ in front\):\n {2}1\. Teams — https:\/\/teams\.test\/\n→ 2\. Sign in to your account — https:\/\/login\.test\/authorize$/);

    // The sign-in is done: the window closes itself (window.close), and its tab goes.
    phone.view.gone("w1");
    await until(() => browser.state().tabs.length === 1, "the window's tab gone");
    assert.equal(browser.state().tab, 0);

    const back = await browser.snapshot(1);

    assert.match(back, /^The window https:\/\/login\.test\/authorize closed itself; tab 1, the page that opened it, is in front again\.\nTeams — https:\/\/teams\.test\/\n/);
    // Told once.
    assert.match(await browser.snapshot(1), /^Teams — /);
});

test("with popups off, the page gets no window, and Pi is told it tried (PP-249)", async () => {
    const { browser, phone } = await teams({ now: "off" });
    const clicked = await browser.click(1, 1);

    assert.match(clicked, /^The page tried to open a window: https:\/\/login\.test\/authorize \(Pi's browser › popups is off\)\.\nTeams — /);
    assert.deepEqual(phone.opened, []);
    assert.equal(browser.state().tabs.length, 1);
});

test("with popups ask, a window waits for the person: allowed, it opens as a tab; denied, the page gets none (PP-249)", async () => {
    const { browser, phone } = await teams({ now: "ask" });

    assert.match(await browser.click(1, 1), /^Teams — /);
    assert.deepEqual(browser.windowAsks(), [{ id: "w1", url: "https://login.test/authorize" }]);
    assert.deepEqual(phone.opened, []);
    assert.match(await browser.answerWindow(1, "w1", true, "Tuan"), /^The page opened a window: https:\/\/login\.test\/authorize; it is tab 2 now \(in front\)\.\nTab 2 of 2\. /);
    assert.deepEqual(browser.windowAsks(), []);
    assert.deepEqual(phone.opened, ["w1"]);

    // Another one, from Teams again, which the person refuses.
    await browser.switchTab(1, 1);
    phone.view.targets.get("t1")!.onClick = () => phone.windowOpen("t1", "w2", "https://login.test/again");
    await browser.click(1, 1);
    assert.match(await browser.answerWindow(1, "w2", false, "Tuan"), /^The page tried to open a window: https:\/\/login\.test\/again \(Tuan said no\)\.\nTab 1 of 2\. Teams/);
    assert.deepEqual(phone.refused, ["w2"]);
});

/** What Pi calls, by the message's end. */
const calls: Record<string, [string, Record<string, unknown>]> = {
    "open teams": ["browser_open", { url: "https://teams.test/" }],
    "sign in again": ["browser_click", { index: 1 }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};

test("with popups ask, the call whose page opened a window shows the person a card with its address; Allow opens it (PP-249)", async () => {
    const phone = new FakePhone(() => app!.config.browserPopups);

    await phone.view.listening();
    opened.push({ phone });
    app = await openApp(scriptedModel(route), join(root, "browser-windows"), undefined, { browserEngine: phone });
    app.setBrowserPopups(owner(app), "ask");
    assert.throws(() => app!.setBrowserPopups(owner(app!), "sometimes"), /allow, ask or off/);

    const id = await newSession(app);
    const turn = async (text: string, answer?: boolean) => {
        const { submissionId } = await app!.commands.submit(id, owner(app!), { text, requestId: crypto.randomUUID() });
        let card: ReturnType<App["approvals"]["all"]>[number] | undefined;

        if (answer !== undefined) {
            await until(() => app!.approvals.forConversation(id).length > 0, "the card", 20_000);
            card = app!.approvals.forConversation(id)[0]!;
            await app!.answerApproval(card.id, answer, owner(app!));
        }

        await (await app!.harness.submission(submissionId, context))!.wait(context);

        return { said: (await modelTexts(app!, id)).at(-1)!, card };
    };

    assert.match((await turn("open teams")).said, /Teams — https:\/\/teams\.test\//);
    phone.view.targets.get("t1")!.onClick = () => phone.windowOpen("t1", "w1", "https://login.test/authorize");

    const { said, card } = await turn("sign in again", true);

    assert.equal(card?.tool, "browser_click");
    assert.equal(card?.subject, "https://login.test/authorize");
    assert.match(card?.reason ?? "", /The page asks to open a window/);
    assert.deepEqual(phone.opened, ["w1"]);
    assert.match(said, /The page opened a window: https:\/\/login\.test\/authorize; it is tab 2 now \(in front\)\./);
});
