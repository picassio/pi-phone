/**
 * The app's ssh-agent: OpenSSH's own `ssh-agent`, run by the server on a socket in its data folder (`ssh/agent.sock`,
 * the folder mode 700). It holds the app's SSH keys (`ssh-keys.ts`, kept in the database) in memory: they reach it on
 * `ssh-add`'s standard input, never as files. The agent signs logins for the app's own `ssh` (machines, port forwards,
 * terminals: `ssh/config`'s `IdentityAgent`), and never gives a key out, so whatever reaches its socket can use a key
 * but not copy it. Its socket is in no one's environment: not Pi's bash, not the phone terminal's.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** `ssh-add` with the agent's socket, `input` on its standard input; resolves with its output, rejects with what it said. */
function sshAdd(socket: string, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn("ssh-add", args, {
            // Standard input only for a key: commands that read none (list, remove) get none to write to.
            stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
            timeout: 20_000,
            env: { ...process.env, SSH_AUTH_SOCK: socket, SSH_ASKPASS_REQUIRE: "never", DISPLAY: "" },
        });
        let out = "";
        let err = "";

        child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.stderr!.on("data", (chunk: Buffer) => (err += chunk.toString()));
        child.once("error", reject);
        child.once("exit", (code) =>
            code === 0 ? resolve(out) : reject(new Error(`ssh-add ${args.join(" ")} failed (${code}): ${err.trim() || out.trim()}`)),
        );
        if (input !== undefined) {
            // ssh-add may exit before it reads the key (a refused key, a stopped agent): writing then fails with EPIPE,
            // and its exit code above says why. Any other write error is the failure.
            child.stdin!.once("error", (error: NodeJS.ErrnoException) => {
                if (error.code !== "EPIPE") {
                    reject(error);
                }
            });
            child.stdin!.end(input);
        }
    });
}

export class SshAgent {
    /** The agent's socket: in the app's `ssh` folder, which only the app reads. */
    readonly socket: string;
    readonly #folder: string;
    readonly #log: (line: string) => void;
    #child: ChildProcess | undefined;
    #started: Promise<void> | undefined;
    #stopping = false;
    /** What the agent holds, to load again if it starts over: private keys by their public key's file. */
    readonly #held = new Map<string, string>();

    constructor(folder: string, log: (line: string) => void = () => {}) {
        this.#folder = folder;
        this.socket = join(folder, "agent.sock");
        this.#log = log;
    }

    /** Start the agent, if it is not running: resolves once its socket answers. */
    start(): Promise<void> {
        this.#started ??= this.#start();

        return this.#started;
    }

    async #start(): Promise<void> {
        mkdirSync(this.#folder, { recursive: true, mode: 0o700 });
        rmSync(this.socket, { force: true });
        // In the foreground (-D), so it ends with the server; no lifetime on keys: sessions sign whenever they connect.
        const child = spawn("ssh-agent", ["-D", "-a", this.socket], { stdio: ["ignore", "ignore", "pipe"] });
        let said = "";

        child.stderr!.on("data", (chunk: Buffer) => (said = (said + chunk.toString()).slice(-1000)));
        this.#child = child;
        child.once("exit", (code) => {
            this.#child = undefined;
            this.#started = undefined;

            if (!this.#stopping) {
                this.#log(`ssh-agent ended (${code ?? "signal"}): ${said.trim()}; starting it again`);
                void this.start().then(
                    () => this.#reload(),
                    (error: unknown) => this.#log(`ssh-agent did not start again: ${String(error)}`),
                );
            }
        });

        for (let tries = 0; !existsSync(this.socket); tries++) {
            if (tries > 100 || this.#child === undefined) {
                throw new Error(`ssh-agent did not start: ${said.trim() || "no socket"}`);
            }

            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    /** Give the agent a private key, from memory. `publicKeyFile` names it, to take it out again. */
    async add(publicKeyFile: string, privateKey: string): Promise<void> {
        await this.start();
        await sshAdd(this.socket, ["-q", "-"], privateKey.endsWith("\n") ? privateKey : `${privateKey}\n`);
        this.#held.set(publicKeyFile, privateKey);
    }

    /** Take a key out of the agent, by its public key's file. */
    async remove(publicKeyFile: string): Promise<void> {
        this.#held.delete(publicKeyFile);

        if (this.#child !== undefined) {
            await sshAdd(this.socket, ["-q", "-d", publicKeyFile]).catch((error: unknown) => this.#log(String(error)));
        }
    }

    /** The public keys the agent holds, as `ssh-add -L` prints them. */
    async keys(): Promise<string[]> {
        await this.start();
        const listed = await sshAdd(this.socket, ["-L"]).catch(() => "");

        return listed.split("\n").filter((line) => line.startsWith("ssh-") || line.startsWith("ecdsa-"));
    }

    async #reload(): Promise<void> {
        for (const [publicKeyFile, privateKey] of [...this.#held]) {
            await this.add(publicKeyFile, privateKey).catch((error: unknown) => this.#log(`could not give ssh-agent a key again: ${String(error)}`));
        }
    }

    stop(): void {
        this.#stopping = true;
        this.#child?.kill();
        this.#child = undefined;
        this.#held.clear();
        rmSync(this.socket, { force: true });
    }
}
