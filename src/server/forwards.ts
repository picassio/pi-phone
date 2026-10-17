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

export class Forwards {
    readonly #machines: Machines;
    readonly #open = new Map<string, { forward: Forward; ssh: ChildProcess }>();

    constructor(machines: Machines) {
        this.#machines = machines;
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
        const args = sshArguments(this.#machines.target(machine));
        const clear = args.indexOf("ClearAllForwardings=yes");

        args.splice(clear - 1, 2);
        args.splice(args.indexOf("--"), 0, "-N", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`);
        const ssh = spawn("ssh", args, { stdio: ["ignore", "ignore", "pipe"] });
        let said = "";
        let ended = false;

        ssh.stderr!.on("data", (chunk: Buffer) => {
            said = (said + chunk.toString()).slice(-2000);
        });
        ssh.once("exit", () => {
            ended = true;

            for (const [id, each] of this.#open) {
                if (each.ssh === ssh) {
                    this.#open.delete(id);
                }
            }
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

        return forward;
    }

    close(id: string): void {
        const open = this.#open.get(id);

        if (open === undefined) {
            throw new HttpError(404, "That port is not open.");
        }

        this.#open.delete(id);
        open.ssh.kill();
    }

    closeAll(): void {
        for (const { ssh } of this.#open.values()) {
            ssh.kill();
        }

        this.#open.clear();
    }
}
