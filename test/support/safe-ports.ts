/**
 * No test server on a port fetch refuses (PP-404). A server listening on port 0 takes the port the system gives; where
 * the system's ephemeral range starts low (the devbox's is 1024–65535, Linux's default 32768–60999), that can be one of
 * the ports the Fetch standard blocks (6000, 6667, 2049, 10080 …: about 1 in 1,700 there), and every `fetch` to it fails
 * with "fetch failed", cause "bad port" (Chrome's pages get ERR_UNSAFE_PORT). Imported by `helpers.ts`, so every test
 * process that uses it has it: `net.Server`'s listen, asked for any port, lets go of a refused one at once, without a
 * `close` or `listening` for the server's own listeners, and takes another; its callback and `listening` come once, for
 * the port it keeps. A port named outright, a path, or a handle listens as asked.
 */
import { Server } from "node:net";

/** The ports the Fetch standard blocks (undici's `badPorts`, and Chrome's unsafe ports). */
export const BAD_PORTS: ReadonlySet<number> = new Set([
    1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111,
    113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548,
    554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
    6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** How many refused ports in a row a listen lets go of before it keeps one (and fetch says so). */
const TRIES = 20;

/** Which ports to let go of: `BAD_PORTS`; a test of this module refuses others to see it work. */
let refused: (port: number) => boolean = (port) => BAD_PORTS.has(port);

/** For this module's own test: refuse the ports `refuse` says too; `undefined` puts the Fetch standard's list back. */
export function refusePortsForTest(refuse: ((port: number) => boolean) | undefined): void {
    refused = refuse === undefined ? (port) => BAD_PORTS.has(port) : (port) => BAD_PORTS.has(port) || refuse(port);
}

/** Whether `listen`'s arguments ask for any port the system gives: `listen()`, `listen(0, …)`, `listen({ port: 0 })`. */
function anyPort(args: unknown[]): boolean {
    const [first] = args;

    if (first === undefined || first === null || typeof first === "function") {
        return true;
    }

    if (typeof first === "number" || (typeof first === "string" && /^\d+$/.test(first))) {
        return Number(first) === 0;
    }

    if (typeof first === "object") {
        const options = first as { port?: unknown; path?: unknown; fd?: unknown; handle?: unknown; _handle?: unknown };

        return options.path === undefined && options.fd === undefined && options.handle === undefined && options._handle === undefined && (options.port === undefined || Number(options.port) === 0);
    }

    return false;
}

type Handled = Server & { _handle: { close(): void } | null };

const listen = Server.prototype.listen;

Server.prototype.listen = function (this: Handled, ...given: unknown[]): Server {
    if (!anyPort(given)) {
        return (listen as (...args: unknown[]) => Server).apply(this, given);
    }

    const args = [...given];
    // Its callback comes once, for the port it keeps: Node would add it again with each listen.
    const callback = typeof args.at(-1) === "function" ? (args.pop() as () => void) : undefined;
    const server = this;
    const own = Object.hasOwn(server, "emit");
    const emit = server.emit;
    let tries = 0;
    const restore = () => {
        if (own) {
            server.emit = emit;
        } else {
            delete (server as { emit?: unknown }).emit;
        }
    };

    server.emit = function (event: string | symbol, ...rest: unknown[]): boolean {
        if (event === "listening") {
            const address = server.address();

            if (typeof address === "object" && address !== null && refused(address.port) && tries < TRIES) {
                tries++;
                // Let go of it quietly: the server's own listeners hear of the port it keeps only.
                server._handle?.close();
                server._handle = null;
                (listen as (...args: unknown[]) => Server).apply(server, args);

                return true;
            }
        }

        if (event === "listening" || event === "error") {
            restore();
        }

        const heard = emit.call(server, event, ...rest);

        if (event === "listening") {
            callback?.call(server);
        }

        return heard;
    };

    return (listen as (...args: unknown[]) => Server).apply(server, args);
} as unknown as typeof Server.prototype.listen;
