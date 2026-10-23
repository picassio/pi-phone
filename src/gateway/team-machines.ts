/**
 * The team's machines (PP-82, wiki: pi-phone-team-machines): a computer added once for the team, whose sessions people's
 * roles let them run. Each has a key of its own, made and kept here (`<data>/team-machines/<id>.key`, mode 600): people's
 * pi-phones never get it, only its public half. They reach a machine through the gateway (S2): its connection is relayed
 * to the machine's own address, and the gateway signs the machine's sign-in for them, checking their role each time.
 *
 * Scanning, accepting the host key and installing pi-env's daemon are done from the pi-phone of someone with
 * machines.manage, through those relays, as for a machine of their own; what it learns (the host key, the system) is
 * kept here for everyone.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject, randomUUID, sign as signWith } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseAddress } from "../server/machines.ts";
import { HttpError } from "../server/errors.ts";

export type TeamMachine = {
    id: string;
    name: string;
    host: string;
    user: string;
    port?: number;
    createdAt: number;
    createdBy: string;
    /** The host key fingerprint someone with machines.manage accepted, and its known-hosts lines; none until then. */
    hostKey?: string;
    knownHosts?: string[];
    /** The machine's system, once installed and connected. */
    remote?: { platform: string; arch: string; home: string };
    daemon?: string;
    connectedAt?: number;
};

/** Where the team machines are kept: the gateway's store, as plain rows (no keys). */
export interface TeamMachineRows {
    teamMachines(): TeamMachine[];
    saveTeamMachine(machine: TeamMachine): void;
    deleteTeamMachine(id: string): void;
}

const MAX_NAME = 60;
/** A team machine's id: what its ssh alias (`pi-phone-team-<id>`) and its key file are named by. */
export const TEAM_MACHINE_ID = /^[a-z0-9]{12}$/;

/** SSH's wire format: a string is its length (4 bytes) and its bytes. */
export function sshString(value: Buffer | string): Buffer {
    const bytes = typeof value === "string" ? Buffer.from(value) : value;
    const length = Buffer.alloc(4);

    length.writeUInt32BE(bytes.length);

    return Buffer.concat([length, bytes]);
}

/** An ed25519 key's public half as SSH writes it (the blob: `ssh-ed25519` and the 32 bytes). */
export function ed25519Blob(key: KeyObject): Buffer {
    const raw = Buffer.from(String(key.export({ format: "jwk" }).x), "base64url");

    return Buffer.concat([sshString("ssh-ed25519"), sshString(raw)]);
}

/**
 * Whether `data` is what an SSH client signs to sign in with a public key, for `user` and the key `blob`, and nothing
 * else (RFC 4252 §7): the session id, SSH_MSG_USERAUTH_REQUEST (50), the user, "ssh-connection", the method, TRUE,
 * "ssh-ed25519", the key. The method is "publickey", or OpenSSH's "publickey-hostbound-v00@openssh.com" (8.9 and
 * later), which adds the server's host key: then it must be one of `hostKeys` (the machine's accepted ones), so the
 * signature signs in to that machine only. The gateway signs only that: a pi-phone can't have it sign anything else.
 */
export function isSignIn(data: Buffer, user: string, blob: Buffer, hostKeys: readonly Buffer[] = []): boolean {
    let at = 0;
    const field = (): Buffer => {
        if (at + 4 > data.length) {
            throw new Error("short");
        }

        const length = data.readUInt32BE(at);

        at += 4;

        if (at + length > data.length) {
            throw new Error("short");
        }

        at += length;

        return data.subarray(at - length, at);
    };
    const byte = () => (at < data.length ? data[at++] : -1);

    try {
        const session = field();

        if (!(session.length > 0 && byte() === 50 && field().toString() === user && field().toString() === "ssh-connection")) {
            return false;
        }

        const method = field().toString();

        if (!((method === "publickey" || method === "publickey-hostbound-v00@openssh.com") && byte() === 1 && field().toString() === "ssh-ed25519" && field().equals(blob))) {
            return false;
        }

        if (method === "publickey") {
            return at === data.length;
        }

        const hostKey = field();

        return at === data.length && hostKeys.some((each) => each.equals(hostKey));
    } catch {
        return false;
    }
}

/** The ssh alias (and host key alias) of a team machine, the same in every pi-phone. */
export const teamAlias = (id: string) => `pi-phone-team-${id}`;

function checkName(name: unknown): string {
    const label = typeof name === "string" ? name.trim() : "";

    if (label === "" || label.length > MAX_NAME || /[\r\n]/.test(label)) {
        throw new HttpError(400, `A name is 1 to ${MAX_NAME} characters, on one line.`);
    }

    return label;
}

export class TeamMachines {
    readonly #rows: TeamMachineRows;
    readonly #dir: string;
    readonly #now: () => number;

    constructor(rows: TeamMachineRows, dataDir: string, now: () => number = Date.now) {
        this.#rows = rows;
        this.#dir = join(dataDir, "team-machines");
        this.#now = now;
    }

    list(): TeamMachine[] {
        return this.#rows.teamMachines();
    }

    get(id: string): TeamMachine | undefined {
        return this.list().find((machine) => machine.id === id);
    }

