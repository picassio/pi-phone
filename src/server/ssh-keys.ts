/**
 * The app's SSH keys (DESIGN.md section 4): one per purpose, each used by the machines the owner assigns it to.
 *
 * Private keys live in the app's database (`pocket.sqlite`, table `pocket_ssh_keys`) and in its ssh-agent's memory
 * (`ssh-agent.ts`), never in files: the app's `ssh` signs through the agent, which gives no key out. Public keys, which
 * are not secret, are files in the app's `ssh/keys/<id>.pub`, for `ssh-keygen -l` and to choose the key (`IdentityFile`
 * with `IdentitiesOnly`). `keys.json` holds the names. Keys have no passphrase: background work (a session's tools on a
 * machine) has nobody to ask for one.
 *
 * Keys from before (files in `~/.ssh/keys/`) move in once, when the app starts: each is checked (its public key must
 * derive from it), stored, and only then its files are deleted. One that fails the check stays where it was, and says
 * why on its row.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./errors.ts";
import type { SshAgent } from "./ssh-agent.ts";

/** `ssh-keygen` with stdin closed and no askpass: one that would ask for a passphrase fails instead of waiting. */
function run(command: string, args: string[]): Promise<{ stdout: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
            env: { ...process.env, SSH_ASKPASS_REQUIRE: "never", DISPLAY: "" },
        });
        let stdout = "";
        let stderr = "";

        child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.once("error", reject);
        // "close", not "exit": exit can come before its output has all been read, which then looks empty (a CI flake:
        // "ssh-keygen -l gave an unexpected answer for <id>: ").
        child.once("close", (code) =>
            code === 0 ? resolve({ stdout }) : reject(Object.assign(new Error(`${command} failed (${code})`), { stderr })),
        );
    });
}

export type SshKey = {
    id: string;
    name: string;
    createdAt: number;
    /** `imported`: brought from elsewhere; `generated`: made here. */
    source: "generated" | "imported";
};

/** A key as the sheet shows it: with its public half and fingerprint, and a problem if it could not be loaded. */
export type SshKeyView = SshKey & {
    publicKey: string;
    /** `SHA256:...`, as `ssh-keygen -l` prints it. */
    fingerprint: string;
    type: string;
    problem?: string;
};

const KEYS_FILE = "keys.json";
const DATABASE = "pocket.sqlite";
const MAX_NAME = 60;

export class SshKeys {
    readonly #file: string;
    readonly #database: DatabaseSync;
    readonly #agent: SshAgent;
    /** Where keys were files before (`~/.ssh/keys`): moved in once. */
    readonly #legacy: string;
    /** The app's `ssh/keys`: public keys only. */
    readonly publicDir: string;
    /** The app's `ssh` folder, for work files that must not outlive a call (`ssh-keygen`'s output). */
    readonly #sshDir: string;
    #keys: SshKey[];
    /** Keys that could not be loaded, and why: shown on their rows. */
    readonly #problems = new Map<string, string>();

