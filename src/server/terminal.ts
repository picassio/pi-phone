/**
 * Terminals (DESIGN.md section 4): a shell in a pseudo-terminal, on this phone or on a machine, shown by xterm.js in the
 * web app. pi-env's daemon runs it (`openTerminal`): over the machine's connection (`places.ts`), or, on the phone, a
 * daemon of its own started from the bundled Android build.
 *
 * A shell outlives its WebSocket: a phone drops the socket whenever the app goes to the background. It waits, detached,
 * for `DETACHED_MS`, keeping the end of its output; a socket that asks for it by id (`?id=`) gets that output again and
 * takes over. One socket at a time: a new one replaces the old. It ends when the program exits, when asked
 * (`{"type":"close"}`), or when nobody came back in time.
 *
 * Owner only, as a shell reaches everything. A browser sends a WebSocket's cookies from any page, so the upgrade must
 * come from the app's own page (its `Origin`), the way other requests must carry `x-pocket`.
 *
 * Protocol: the server sends `{"type":"ready","id"}` first, then the output as binary frames, and `{"type":"exit","code"}`
 * or `{"type":"error","message"}` as text; the client sends `{"type":"input","data"}`, `{"type":"resize","cols","rows"}`,
 * and `{"type":"close"}`.
 */
import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { RemoteTerminal } from "@earendil-works/pi-env";
import { type WebSocket, WebSocketServer } from "ws";
import type { PocketApp } from "./app.ts";
import type { Auth } from "./auth.ts";
import { describe } from "./errors.ts";

const PATH = "/api/terminal";
const MAX_SIDE = 1000;
/** How long a shell nobody looks at waits for its page to come back. */
export const DETACHED_MS = 15 * 60_000;
/** The end of its output a shell keeps for a page that comes back. */
const KEPT_BYTES = 256 * 1024;

/** Size as xterm.js measured it: whole cells, at least one. */
function cells(value: unknown, name: string): number {
    const number = Number(value);

    if (!Number.isInteger(number) || number < 1 || number > MAX_SIDE) {
        throw new Error(`${name} must be a whole number from 1 to ${MAX_SIDE}`);
    }

    return number;
}

