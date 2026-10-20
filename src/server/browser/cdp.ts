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

export class Cdp {
    readonly #ws: WebSocket;
    readonly #pending = new Map<number, Pending>();
    readonly #listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>();
    #next = 1;
    #closed = false;
    /** Called once when the connection ends, for whatever reason. */
    onClose: (() => void) | undefined;

    private constructor(ws: WebSocket) {
        this.#ws = ws;
        ws.on("message", (raw) => this.#message(String(raw)));
        ws.on("close", () => this.#ended(new CdpError("The browser's connection closed.")));
        ws.on("error", (error) => this.#ended(new CdpError(`The browser's connection failed: ${error.message}`)));
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

        const id = this.#next++;

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
            this.#ws.send(JSON.stringify({ id, method, params }));
        });
    }

    /** Hear an event; returns how to stop. */
    on(method: string, listener: (params: Record<string, unknown>) => void): () => void {
        const set = this.#listeners.get(method) ?? new Set();

        set.add(listener);
        this.#listeners.set(method, set);

        return () => set.delete(listener);
    }

    close(): void {
        if (!this.#closed) {
            this.#ws.close();
            this.#ended(new CdpError("The browser's connection closed."));
        }
    }

    #message(raw: string): void {
        let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string }; method?: string; params?: Record<string, unknown> };

        try {
            message = JSON.parse(raw) as typeof message;
        } catch {
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
        this.onClose?.();
    }
}
