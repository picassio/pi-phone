/**
 * Where a session works (DESIGN.md section 4): a folder on this phone, or a folder on a machine (`machines.ts`). pi-pocket
 * carries a session's working folder as one `cwd` string through the agent document, the session list, and every
 * command; a machine's folder rides in it as `machine:<machine id>:<path on the machine>`. `parsePlace` tells the two
 * apart; `formatPlace` writes one. Everything that touches files goes through the place's execution environment:
 * `NodeExecutionEnv` here, pi-env's `RemoteExecutionEnv` on a machine, one connection per machine, started on its first
 * use and closed with the app.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { type Connection, RemoteExecutionEnv, sshConnection } from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";
import type { Machine, Machines } from "./machines.ts";

const PREFIX = "machine:";

export type Place = { machineId: string; path: string } | { machineId?: undefined; path: string };

export function parsePlace(cwd: string): Place {
    if (!cwd.startsWith(PREFIX)) {
        return { path: cwd };
    }

    const rest = cwd.slice(PREFIX.length);
    const colon = rest.indexOf(":");

    if (colon <= 0 || colon === rest.length - 1) {
        throw new HttpError(400, `Not a place: ${cwd}`);
    }

    return { machineId: rest.slice(0, colon), path: rest.slice(colon + 1) };
}

export function formatPlace(place: Place): string {
    return place.machineId === undefined ? place.path : `${PREFIX}${place.machineId}:${place.path}`;
}

/** Whether a session's cwd is on a machine. */
export const isRemote = (cwd: string): boolean => cwd.startsWith(PREFIX);

/** The cwd's path part, for display: the folder on the phone, or on the machine. */
export const pathOf = (cwd: string): string => parsePlace(cwd).path;

export class Places {
    readonly #machines: Machines;
    readonly #local = new Map<string, NodeExecutionEnv>();
    readonly #connections = new Map<string, Connection>();
    readonly #remote = new Map<string, RemoteExecutionEnv>();

    constructor(machines: Machines) {
        this.#machines = machines;
    }

    /** The execution environment of a cwd. A machine's needs the machine connected (`Machines.ready`). */
    env(cwd: string): ExecutionEnv {
        const place = parsePlace(cwd);

        if (place.machineId === undefined) {
            let env = this.#local.get(place.path);

            if (env === undefined) {
                env = new NodeExecutionEnv({ cwd: place.path });
                this.#local.set(place.path, env);
            }

            return env;
        }

        const machine = this.#machines.ready(place.machineId);
        let env = this.#remote.get(cwd);

        if (env === undefined) {
            env = new RemoteExecutionEnv({
                connection: this.connection(machine),
                id: `pi-env:${machine.id}`,
                cwd: place.path,
            });
            this.#remote.set(cwd, env);
        }

        return env;
    }

    /** The machine of a cwd, when it is on one. */
    machineOf(cwd: string): Machine | undefined {
        const place = parsePlace(cwd);

        return place.machineId === undefined ? undefined : this.#machines.get(place.machineId);
    }

    /**
     * One connection per machine, lazily: nothing happens until the first request, which starts the daemon over ssh
     * (deployed already by "Install and connect"; a changed binary is redeployed, verified by its hash).
     */
    connection(machine: Machine): Connection {
        let connection = this.#connections.get(machine.id);

        if (connection === undefined) {
            connection = sshConnection(this.#machines.target(machine)).connection;
            this.#connections.set(machine.id, connection);
        }

        return connection;
    }

    /** Checks that the place's folder exists there, and answers the cwd in canonical form. */
    async checkDirectory(cwd: string, context: Context): Promise<string> {
        const place = parsePlace(cwd);

        if (place.machineId === undefined) {
            throw new Error("checkDirectory is for machines; local folders go through Workspace.checkDirectory");
        }

        const machine = this.#machines.ready(place.machineId);
        const env = this.env(cwd);
        const absolute = await env.absolutePath(place.path, context);

        if (!absolute.ok) {
            throw new HttpError(400, `${place.path} on ${machine.name}: ${absolute.error.message}`);
        }

        const exists = await env.exists(absolute.value, context);

        if (!exists.ok) {
            throw new HttpError(502, `Could not reach ${machine.name}: ${exists.error.message}`);
        }

        if (!exists.value) {
            throw new HttpError(404, `There is no folder ${absolute.value} on ${machine.name}.`);
        }

        return formatPlace({ machineId: machine.id, path: absolute.value });
    }

    /** A machine was edited or removed: its connection and environments are dropped, and start afresh next time. */
    forget(machineId: string): void {
        this.#connections.get(machineId)?.close();
        this.#connections.delete(machineId);

        for (const cwd of [...this.#remote.keys()]) {
            if (parsePlace(cwd).machineId === machineId) {
                this.#remote.delete(cwd);
            }
        }
    }

    async close(context: Context): Promise<void> {
        for (const env of this.#local.values()) {
            await env.cleanup(context);
        }

        for (const connection of this.#connections.values()) {
            connection.close();
        }
    }
}
