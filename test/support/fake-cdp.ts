// A stand-in for a Chrome's DevTools on a machine (PP-274), as `browser-windows.test.ts`'s fake WebView stands in for the
// phone's: HTTP `/json/version`, `/json/list`, `/json/new`, `/json/close/<id>`; a page per target over a WebSocket; and
// the browser's own WebSocket (`/devtools/browser/<id>`), with its targets and flattened page sessions, as Chrome's
// `chrome://inspect/#remote-debugging` opt-in gives (with `httpOff`, nothing but it). Each page shows one button
// ("Sign in"), as much of the protocol as Pi's browser asks of a page. A test can emit a page's events (a binding
// called: a person's input in the window) and see every command a page and the browser got.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

type Sink = (message: Record<string, unknown>) => void;

/** A page: where it is, its title, the page that opened it, its connections' event sinks, and how each ends with it. */
export type FakeTarget = { url: string; title: string; openerId?: string; sinks: Set<Sink>; ends: Set<() => void> };

export class FakeCdp {
    readonly targets = new Map<string, FakeTarget>();
    /** Every command a page got (`target`) or the browser's own connection (`target: "browser"`), by its method. */
    readonly commands: { target: string; method: string; params: Record<string, unknown> }[] = [];
    /** What `/json/version` and `Browser.getVersion` say. */
    version: Record<string, unknown> = {
        Browser: "Chrome/156.0.8078.80",
        "Protocol-Version": "1.3",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36",
    };
    /** The browser endpoint's id: a browser started again has another. */
    browserId = "b1";
    /** Without the HTTP endpoints, as Chrome's own opt-in. */
    httpOff = false;
    readonly #http: Server;
    readonly #ws = new WebSocketServer({ noServer: true });
    #next = 1;

    constructor() {
        this.#http = createServer((request, response) => {
            const url = request.url ?? "";
            const send = (body: unknown) => {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(body));
            };

            if (this.httpOff) {
                response.writeHead(404);
                response.end();

                return;
            }

            if (url === "/json/version") {
                return send({ ...this.version, webSocketDebuggerUrl: `ws://127.0.0.1:${this.port}/devtools/browser/${this.browserId}` });
            }

            if (url === "/json/list") {
                return send([...this.targets].reverse().map(([id, target]) => ({ id, type: "page", url: target.url, title: target.title })));
            }

            if (url.startsWith("/json/new") && request.method === "PUT") {
                return send({ id: this.add("about:blank", ""), type: "page", url: "about:blank" });
            }

            const close = /^\/json\/close\/(.+)$/.exec(url)?.[1];

            if (close !== undefined) {
                this.gone(close);
                response.end("Target is closing");

                return;
            }

