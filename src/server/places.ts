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
import { machinePaths } from "./machine-paths.ts";
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
/** How long a machine has to answer before its folder is refused (`checkDirectory`). */
const CHECK_MS = 10_000;

export class Places {
    readonly #machines: Machines;
    readonly #local = new Map<string, NodeExecutionEnv>();
    readonly #connections = new Map<string, Connection>();
    readonly #remote = new Map<string, RemoteExecutionEnv>();
    /** The phone's own pi-env daemon, for terminals here; started on the first one. */
    #localDaemon: Connection | undefined;
    /** The PATH of every command run on the phone, read as each one starts: the app's tools (pi-ssh, officecli) first. */
    readonly #path: () => string;

    constructor(machines: Machines, path: () => string) {
        this.#machines = machines;
        this.#path = path;
    }

    /** The execution environment of a cwd. A machine's needs the machine connected (`Machines.ready`). */
    env(cwd: string): ExecutionEnv {
        const place = parsePlace(cwd);

        if (place.machineId === undefined) {
            let env = this.#local.get(place.path);

            if (env === undefined) {
                const path = this.#path;

                // Read as each command starts (the environment spreads it then), so officecli counts once installed: the
                // bash tool, secret_save, goals' checks and schedules' commands all find the same tools (PP-30).
                env = new NodeExecutionEnv({
                    cwd: place.path,
                    shellEnv: {
                        get PATH() {
                            return path();
                        },
                    },
                });
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

        if (place.machineId !== undefined && this.#machines.ready(place.machineId).remote!.platform === "windows") {
            return this.#windowsTerminal(this.#machines.ready(place.machineId), place.path, options);
        }

        const connection =
            place.machineId === undefined
                ? (this.#localDaemon ??= new Connection({ command: [localDaemon()] }))
                : this.connection(this.#machines.ready(place.machineId));

        return openTerminal(connection, { cwd: place.path, env: { TERM: "xterm-256color" }, ...options });
    }

    /**
     * A Windows machine's terminal. pi-env's Windows daemon has no pseudo-terminals ("Terminals are not supported on this
     * system yet"), but Windows' OpenSSH Server has (ConPTY): so a pseudo-terminal here, on the phone's own daemon, runs the
     * app's `ssh -tt` to the machine (its config: the agent's key, its known hosts), which starts Git Bash in the folder.
     * The command is PowerShell's `-EncodedCommand`: no quotes for cmd.exe to mangle (it dropped those around
     * `C:\Program Files`), and it runs from either shell sshd may use. `CHERE_INVOKING` keeps Git Bash's login profile
     * from going to the home folder. Checked against a Windows 11 machine on 2026-10-19.
     */
    #windowsTerminal(
        machine: Machine,
        path: string,
        options: { cols: number; rows: number; onData: (bytes: Uint8Array) => void },
    ): Promise<RemoteTerminal> {
        const alias = this.#machines.sshHosts().find((each) => each.machine.id === machine.id)?.alias;

        if (alias === undefined) {
            throw new HttpError(409, `Accept ${machine.name}'s host key first.`);
        }

        const folder = path.replaceAll("/", "\\").replaceAll("'", "''");
        const script = `$env:CHERE_INVOKING = '1'; Set-Location -LiteralPath '${folder}'; & "$env:ProgramFiles\\Git\\bin\\bash.exe" --login -i; exit $LASTEXITCODE`;
        const command = `powershell -NoLogo -NoProfile -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
        const connection = (this.#localDaemon ??= new Connection({ command: [localDaemon()] }));

        return openTerminal(connection, {
            cwd: process.env.HOME ?? "/",
            argv: ["ssh", "-F", this.#machines.configFile, "-tt", alias, command],
            env: { TERM: "xterm-256color" },
            ...options,
        });
    }

    /**
     * Checks that the place is a folder there (through links, as a folder here is), and answers the cwd in canonical
     * form. The machine is reached first, so one that does not answer is refused in seconds (PP-91): the folder picker
     * and a new session both come through here.
     */
    async checkDirectory(cwd: string, context: Context, reachMs = CHECK_MS): Promise<string> {
        const place = parsePlace(cwd);

        if (place.machineId === undefined) {
            throw new Error("checkDirectory is for machines; local folders go through Workspace.checkDirectory");
        }

        const machine = this.#machines.ready(place.machineId);
        const reached = await this.reach(machine.id, reachMs);

        if (!reached.ok) {
            throw new HttpError(502, `${machine.name} does not answer: ${sshProblem(reached.error)}`);
        }

        const env = this.env(cwd);
        const absolute = await env.absolutePath(place.path, context);

        if (!absolute.ok) {
            throw new HttpError(400, `${place.path} on ${machine.name}: ${absolute.error.message}`);
        }

        // A file is not a folder to work in (PP-90); a link to a folder is.
        const real = await env.canonicalPath(absolute.value, context);
        const found = real.ok ? await env.fileInfo(real.value, context) : real;

        if (!found.ok) {
            if (found.error.code === "not_found") {
                throw new HttpError(404, `There is no folder ${absolute.value} on ${machine.name}.`);
            }

            throw new HttpError(
                found.error.code === "unknown" ? 502 : 400,
                `Could not open ${absolute.value} on ${machine.name}: ${found.error.message}`,
            );
        }

        if (found.value.kind !== "directory") {
            throw new HttpError(400, `${absolute.value} on ${machine.name} is a file, not a folder.`);
        }

        const paths = machinePaths(machine.remote);

        return formatPlace({ machineId: machine.id, path: paths.onDrive(paths.normal(absolute.value), machine.remote!.home) });
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
