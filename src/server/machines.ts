/**
 * Machines (DESIGN.md section 4): other computers a session's tools can run on, over ssh with one of the app's SSH
 * keys, through pi-env's daemon. `machines.json` in the data folder holds them; host keys the owner accepted are in the
 * app's own known-hosts file under one alias per machine, so a changed key is refused, never accepted silently.
 *
 * Nothing runs on a machine until the owner approves it: `scan` shows the host's fingerprint, `accept` trusts it, and
 * `connect` (the owner's tap on "Install and connect") deploys the daemon (verified by its SHA-256 before every start)
 * and starts it once to report the system. A session on a machine not yet connected is refused with a message that
 * says so, so the agent can never trigger a deployment.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    acceptHostKey,
    connectSsh,
    detectPlatform,
    forgetHostKey,
    HostKeyChangedError,
    HostKeyUnknownError,
    type RemotePlatform,
    scanHostKey,
    SshError,
    type SshTarget,
} from "@earendil-works/pi-env";
import { HttpError } from "./errors.ts";
import type { SshKeys } from "./ssh-keys.ts";

export type Machine = {
    id: string;
    name: string;
    host: string;
    user: string;
    port?: number;
    /** One of the app's SSH keys (`ssh-keys.ts`). */
    keyId: string;
    createdAt: number;
    /** The host key fingerprint the owner accepted; undefined until then. */
    hostKey?: string;
    /** The remote system, once connected; undefined until the owner connected the machine. */
    remote?: Pick<RemotePlatform, "platform" | "arch" | "home">;
    /** The daemon version last seen. */
    daemon?: string;
    connectedAt?: number;
};

const FILE = "machines.json";
const MAX_NAME = 60;
/** The daemon's folder on the machine, as pi-env puts it (its README says `~/.pi-env`; the code says this). */
export const DAEMON_DIR = "~/.pi/mobile/tools";

export class Machines {
    readonly #file: string;
    readonly #keys: SshKeys;
    /** The app's own known-hosts file. */
    readonly knownHostsFile: string;
    #machines: Machine[];