function refuse(socket: Duplex, status: number, reason: string): void {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** A running shell, the page showing it (if any), and the end of what it wrote. */
class Shell {
    readonly id = randomUUID();
    readonly place: string;
    terminal: RemoteTerminal | undefined;
    #socket: WebSocket | undefined;
    #kept: Buffer[] = [];
    #keptBytes = 0;
    #timer: NodeJS.Timeout | undefined;
    /** How it ended, for a page that comes back after. */
    ended: object | undefined;
    readonly #forget: () => void;

    constructor(place: string, forget: () => void) {
        this.place = place;
        this.#forget = forget;
    }

    output(bytes: Uint8Array): void {
        const chunk = Buffer.from(bytes);

        this.#kept.push(chunk);
        this.#keptBytes += chunk.length;

        while (this.#keptBytes > KEPT_BYTES && this.#kept.length > 1) {
            this.#keptBytes -= this.#kept.shift()!.length;
        }

        if (this.#socket?.readyState === this.#socket?.OPEN) {
            this.#socket?.send(chunk, { binary: true });
        }
    }

    /** Show it on `socket`: its id, what it kept, and how it ended if it did. */
    attach(socket: WebSocket): void {
        const before = this.#socket;

        this.#socket = socket;
        clearTimeout(this.#timer);
        this.#timer = undefined;
        before?.close(4000, "replaced");
        socket.send(JSON.stringify({ type: "ready", id: this.id, place: this.place }));

        if (this.#keptBytes > 0) {
            socket.send(Buffer.concat(this.#kept), { binary: true });
        }

        if (this.ended !== undefined) {
            socket.send(JSON.stringify(this.ended));
            socket.close(1000, "ended");
        }
    }

    /** The page left: wait for it, unless the shell is done. */
    detach(socket: WebSocket): void {
        if (this.#socket !== socket) {
            return;
        }

        this.#socket = undefined;
        this.wait();
    }

    /** Nobody looks at it: it waits for a page, unless it is done. */
    wait(): void {
        if (this.ended !== undefined) {
            this.#forget();

            return;
        }

        clearTimeout(this.#timer);
        this.#timer = setTimeout(() => this.close(), DETACHED_MS);
        this.#timer.unref();
    }

    finish(message: object): void {
        this.ended = message;

        if (this.#socket !== undefined) {
            this.#socket.send(JSON.stringify(message));
            this.#socket.close(1000, "ended");
        } else {
            this.#forget();
        }
    }

    close(): void {
        clearTimeout(this.#timer);
        this.terminal?.close();
        this.#socket?.close(1000, "closed");
        this.#forget();
    }
}

/** Answer upgrades to `/api/terminal` on `server`; returns how to close every terminal. */
export function attachTerminals(server: Server, app: PocketApp, auth: Auth): () => void {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
    const shells = new Map<string, Shell>();

    /** A new shell at the place asked for, started at the page's size. */
    const start = async (url: URL): Promise<Shell> => {
        const place = url.searchParams.get("place") || app.defaultCwd;
        const cwd = place.startsWith("machine:") ? await app.workspace.checkPlace(place) : app.workspace.checkDirectory(place);
        const shell = new Shell(place, () => shells.delete(shell.id));

        shell.terminal = await app.places.terminal(cwd, {
            cols: cells(url.searchParams.get("cols"), "cols"),
            rows: cells(url.searchParams.get("rows"), "rows"),
            onData: (bytes) => shell.output(bytes),
        });
        shells.set(shell.id, shell);
        shell.terminal.exited.then(
            (code) => shell.finish({ type: "exit", code }),
            (error: unknown) => shell.finish({ type: "error", message: describe(error) }),
        );

        return shell;
    };

    server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const url = new URL(request.url ?? "/", "http://pi-phone.local");

        if (url.pathname !== PATH) {
            return refuse(socket, 404, "Not Found");
        }

        const user = auth.user(request);

        if (user?.role !== "owner") {
            return refuse(socket, 403, "Forbidden");
        }

        if (request.headers.origin !== `http://${request.headers.host}`) {
            return refuse(socket, 403, "Forbidden");
        }

        sockets.handleUpgrade(request, socket, head, (ws) => {
            const send = (message: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(message));
            // What the page sends before its shell is there is kept, in order, and given to it then.
            let shell: Shell | undefined;
            const early: string[] = [];
            let gone = false;
            const handle = (text: string) => {
                try {
                    const message = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };

                    if (message.type === "input" && typeof message.data === "string") {
                        shell!.terminal!.write(message.data);
                    } else if (message.type === "resize") {
                        shell!.terminal!.resize(cells(message.cols, "cols"), cells(message.rows, "rows"));
                    } else if (message.type === "close") {
                        shell!.close();
                    }
                } catch (error) {
                    send({ type: "error", message: describe(error) });
                }
            };

            ws.on("message", (data, binary) => {
                if (binary) {
                    return;
                }

                if (shell === undefined) {
                    early.push(String(data));
                } else {
                    handle(String(data));
                }
            });
            ws.on("close", () => {
                gone = true;
                shell?.detach(ws);
            });

            void (async () => {
                const asked = url.searchParams.get("id");
                let found: Shell;

                if (asked) {
                    const kept = shells.get(asked);

                    if (kept === undefined) {
                        send({ type: "gone" });
                        ws.close(1000, "gone");

                        return;
                    }

                    found = kept;
                } else {
                    found = await start(url);
                }

                shell = found;

                if (gone) {
                    // The page left while its shell started: it waits for the page as any other.
                    found.wait();

                    return;
                }

                found.attach(ws);

                for (const text of early.splice(0)) {
                    handle(text);
                }
            })().catch((error: unknown) => {
                send({ type: "error", message: describe(error) });
                ws.close(1011, "failed");
            });
        });
    });

    return () => {
        for (const shell of [...shells.values()]) {
            shell.close();
        }

        for (const client of sockets.clients) {
            client.terminate();
        }

        sockets.close();
    };
}
