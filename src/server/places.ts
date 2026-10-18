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
import {
    Connection,
    localDaemon,
    openTerminal,
    type RemoteTerminal,
    RemoteExecutionEnv,
    sshConnection,
} from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";
import type { Machine, Machines } from "./machines.ts";
import { sshProblem } from "./machines.ts";

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

/** A machine's answer to `Places.health`: when it was checked, and if it failed, why (and what ssh said). */
export type MachineHealth = { ok: boolean; at: number; problem?: string; said?: string };

const HEALTH_MS = 60_000;

export class Places {
    readonly #machines: Machines;
    readonly #local = new Map<string, NodeExecutionEnv>();
    readonly #connections = new Map<string, Connection>();
    readonly #remote = new Map<string, RemoteExecutionEnv>();
    /** The phone's own pi-env daemon, for terminals here; started on the first one. */
    #localDaemon: Connection | undefined;

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
     * Whether the machine answers now: its daemon's `hello`, started over ssh if it is not running, in `timeoutMs`.
     * Its connection starts again by itself after a loss, so this is also how a session gets its machine back.
     */
    async reach(machineId: string, timeoutMs = 15_000): Promise<{ ok: true } | { ok: false; error: string }> {
        const machine = this.#machines.ready(machineId);
        let timer: NodeJS.Timeout | undefined;

        try {
            await Promise.race([
                this.connection(machine).info(),
                new Promise((_resolve, reject) => {
                    timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs);
                }),
            ]);

            return { ok: true };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Whether each set-up machine answers now, checked all at once (`reach`, 10 s each), with what a failure means
     * (`sshProblem`). Kept a minute, so the Machines sheet and the folder picker do not each wait for it; `fresh`
     * checks again.
     */
    async health(fresh = false): Promise<Record<string, MachineHealth>> {
        if (!fresh && this.#health !== undefined && Date.now() - this.#health.at < HEALTH_MS) {
            return this.#health.machines;
        }

        const machines = this.#machines.list().filter((machine) => machine.remote !== undefined);
        const checked = await Promise.all(
            machines.map(async (machine) => {
                const reached = await this.reach(machine.id, 10_000);
                const health: MachineHealth = reached.ok
                    ? { ok: true, at: Date.now() }
                    : { ok: false, at: Date.now(), problem: sshProblem(reached.error), said: reached.error.slice(0, 300) };

                return [machine.id, health] as const;
            }),
        );

        this.#health = { at: Date.now(), machines: Object.fromEntries(checked) };

        return this.#health.machines;
    }

    #health: { at: number; machines: Record<string, MachineHealth> } | undefined;

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

    /**
     * A shell in a pseudo-terminal at a place (`terminal.ts`): the user's login shell, `SHELL` of the daemon's
     * environment (on the phone, PiService sets it to the bundled bash), in the place's folder, as `xterm-256color`.
     */
    terminal(
        cwd: string,
        options: { cols: number; rows: number; onData: (bytes: Uint8Array) => void },
    ): Promise<RemoteTerminal> {
        const place = parsePlace(cwd);
        const connection =
            place.machineId === undefined
                ? (this.#localDaemon ??= new Connection({ command: [localDaemon()] }))
                : this.connection(this.#machines.ready(place.machineId));

        return openTerminal(connection, { cwd: place.path, env: { TERM: "xterm-256color" }, ...options });
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

        this.#localDaemon?.close();
    }
}