    #need(id: string): TeamMachine {
        const machine = this.get(id);

        if (machine === undefined) {
            throw new HttpError(404, "No such team machine.");
        }

        return machine;
    }

    #keyFile(id: string): string {
        if (!TEAM_MACHINE_ID.test(id)) {
            throw new HttpError(400, "No such team machine.");
        }

        return join(this.#dir, `${id}.key`);
    }

    /** A new team machine, and its key: made here, kept here. Answers it with the key's public half to install. */
    add(name: unknown, address: unknown, by: string): { machine: TeamMachine; publicKey: string } {
        const label = checkName(name);
        let parsed;

        try {
            parsed = parseAddress(address);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        if (this.list().some((each) => each.name.toLowerCase() === label.toLowerCase())) {
            throw new HttpError(409, `There is a team machine named ${label} already.`);
        }

        const id = randomUUID().replace(/-/g, "").slice(0, 12);
        const { privateKey } = generateKeyPairSync("ed25519");

        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        writeFileSync(this.#keyFile(id), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });

        const machine: TeamMachine = { id, name: label, host: parsed.host, user: parsed.user, ...(parsed.port === undefined ? {} : { port: parsed.port }), createdAt: this.#now(), createdBy: by };

        this.#rows.saveTeamMachine(machine);

        return { machine, publicKey: this.publicKey(id) };
    }

    rename(id: string, name: unknown): TeamMachine {
        const machine = { ...this.#need(id), name: checkName(name) };

        this.#rows.saveTeamMachine(machine);

        return machine;
    }

    /** Gone, with its key (and from every role that listed it, by the store). */
    remove(id: string): void {
        this.#need(id);
        this.#rows.deleteTeamMachine(id);
        rmSync(this.#keyFile(id), { force: true });
    }

    /** The host key someone with machines.manage accepted, as known-hosts lines (each with no options), and its fingerprint. */
    accept(id: string, lines: unknown, fingerprint: unknown): TeamMachine {
        const given = Array.isArray(lines) ? lines.map(String) : [];
        const print = typeof fingerprint === "string" ? fingerprint.trim() : "";

        // Lines for this machine's own alias: what every pi-phone checks its host key under.
        if (given.length === 0 || given.length > 10 || given.some((line) => !new RegExp(`^${teamAlias(id)} (ssh-|ecdsa-|sk-)\\S+ [A-Za-z0-9+/=]+$`).test(line))) {
            throw new HttpError(400, "Give the host key lines the scan found.");
        }

        if (!/^SHA256:[A-Za-z0-9+/=]{20,}$/.test(print)) {
            throw new HttpError(400, "Give the fingerprint that was accepted.");
        }

        const machine = { ...this.#need(id), hostKey: print, knownHosts: given };

        this.#rows.saveTeamMachine(machine);

        return machine;
    }

    /** What installing and connecting found: the machine's system and pi-env's daemon. */
    connected(id: string, remote: unknown, daemon: unknown): TeamMachine {
        const found = (typeof remote === "object" && remote !== null ? remote : {}) as Record<string, unknown>;

        if (typeof found.platform !== "string" || typeof found.arch !== "string" || typeof found.home !== "string") {
            throw new HttpError(400, "Give the system the connection found.");
        }

        const machine: TeamMachine = {
            ...this.#need(id),
            remote: { platform: found.platform, arch: found.arch, home: found.home },
            ...(typeof daemon === "string" && daemon !== "" ? { daemon } : {}),
            connectedAt: this.#now(),
        };

        this.#rows.saveTeamMachine(machine);

        return machine;
    }

    #privateKey(id: string): KeyObject {
        const file = this.#keyFile(id);

        if (!existsSync(file)) {
            throw new HttpError(500, "This team machine's key is missing on the team server.");
        }

        return createPrivateKey(readFileSync(file));
    }

    /** The machine's key, public half, as `authorized_keys` takes it. */
    publicKey(id: string): string {
        const machine = this.#need(id);

        return `ssh-ed25519 ${ed25519Blob(this.#privateKey(id)).toString("base64")} pi-phone team ${machine.name.replace(/\s+/g, "-")}`;
    }

    /** Its public half as the SSH blob (what an agent lists, and a sign-in names). */
    publicBlob(id: string): Buffer {
        return ed25519Blob(this.#privateKey(id));
    }

    /** The signature of a sign-in to the machine (`isSignIn`), as an agent answers it; anything else is refused. */
    signIn(id: string, data: Buffer): Buffer {
        const machine = this.#need(id);

        // The machine's accepted host keys, as blobs: a host-bound sign-in must name one of them.
        const hostKeys = (machine.knownHosts ?? []).map((line) => Buffer.from(line.split(" ")[2] ?? "", "base64"));

        if (!isSignIn(data, machine.user, this.publicBlob(id), hostKeys)) {
            throw new HttpError(400, "The team server signs only a sign-in to the machine with its key.");
        }

        return this.signRaw(id, data);
    }

    /** An ed25519 signature of `data` with the machine's key, as SSH carries it. */
    signRaw(id: string, data: Buffer): Buffer {
        return Buffer.concat([sshString("ssh-ed25519"), sshString(signWith(null, data, this.#privateKey(id)))]);
    }
}