    constructor(dataDir: string, agent: SshAgent, sshDir: string, home = process.env.HOME || homedir()) {
        this.#file = join(dataDir, KEYS_FILE);
        this.#agent = agent;
        this.#sshDir = sshDir;
        this.publicDir = join(sshDir, "keys");
        this.#legacy = join(home, ".ssh", "keys");
        mkdirSync(this.publicDir, { recursive: true, mode: 0o700 });
        this.#keys = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as { keys: SshKey[] }).keys : [];
        this.#database = new DatabaseSync(join(dataDir, DATABASE), { timeout: 5000 });
        this.#database.exec(
            "CREATE TABLE IF NOT EXISTS pocket_ssh_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT",
        );
    }

    /**
     * Move keys that are still files into the database, then give the agent every key. Called once as the app starts;
     * a key that cannot be loaded keeps its problem for its row, and the others load all the same.
     */
    async open(): Promise<void> {
        await this.#agent.start();

        for (const key of this.#keys) {
            try {
                if (this.#privateKey(key.id) === undefined) {
                    await this.#moveIn(key.id);
                }

                await this.#agent.add(this.publicKeyPath(key.id), this.#privateKey(key.id)!);
                this.#problems.delete(key.id);
            } catch (error) {
                this.#problems.set(key.id, error instanceof Error ? error.message : String(error));
            }
        }

        // The old folder goes once nothing is left in it.
        if (existsSync(this.#legacy) && readdirSync(this.#legacy).length === 0) {
            rmdirSync(this.#legacy);
        }
    }

    /** A key's files from before, checked, stored, then deleted. */
    async #moveIn(id: string): Promise<void> {
        const file = join(this.#legacy, id);

        if (!existsSync(file)) {
            throw new Error(`Its private key is neither in the database nor at ${file}.`);
        }

        const derived = (await run("ssh-keygen", ["-y", "-f", file])).stdout.trim();
        const listed = existsSync(`${file}.pub`) ? readFileSync(`${file}.pub`, "utf8").trim() : derived;

        if (listed.split(/\s+/).slice(0, 2).join(" ") !== derived.split(/\s+/).slice(0, 2).join(" ")) {
            throw new Error(`${file} does not match its public key; it was left where it is.`);
        }

        this.#store(id, readFileSync(file, "utf8"), `${listed}\n`);
        rmSync(file);
        rmSync(`${file}.pub`, { force: true });
    }

    #store(id: string, privateKey: string, publicKey: string): void {
        this.#database.prepare("INSERT OR REPLACE INTO pocket_ssh_keys (id, private_key, created_at) VALUES (?, ?, ?)").run(
            id,
            privateKey,
            Date.now(),
        );
        // By path: a new key is not in the list yet.
        writeFileSync(join(this.publicDir, `${id}.pub`), publicKey, { mode: 0o644 });
    }

    #privateKey(id: string): string | undefined {
        const row = this.#database.prepare("SELECT private_key FROM pocket_ssh_keys WHERE id = ?").get(id) as
            | { private_key: string }
            | undefined;

        return row?.private_key;
    }

    #save(): void {
        writeFileSync(this.#file, `${JSON.stringify({ keys: this.#keys }, null, 2)}\n`, { mode: 0o600 });
    }

    /** A key's public half's file: it chooses the key for `ssh` (`IdentityFile`, the agent signs). */
    publicKeyPath(id: string): string {
        this.#get(id);

        return join(this.publicDir, `${id}.pub`);
    }

    #get(id: string): SshKey {
        const key = this.#keys.find((each) => each.id === id);

        if (key === undefined) {
            throw new HttpError(404, "There is no such SSH key.");
        }

        return key;
    }

    async list(): Promise<SshKeyView[]> {
        return Promise.all(this.#keys.map((key) => this.#view(key)));
    }

    async get(id: string): Promise<SshKeyView> {
        return this.#view(this.#get(id));
    }

    async #view(key: SshKey): Promise<SshKeyView> {
        const file = join(this.publicDir, `${key.id}.pub`);
        const problem = this.#problems.get(key.id);

        if (!existsSync(file)) {
            return { ...key, publicKey: "", fingerprint: "", type: "", problem: problem ?? "Its public key is missing." };
        }

        const publicKey = readFileSync(file, "utf8").trim();
        const { stdout } = await run("ssh-keygen", ["-l", "-f", file]);
        // `256 SHA256:abc... comment (ED25519)`
        const match = /^\d+\s+(\S+)\s.*\((\w+)\)\s*$/.exec(stdout.trim());

        if (match === null) {
            throw new Error(`ssh-keygen -l gave an unexpected answer for ${key.id}: ${stdout.trim()}`);
        }

        return { ...key, publicKey, fingerprint: match[1]!, type: match[2]!.toLowerCase(), ...(problem === undefined ? {} : { problem }) };
    }

    #checkName(name: unknown): string {
        if (typeof name !== "string" || name.trim() === "") {
            throw new HttpError(400, "Name the key.");
        }

        if (name.trim().length > MAX_NAME) {
            throw new HttpError(400, `A key's name is at most ${MAX_NAME} characters.`);
        }

        return name.trim();
    }

    /** A folder for one call's key files, in the app's `ssh` folder (mode 700), removed when the call ends. */
    async #scratch<T>(work: (folder: string) => Promise<T>): Promise<T> {
        const folder = mkdtempSync(join(this.#sshDir, "work-"));

        try {
            return await work(folder);
        } finally {
            rmSync(folder, { recursive: true, force: true });
        }
    }

    /** A new ed25519 key with `name`; its comment is `pi-phone <name>`, which authorized_keys files show. */
    async generate(name: unknown): Promise<SshKeyView> {
        const checked = this.#checkName(name);
        const id = randomUUID();

        await this.#scratch(async (folder) => {
            const file = join(folder, "key");

            try {
                await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", `pi-phone ${checked}`, "-f", file]);
            } catch (error) {
                throw new Error(`ssh-keygen failed: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`, {
                    cause: error,
                });
            }

            this.#store(id, readFileSync(file, "utf8"), readFileSync(`${file}.pub`, "utf8"));
        });

        return this.#added({ id, name: checked, createdAt: Date.now(), source: "generated" });
    }

    /** A private key pasted from elsewhere: checked by deriving its public key. */
    async import(name: unknown, privateKey: unknown): Promise<SshKeyView> {
        const checked = this.#checkName(name);

        if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
            throw new HttpError(400, "Paste the whole private key, from BEGIN to END.");
        }

        const id = randomUUID();
        const text = `${privateKey.replace(/\r\n/g, "\n").trimEnd()}\n`;

        await this.#scratch(async (folder) => {
            const file = join(folder, "key");
            let publicKey: string;

            writeFileSync(file, text, { mode: 0o600 });

            try {
                publicKey = (await run("ssh-keygen", ["-y", "-f", file])).stdout.trim();
            } catch (error) {
                const detail = (error as { stderr?: string }).stderr?.trim() ?? "";

                throw new HttpError(
                    400,
                    /passphrase/i.test(detail)
                        ? "This key has a passphrase. Remove it first (ssh-keygen -p), or generate a key here."
                        : `This is not a private key ssh can use${detail === "" ? "." : `: ${detail}`}`,
                );
            }

            this.#store(id, text, `${publicKey} pi-phone ${checked}\n`);
        });

        return this.#added({ id, name: checked, createdAt: Date.now(), source: "imported" });
    }

    async #added(key: SshKey): Promise<SshKeyView> {
        this.#keys.push(key);
        this.#save();
        await this.#agent.add(this.publicKeyPath(key.id), this.#privateKey(key.id)!);

        return this.#view(key);
    }

    rename(id: string, name: unknown): void {
        this.#get(id).name = this.#checkName(name);
        this.#save();
    }

    /** Removes the key: from the agent, the database, and its public file. The caller checks that no machine uses it. */
    async remove(id: string): Promise<void> {
        const publicFile = this.publicKeyPath(id);

        await this.#agent.remove(publicFile);
        this.#database.prepare("DELETE FROM pocket_ssh_keys WHERE id = ?").run(id);
        this.#keys = this.#keys.filter((each) => each.id !== id);
        this.#save();
        rmSync(publicFile, { force: true });
    }

    close(): void {
        this.#database.close();
    }
}