            response.writeHead(404);
            response.end();
        });
        this.#http.on("upgrade", (request: IncomingMessage, socket, head) => {
            const url = request.url ?? "";

            if (url === `/devtools/browser/${this.browserId}`) {
                this.#ws.handleUpgrade(request, socket, head, (ws) => this.#browser(ws));

                return;
            }

            const id = /\/devtools\/page\/(.+)$/.exec(url)?.[1] ?? "";

            if (this.httpOff || !this.targets.has(id)) {
                socket.destroy();

                return;
            }

            this.#ws.handleUpgrade(request, socket, head, (ws) => {
                const sink: Sink = (message) => ws.send(JSON.stringify(message));
                const target = this.targets.get(id)!;

                target.sinks.add(sink);
                target.ends.add(() => ws.terminate());
                ws.on("close", () => target.sinks.delete(sink));
                ws.on("message", (raw) => this.#page(id, JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown> }, sink));
            });
        });
    }

    /** A tab that is there already (the owner's, Playwright's), or one a page opened (`openerId`). */
    add(url: string, title: string, openerId?: string): string {
        const id = `t${this.#next++}`;

        this.targets.set(id, { url, title, ...(openerId === undefined ? {} : { openerId }), sinks: new Set(), ends: new Set() });

        return id;
    }

    /** The browser's own connection: its targets, and pages as flattened sessions on it. */
    #browser(ws: WebSocket): void {
        const sessions = new Map<string, { target: string; sink: Sink }>();
        const send = (message: Record<string, unknown>) => ws.send(JSON.stringify(message));

        ws.on("close", () => {
            for (const { target, sink } of sessions.values()) {
                this.targets.get(target)?.sinks.delete(sink);
            }
        });
        ws.on("message", (raw) => {
            const message = JSON.parse(String(raw)) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };

            if (message.sessionId !== undefined) {
                const session = sessions.get(message.sessionId);

                if (session !== undefined) {
                    this.#page(session.target, message, session.sink);
                }

                return;
            }

            const { id, method, params = {} } = message;
            const answer = (result: Record<string, unknown>) => send({ id, result });

            this.commands.push({ target: "browser", method, params });

            if (method === "Browser.getVersion") {
                return answer({ product: String(this.version.Browser), userAgent: String(this.version["User-Agent"]) });
            }

            if (method === "Target.getTargets") {
                return answer({ targetInfos: [...this.targets].map(([targetId, target]) => ({ targetId, type: "page", url: target.url, title: target.title, ...(target.openerId === undefined ? {} : { openerId: target.openerId }) })) });
            }

            if (method === "Target.createTarget") {
                return answer({ targetId: this.add(String(params.url ?? "about:blank"), "") });
            }

            if (method === "Target.closeTarget") {
                this.gone(String(params.targetId));

                return answer({ success: true });
            }

            if (method === "Target.attachToTarget") {
                const target = this.targets.get(String(params.targetId));

                if (target === undefined) {
                    return send({ id, error: { message: "No target with given id found" } });
                }

                const sessionId = `s${this.#next++}`;
                const sink: Sink = (event) => send({ ...event, sessionId });

                target.sinks.add(sink);
                target.ends.add(() => send({ method: "Target.detachedFromTarget", params: { sessionId, targetId: params.targetId } }));
                sessions.set(sessionId, { target: String(params.targetId), sink });

                return answer({ sessionId });
            }

            if (method === "Target.detachFromTarget") {
                const session = sessions.get(String(params.sessionId));

                session && this.targets.get(session.target)?.sinks.delete(session.sink);
                sessions.delete(String(params.sessionId));
            }

            answer({});
        });
    }

    /** A page's command, from its own connection or a session on the browser's: `reply` gets the answer. */
    #page(id: string, message: { id: number; method: string; params?: Record<string, unknown> }, reply: Sink): void {
        const target = this.targets.get(id);
        const { id: call, method, params = {} } = message;
        const answer = (result: Record<string, unknown>) => reply({ id: call, result });

        if (target === undefined) {
            return reply({ id: call, error: { message: "Target closed" } });
        }

        this.commands.push({ target: id, method, params });

        if (method === "Runtime.evaluate") {
            return answer({ result: { value: this.#evaluate(target, String(params.expression)) } });
        }

        if (method === "Browser.getVersion") {
            return answer({ product: String(this.version.Browser) });
        }

        if (method === "Page.getFrameTree") {
            return answer({ frameTree: { frame: { id: "main" } } });
        }

        if (method === "Page.navigate") {
            target.url = String(params.url);
            target.title = new URL(target.url).hostname;
            answer({});

            return reply({ method: "Page.frameNavigated", params: { frame: { id: "main", url: target.url } } });
        }

        if (method === "Target.getTargetInfo") {
            return answer({ targetInfo: { targetId: id, type: "page", ...(target.openerId === undefined ? {} : { openerId: target.openerId }) } });
        }

        answer({});
    }

    #evaluate(target: FakeTarget, expression: string): unknown {
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

        if (expression === "navigator.userAgent") {
            return String(this.version["User-Agent"]);
        }

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

        if (expression.includes("c.pageKey()")) {
            return [[], null];
        }

        if (expression.includes("elementFromPoint")) {
            return { x: 10, y: 10 };
        }

        return undefined;
    }

    /** An event of a page's, as Chrome sends one, to every connection to it. */
    emit(id: string, method: string, params: Record<string, unknown>): void {
        for (const sink of this.targets.get(id)?.sinks ?? []) {
            sink({ method, params });
        }
    }

    gone(id: string): void {
        const target = this.targets.get(id);

        this.targets.delete(id);

        for (const end of target?.ends ?? []) {
            end();
        }
    }

    async listen(): Promise<number> {
        await new Promise<void>((resolve) => this.#http.listen(0, "127.0.0.1", resolve));

        return this.port;
    }

    get port(): number {
        return (this.#http.address() as AddressInfo).port;
    }

    close(): Promise<void> {
        for (const client of this.#ws.clients) {
            client.terminate();
        }

        this.#http.closeAllConnections();

        return new Promise((resolve) => this.#http.close(() => resolve()));
    }
}
