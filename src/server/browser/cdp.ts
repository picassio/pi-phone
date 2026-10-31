/**
 * A Chrome DevTools Protocol connection to one page (`browser/pi-browser.ts`): over the app's WebView DevTools socket on
 * the phone (`\0webview_devtools_remote_<pid>`, the APK being debuggable), or to a Chrome's page target elsewhere (tests,
 * a computer). Commands answer by id; events go to listeners by method.
 */
import net from "node:net";
import WebSocket from "ws";

type Pending = { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; method: string };

/** Where a page's DevTools endpoint is: a socket's name (abstract when it starts with \0) and a path, or a ws:// URL. */
export type CdpEndpoint = { socket: string; path: string } | { url: string };

export class CdpError extends Error {}

type Message = { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown>; sessionId?: string };

export class Cdp {
    readonly #ws: WebSocket;
    readonly #pending = new Map<number, Pending>();
    readonly #listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
    /**
     * A page's session on a browser's connection (`attach`, PP-274): its connection and session id; its commands carry
     * the id, and the connection gives it what carries it. Undefined for a connection of its own.
     */
    readonly #on: { root: Cdp; sessionId: string } | undefined;
    /** A browser connection's page sessions, by id. */
    readonly #sessions = new Map<string, Cdp>();
    #next = 1;
    #closed = false;
    /** Called once when the connection ends, for whatever reason. */
    onClose: (() => void) | undefined;

    private constructor(ws: WebSocket, on?: { root: Cdp; sessionId: string }) {
        this.#ws = ws;
        this.#on = on;

        if (on !== undefined) {
            return;
        }

        ws.on("message", (raw) => this.#message(String(raw)));
        ws.on("close", () => this.#ended(new CdpError("The browser's connection closed.")));
        ws.on("error", (error) => this.#ended(new CdpError(`The browser's connection failed: ${error.message}`)));
        this.on("Target.detachedFromTarget", (params) => {
            const session = this.#sessions.get(String(params.sessionId));

            if (session !== undefined) {
                session.#ended(new CdpError("The page's session ended."));
            }
        });
    }

    /**
     * A page of this browser connection as a connection of its own (`Target.attachToTarget`, flattened): what a
     * browser's DevTools give when only its browser endpoint is open, as Chrome's `chrome://inspect/#remote-debugging`
     * opt-in does (PP-274). Closing it detaches; it ends with the page or the connection.
     */
    async attach(targetId: string): Promise<Cdp> {
        const { sessionId } = await this.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
        const session = new Cdp(this.#ws, { root: this, sessionId });

        this.#sessions.set(sessionId, session);

        return session;
    }

    /** Connect to a page's DevTools endpoint; rejects with why it could not. */
    static connect(endpoint: CdpEndpoint, timeoutMs = 10_000): Promise<Cdp> {
        const ws =
            "url" in endpoint
                ? new WebSocket(endpoint.url, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
                : new WebSocket(`ws://localhost${endpoint.path}`, {
                      perMessageDeflate: false,
                      maxPayload: 64 * 1024 * 1024,
                      createConnection: () => net.connect(endpoint.socket),
                  });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                ws.terminate();
                reject(new CdpError("The browser did not answer within 10 seconds."));
            }, timeoutMs);

            ws.once("open", () => {
                clearTimeout(timer);
                resolve(new Cdp(ws));
            });
            ws.once("error", (error) => {
                clearTimeout(timer);
                reject(new CdpError(`Could not reach the browser: ${error.message}`));
            });
        });
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** Send a command; resolves with its result, or rejects with the protocol's error. */
    send<T extends Record<string, unknown> = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
        if (this.#closed) {
            return Promise.reject(new CdpError("The browser's connection is closed."));
        }

        const id = this.#id();

        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#pending.delete(id);
                reject(new CdpError(`${method} took longer than ${Math.round(timeoutMs / 1000)} seconds.`));
            }, timeoutMs);

            this.#pending.set(id, {
                method,
                resolve: (value) => {
                    clearTimeout(timer);
                    resolve(value as T);
                },
                reject: (error) => {
                    clearTimeout(timer);
                    reject(error);
                },
            });
            this.#ws.send(JSON.stringify({ id, method, params, ...(this.#on === undefined ? {} : { sessionId: this.#on.sessionId }) }));
        });
    }

    /** A command's number, unique on the connection (a page session's are its browser connection's). */
    #id(): number {
        return this.#on === undefined ? this.#next++ : this.#on.root.#id();
    }

    /** Hear an event; returns how to stop. */
    on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
        const set = this.#listeners.get(method) ?? new Set();

        set.add(listener);
        this.#listeners.set(method, set);

        return () => set.delete(listener);
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        if (this.#on === undefined) {
            this.#ws.close();
        } else {
            // A page session: the page and the browser stay.
            void this.#on.root.send("Target.detachFromTarget", { sessionId: this.#on.sessionId }).catch(() => {});
        }

        this.#ended(new CdpError("The browser's connection closed."));
    }

    #message(raw: string): void {
        let message: Message;

        try {
            message = JSON.parse(raw) as Message;
        } catch {
            return;
        }

        this.#deliver(message);
    }

    #deliver(message: Message): void {
        // A page session's answer or event, on its browser's connection.
        if (this.#on === undefined && typeof message.sessionId === "string") {
            const session = this.#sessions.get(message.sessionId);

            if (session !== undefined) {
                session.#deliver({ ...message, sessionId: undefined });
            }

            return;
        }

        if (typeof message.id === "number") {
            const pending = this.#pending.get(message.id);

            if (pending !== undefined) {
                this.#pending.delete(message.id);

                if (message.error !== undefined) {
                    pending.reject(new CdpError(`${pending.method}: ${message.error.message ?? "failed"}`));
                } else {
                    pending.resolve(message.result ?? {});
                }
            }

            return;
        }

        if (typeof message.method === "string") {
            for (const listener of this.#listeners.get(message.method) ?? []) {
                listener(message.params ?? {});
            }
        }
    }

    #ended(error: Error): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;

        for (const pending of this.#pending.values()) {
            pending.reject(error);
        }

        this.#pending.clear();
        if (this.#on !== undefined) {
            this.#on.root.#sessions.delete(this.#on.sessionId);
        }

        // A browser connection's end is its page sessions' too.
        for (const session of [...this.#sessions.values()]) {
            session.#ended(error);
        }

        this.onClose?.();
    }
}
