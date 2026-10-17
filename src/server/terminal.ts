/**
 * Terminals (DESIGN.md section 4): a shell in a pseudo-terminal, on this phone or on a machine, shown by xterm.js in the
 * web app. pi-env's daemon runs it (`openTerminal`): over the machine's connection (`places.ts`), or, on the phone, a
 * daemon of its own started from the bundled Android build. One WebSocket per terminal at `/api/terminal`: the terminal
 * lives as long as the socket; closing either ends the other.
 *
 * Owner only, as a shell reaches everything. A browser sends a WebSocket's cookies from any page, so the upgrade must
 * come from the app's own page (its `Origin`), the way other requests must carry `x-pocket`.
 *
 * Protocol: the server sends the terminal's output as binary frames, and `{"type":"exit","code"}` or
 * `{"type":"error","message"}` as text; the client sends `{"type":"input","data"}` and `{"type":"resize","cols","rows"}`.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import type { PocketApp } from "./app.ts";
import type { Auth } from "./auth.ts";
import { describe } from "./errors.ts";

const PATH = "/api/terminal";
const MAX_SIDE = 1000;

/** Size from the URL, as xterm.js measured it: whole cells, at least one. */
function cells(value: string | null, name: string): number {
    const number = Number(value);

    if (!Number.isInteger(number) || number < 1 || number > MAX_SIDE) {
        throw new Error(`${name} must be a whole number from 1 to ${MAX_SIDE}`);
    }

    return number;
}

function refuse(socket: Duplex, status: number, reason: string): void {
    socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** Answer upgrades to `/api/terminal` on `server`; returns how to close every terminal. */
export function attachTerminals(server: Server, app: PocketApp, auth: Auth): () => void {
    const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

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
            // What the browser sends before the terminal has started is kept, in order, and given to it then.
            let terminal: Awaited<ReturnType<PocketApp["places"]["terminal"]>> | undefined;
            const early: string[] = [];
            let gone = false;
            const handle = (text: string) => {
                try {
                    const message = JSON.parse(text) as { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };

                    if (message.type === "input" && typeof message.data === "string") {
                        terminal!.write(message.data);
                    } else if (message.type === "resize") {
                        terminal!.resize(cells(String(message.cols), "cols"), cells(String(message.rows), "rows"));
                    }
                } catch (error) {
                    send({ type: "error", message: describe(error) });
                }
            };

            ws.on("message", (data, binary) => {
                if (binary) {
                    return;
                }

                if (terminal === undefined) {
                    early.push(String(data));
                } else {
                    handle(String(data));
                }
            });
            ws.on("close", () => {
                gone = true;
                terminal?.close();
            });

            void (async () => {
                const place = url.searchParams.get("place") || app.defaultCwd;
                const cwd = place.startsWith("machine:") ? await app.workspace.checkPlace(place) : app.workspace.checkDirectory(place);
                const started = await app.places.terminal(cwd, {
                    cols: cells(url.searchParams.get("cols"), "cols"),
                    rows: cells(url.searchParams.get("rows"), "rows"),
                    onData: (bytes) => ws.readyState === ws.OPEN && ws.send(bytes, { binary: true }),
                });

                // The browser left while it started: nothing to show it to.
                if (gone) {
                    started.close();

                    return;
                }

                terminal = started;

                for (const text of early.splice(0)) {
                    handle(text);
                }

                started.exited.then(
                    (code) => {
                        send({ type: "exit", code });
                        ws.close(1000, "exited");
                    },
                    (error: unknown) => {
                        send({ type: "error", message: describe(error) });
                        ws.close(1011, "failed");
                    },
                );
            })().catch((error: unknown) => {
                send({ type: "error", message: describe(error) });
                ws.close(1011, "failed");
            });
        });
    });

    return () => {
        for (const client of sockets.clients) {
            client.terminate();
        }

        sockets.close();
    };
}