    constructor(dataDir: string, keys: SshKeys, home = process.env.HOME || homedir()) {
        this.#file = join(dataDir, FILE);
        this.#keys = keys;
        this.knownHostsFile = join(home, ".ssh", "pi-phone_known_hosts");
        this.#machines = existsSync(this.#file)
            ? (JSON.parse(readFileSync(this.#file, "utf8")) as { machines: Machine[] }).machines
            : [];
    }

    #save(): void {
        writeFileSync(this.#file, `${JSON.stringify({ machines: this.#machines }, null, 2)}\n`, { mode: 0o600 });
    }

    list(): Machine[] {
        return this.#machines.map((machine) => ({ ...machine }));
    }

    get(id: string): Machine {
        const machine = this.#machines.find((each) => each.id === id);

        if (machine === undefined) {
            throw new HttpError(404, "There is no such machine.");
        }

        return machine;
    }

    /** Which machines use a key: for the key's row, and to refuse removing a key in use. */
    usingKey(keyId: string): Machine[] {
        return this.#machines.filter((machine) => machine.keyId === keyId);
    }

    /** How `ssh` reaches a machine: its key only, the app's known hosts, one alias per machine. */
    target(machine: Machine): SshTarget {
        mkdirSync(join(this.knownHostsFile, ".."), { recursive: true, mode: 0o700 });

        return {
            host: machine.host,
            user: machine.user,
            ...(machine.port === undefined ? {} : { port: machine.port }),
            identityFile: this.#keys.privateKeyPath(machine.keyId),
            knownHostsFile: this.knownHostsFile,
            hostKeyAlias: `pi-phone-${machine.id}`,
        };
    }

    /** The machine a session may run on: connected, else an error that says what to do. */
    ready(id: string): Machine {
        const machine = this.get(id);

        if (machine.remote === undefined) {
            throw new HttpError(
                409,
                `${machine.name} is not set up: open Settings > Machines and connect it first.`,
            );
        }

        return machine;
    }

    add(body: { name?: unknown; address?: unknown; keyId?: unknown }): Machine {
        const name = checkName(body.name);
        const { user, host, port } = parseAddress(body.address);

        if (typeof body.keyId !== "string") {
            throw new HttpError(400, "Choose the SSH key for this machine.");
        }

        this.#keys.privateKeyPath(body.keyId);
        const machine: Machine = {
            id: randomUUID(),
            name,
            host,
            user,
            ...(port === undefined ? {} : { port }),
            keyId: body.keyId,
            createdAt: Date.now(),
        };

        this.#machines.push(machine);
        this.#save();

        return { ...machine };
    }

    /** Change the name, address, or key. A new address or key forgets the host key and the connection: scan again. */
    async edit(id: string, body: { name?: unknown; address?: unknown; keyId?: unknown }): Promise<Machine> {
        const machine = this.get(id);

        if (body.name !== undefined) {
            machine.name = checkName(body.name);
        }

        if (body.address !== undefined) {
            const { user, host, port } = parseAddress(body.address);

            if (user !== machine.user || host !== machine.host || port !== machine.port) {
                await forgetHostKey(this.target(machine));
                delete machine.hostKey;
                delete machine.remote;
                delete machine.daemon;
                delete machine.connectedAt;
                machine.user = user;
                machine.host = host;

                if (port === undefined) {
                    delete machine.port;
                } else {
                    machine.port = port;
                }
            }
        }

        if (body.keyId !== undefined) {
            if (typeof body.keyId !== "string") {
                throw new HttpError(400, "Choose the SSH key for this machine.");
            }

            this.#keys.privateKeyPath(body.keyId);
            machine.keyId = body.keyId;
        }

        this.#save();

        return { ...machine };
    }

    /** Forgets the machine and its host key. The daemon on the machine stays unless `remove` on it was done first. */
    async remove(id: string): Promise<void> {
        const machine = this.get(id);

        await forgetHostKey(this.target(machine));
        this.#machines = this.#machines.filter((each) => each.id !== id);
        this.#save();
    }

    /**
     * The host's key as it presents it now, for the owner to compare and accept: the known-hosts lines, and each key's
     * fingerprint as `SHA256:... (ED25519)`, as `ssh-keygen -l` on the machine shows it.
     */
    async scan(id: string): Promise<{ fingerprints: string[]; lines: string[] }> {
        const machine = this.get(id);

        try {
            const { lines, fingerprints } = await scanHostKey(this.target(machine));

            return {
                lines,
                fingerprints: fingerprints.map((line) => {
                    // `256 SHA256:abc... pi-phone-<id> (ED25519)`
                    const match = /^\d+\s+(\S+)\s.*\((\w+)\)\s*$/.exec(line.trim());

                    return match === null ? line.trim() : `${match[1]} (${match[2]})`;
                }),
            };
        } catch (error) {
            throw sshFailure(machine, error);
        }
    }

    /** Trust the key `scan` showed. A key that differs from one accepted before is refused: the owner forgets it first. */
    async accept(id: string, lines: unknown, fingerprint: unknown): Promise<Machine> {
        const machine = this.get(id);

        if (!Array.isArray(lines) || !lines.every((line) => typeof line === "string") || typeof fingerprint !== "string") {
            throw new HttpError(400, "Scan the machine first.");
        }

        try {
            await acceptHostKey(this.target(machine), lines as string[]);
        } catch (error) {
            if (error instanceof HostKeyChangedError) {
                throw new HttpError(
                    409,
                    `${machine.name}'s host key changed since you accepted it. If you know why (the machine was reinstalled), forget the old key and scan again; otherwise do not connect.`,
                );
            }

            throw error;
        }

        machine.hostKey = fingerprint;
        this.#save();

        return { ...machine };
    }

    /** Stop trusting the machine's host key, after the owner confirmed it changed for a known reason. */
    async forget(id: string): Promise<void> {
        const machine = this.get(id);

        await forgetHostKey(this.target(machine));
        delete machine.hostKey;
        delete machine.remote;
        delete machine.daemon;
        delete machine.connectedAt;
        this.#save();
    }

    /**
     * The owner's approval: deploy the daemon (or update it) and start it once, which reports the system. Needs the
     * host key accepted.
     */
    async connect(id: string): Promise<Machine> {
        const machine = this.get(id);

        if (machine.hostKey === undefined) {
            throw new HttpError(409, "Accept the machine's host key first.");
        }

        try {
            const { connection, remote } = await connectSsh(this.target(machine));

            try {
                const info = await connection.info();

                machine.daemon = info.version;
            } finally {
                connection.close();
            }

            machine.remote = { platform: remote.platform, arch: remote.arch, home: remote.home };
            machine.connectedAt = Date.now();
            this.#save();

            return { ...machine, ...(remote.warnings.length === 0 ? {} : { warnings: remote.warnings }) } as Machine;
        } catch (error) {
            throw sshFailure(machine, error);
        }
    }

    /** What the machine runs, without deploying anything: for the sheet's Test on a connected machine. */
    async detect(id: string): Promise<RemotePlatform> {
        const machine = this.get(id);

        try {
            return await detectPlatform(this.target(machine));
        } catch (error) {
            throw sshFailure(machine, error);
        }
    }
}

function checkName(name: unknown): string {
    if (typeof name !== "string" || name.trim() === "") {
        throw new HttpError(400, "Name the machine.");
    }

    if (name.trim().length > MAX_NAME) {
        throw new HttpError(400, `A machine's name is at most ${MAX_NAME} characters.`);
    }

    return name.trim();
}

/** `user@host`, `user@host:22`, `user@[2001:db8::1]:22`. */
export function parseAddress(address: unknown): { user: string; host: string; port: number | undefined } {
    if (typeof address !== "string") {
        throw new HttpError(400, "Give the address as user@host or user@host:port.");
    }

    const match = /^([\w.@-]+?)@(\[[0-9a-fA-F:]+\]|[\w.-]+)(?::(\d{1,5}))?$/.exec(address.trim());

    if (match === null) {
        throw new HttpError(400, "Give the address as user@host or user@host:port.");
    }

    const port = match[3] === undefined ? undefined : Number(match[3]);

    if (port !== undefined && (port < 1 || port > 65535)) {
        throw new HttpError(400, "The port is a number from 1 to 65535.");
    }

    return { user: match[1]!, host: match[2]!.replace(/^\[|\]$/g, ""), port };
}

/** An ssh failure in the owner's words: what the machine said, with the likely cause first. */
function sshFailure(machine: Machine, error: unknown): Error {
    if (error instanceof HttpError) {
        return error;
    }

    if (error instanceof HostKeyUnknownError) {
        return new HttpError(409, `${machine.name}'s host key is not accepted yet: scan and accept it first.`);
    }

    if (error instanceof HostKeyChangedError) {
        return new HttpError(
            409,
            `${machine.name}'s host key changed since you accepted it. If the machine was reinstalled, forget the old key and scan again; otherwise do not connect.`,
        );
    }

    if (error instanceof SshError) {
        const said = error.stderr.trim().split("\n").at(-1) ?? "";
        const why = /Permission denied/i.test(said)
            ? "the machine refused the key: is its public key in ~/.ssh/authorized_keys there?"
            : /Connection refused|Could not resolve|No route|timed out|Network is unreachable/i.test(said)
              ? "the machine is not reachable from the phone"
              : said;

        return new HttpError(502, `Could not reach ${machine.name} (${machine.user}@${machine.host}): ${why}`);
    }

    return error instanceof Error ? error : new Error(String(error));
}
