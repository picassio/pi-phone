/**
 * The app's SSH keys (DESIGN.md section 4): one per purpose, each used by the machines the owner assigns it to. Key
 * files live in `~/.ssh/keys/<id>` and `<id>.pub` (mode 600, the folder 700); `keys.json` in the data folder holds
 * their names. Keys have no passphrase: background work (a session's tools on a machine) has nobody to ask for one.
 * `ssh-keygen` from the bundled OpenSSH generates them and reads fingerprints; nothing here parses key formats.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { HttpError } from "./errors.ts";

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

        child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve({ stdout }) : reject(Object.assign(new Error(`${command} exited ${code}`), { stderr })),
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

/** A key as the sheet shows it: with its public half and fingerprint, read from the files. */
export type SshKeyView = SshKey & {
    publicKey: string;
    /** `SHA256:...`, as `ssh-keygen -l` prints it. */
    fingerprint: string;
    type: string;
};

const KEYS_FILE = "keys.json";
const MAX_NAME = 60;

export class SshKeys {
    readonly #file: string;
    /** `~/.ssh/keys` of the app's home. */
    readonly dir: string;
    #keys: SshKey[];

    constructor(dataDir: string, home = process.env.HOME || homedir()) {
        this.#file = join(dataDir, KEYS_FILE);
        this.dir = join(home, ".ssh", "keys");
        this.#keys = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as { keys: SshKey[] }).keys : [];
    }

    #save(): void {
        writeFileSync(this.#file, `${JSON.stringify({ keys: this.#keys }, null, 2)}\n`, { mode: 0o600 });
    }

    #ensureDir(): void {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        chmodSync(this.dir, 0o700);
    }

    /** The private key file of a key, for `ssh -i`. */
    privateKeyPath(id: string): string {
        this.#get(id);

        return join(this.dir, id);
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
        const publicKey = readFileSync(join(this.dir, `${key.id}.pub`), "utf8").trim();
        const { stdout } = await run("ssh-keygen", ["-l", "-f", join(this.dir, `${key.id}.pub`)]);
        // `256 SHA256:abc... comment (ED25519)`
        const match = /^\d+\s+(\S+)\s.*\((\w+)\)\s*$/.exec(stdout.trim());

        if (match === null) {
            throw new Error(`ssh-keygen -l gave an unexpected answer for ${key.id}: ${stdout.trim()}`);
        }

        return { ...key, publicKey, fingerprint: match[1]!, type: match[2]!.toLowerCase() };
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

    /** A new ed25519 key with `name`; its comment is `pi-phone <name>`, which authorized_keys files show. */
    async generate(name: unknown): Promise<SshKeyView> {
        const checked = this.#checkName(name);
        const id = randomUUID();

        this.#ensureDir();

        try {
            await run("ssh-keygen", [
                "-q",
                "-t",
                "ed25519",
                "-N",
                "",
                "-C",
                `pi-phone ${checked}`,
                "-f",
                join(this.dir, id),
            ]);
        } catch (error) {
            throw new Error(`ssh-keygen failed: ${(error as { stderr?: string }).stderr?.trim() || (error as Error).message}`, {
                cause: error,
            });
        }

        chmodSync(join(this.dir, id), 0o600);
        const key: SshKey = { id, name: checked, createdAt: Date.now(), source: "generated" };

        this.#keys.push(key);
        this.#save();

        return this.#view(key);
    }

    /** A private key pasted from elsewhere: checked by deriving its public key, which is written next to it. */
    async import(name: unknown, privateKey: unknown): Promise<SshKeyView> {
        const checked = this.#checkName(name);

        if (typeof privateKey !== "string" || !privateKey.includes("PRIVATE KEY")) {
            throw new HttpError(400, "Paste the whole private key, from BEGIN to END.");
        }

        const id = randomUUID();
        const path = join(this.dir, id);

        this.#ensureDir();
        writeFileSync(path, privateKey.replace(/\r\n/g, "\n").trimEnd() + "\n", { mode: 0o600 });

        let publicKey: string;

        try {
            publicKey = (await run("ssh-keygen", ["-y", "-f", path])).stdout.trim();
        } catch (error) {
            rmSync(path, { force: true });
            const detail = (error as { stderr?: string }).stderr?.trim() ?? "";

            throw new HttpError(
                400,
                /passphrase/i.test(detail)
                    ? "This key has a passphrase. Remove it first (ssh-keygen -p), or generate a key here."
                    : `This is not a private key ssh can use${detail === "" ? "." : `: ${detail}`}`,
            );
        }

        writeFileSync(`${path}.pub`, `${publicKey} pi-phone ${checked}\n`, { mode: 0o644 });
        const key: SshKey = { id, name: checked, createdAt: Date.now(), source: "imported" };

        this.#keys.push(key);
        this.#save();

        return this.#view(key);
    }

    rename(id: string, name: unknown): void {
        this.#get(id).name = this.#checkName(name);
        this.#save();
    }

    /** Removes the key and its files. The caller checks that no machine uses it first. */
    remove(id: string): void {
        this.#get(id);
        // Moved aside before removal: a crash between leaves no half-removed key the list still names.
        const gone = join(this.dir, `${id}.removed`);

        renameSync(join(this.dir, id), gone);
        rmSync(join(this.dir, `${id}.pub`), { force: true });
        this.#keys = this.#keys.filter((each) => each.id !== id);
        this.#save();
        rmSync(gone, { force: true });
    }
}
