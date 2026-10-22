/**
 * Ports of a machine opened on this phone (DESIGN.md section 4): a dev server on the machine (`localhost:5173` there)
 * shows in the phone's browser at `http://127.0.0.1:<port>`, through `ssh -N -L` with the machine's key and host key
 * (pi-env's `sshArguments`, its `ClearAllForwardings` taken out, as forwarding is the point). Owner only, as the
 * machine is. A forward lasts until it is closed, its ssh ends, or the server stops.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { sshArguments } from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";
import type { Machines } from "./machines.ts";

export type Forward = {
    id: string;
    machineId: string;
    machine: string;
    /** The port on the machine, and where it shows here. */
    remotePort: number;
    localPort: number;
    url: string;
    startedAt: number;
};

/** How long ssh may take to log in and listen. */
const START_MS = 20_000;

/** A port free here now, for ssh to listen on. */
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();

        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as { port: number };

            server.close(() => resolve(port));
        });
    });
}

/**
 * ssh's arguments for a forward, from pi-env's (`sshArguments`): its `-o ClearAllForwardings=yes` taken out when it is
 * there (forwarding is the point; PP-107: only then, so the host after `--` stays), then `-N` and the forward. The
 * machine's end is `localhost`, which reaches a dev server on `::1` as well as `127.0.0.1` (PP-105); this end listens on
 * 127.0.0.1 alone.
 */
export function forwardArguments(args: readonly string[], localPort: number, remotePort: number): string[] {
    const out = [...args];
    const clear = out.indexOf("ClearAllForwardings=yes");

    if (clear > 0 && out[clear - 1] === "-o") {
        out.splice(clear - 1, 2);
    }

    const end = out.indexOf("--");

    if (end === -1) {
        throw new Error("pi-env's ssh arguments have no -- before the host");
    }

    out.splice(end, 0, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:localhost:${remotePort}`);

    return out;
}

/** Whether something listens on `port` here. */
function listening(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: "127.0.0.1", port });

        socket.once("connect", () => {
            socket.destroy();
            resolve(true);
        });
        socket.once("error", () => resolve(false));
    });
}

/** What the owner's tabs hear: the list changed, and, when a forward's ssh ended by itself, which one and why. */
export type ForwardsChanged = (ended?: { forward: Forward; reason: string }) => void;

export class Forwards {
    readonly #machines: Machines;
    readonly #open = new Map<string, { forward: Forward; ssh: ChildProcess }>();
    readonly #changed: ForwardsChanged;

    constructor(machines: Machines, changed: ForwardsChanged = () => {}) {
        this.#machines = machines;
        this.#changed = changed;
    }

    list(): Forward[] {
        return [...this.#open.values()].map((each) => each.forward);
    }

    /** Port `remotePort` of a machine, here: the one open already, or a new forward once ssh listens. */
    async open(machineId: string, remotePort: unknown): Promise<Forward> {
        if (typeof remotePort !== "number" || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
            throw new HttpError(400, "The port must be a whole number from 1 to 65535.");
        }

        const machine = this.#machines.ready(machineId);
        const already = this.list().find((each) => each.machineId === machineId && each.remotePort === remotePort);

        if (already !== undefined) {
            return already;
        }

        const localPort = await freePort();
        const args = forwardArguments(sshArguments(this.#machines.target(machine)), localPort, remotePort);
        const ssh = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
        let said = "";
        let ended = false;
        // Ended by itself (not closed here): the owner hears why, and their tabs get the list again (PP-108).
        const end = (reason: string) => {
            ended = true;

            for (const [id, each] of this.#open) {
                if (each.ssh === ssh) {
                    this.#open.delete(id);
                    this.#changed({ forward: each.forward, reason });
                }
            }
        };

        ssh.stderr!.on("data", (chunk: Buffer) => {
            said = (said + chunk.toString()).slice(-2000);
        });
        ssh.once("exit", (code, signal) => end(said.trim().split("\n").at(-1) || (signal === null ? `ssh ended (exit ${code})` : `ssh ended (${signal})`)));
        // ssh that cannot start (missing, not runnable) is an error, not a crash of the server (PP-106).
        ssh.once("error", (error) => {
            said = `ssh could not start: ${error.message}`;
            end(said);
        });

        const until = Date.now() + START_MS;

        while (!ended && !(await listening(localPort))) {
            if (Date.now() > until) {
                ssh.kill();

                throw new HttpError(504, `ssh to ${machine.name} did not open the port in ${START_MS / 1000} s.`);
            }

            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        if (ended) {
            throw new HttpError(502, `Could not open port ${remotePort} of ${machine.name}: ${said.trim() || "ssh ended"}`);
        }

        const forward: Forward = {
            id: crypto.randomUUID(),
            machineId,
            machine: machine.name,
            remotePort,
            localPort,
            url: `http://127.0.0.1:${localPort}/`,
            startedAt: Date.now(),
        };

        this.#open.set(forward.id, { forward, ssh });
        this.#changed();

        return forward;
    }

    close(id: string): void {
        const open = this.#open.get(id);

        if (open === undefined) {
            throw new HttpError(404, "That port is not open.");
        }

        this.#open.delete(id);
        open.ssh.kill();
        this.#changed();
    }

    closeAll(): void {
        for (const { ssh } of this.#open.values()) {
            ssh.kill();
        }

        this.#open.clear();
    }
}
