/**
 * The owner's secrets: API keys and tokens Pi uses without seeing them. Each has a name that is an environment variable's
 * (`NPM_TOKEN`), a value, a description that tells Pi what it is for, and where it may be used: in any folder or some,
 * on the phone alone or on machines too, with or without asking first.
 *
 * Pi never gets a value. A `bash` command that names a secret (`$NPM_TOKEN`) runs with it in its environment, so the
 * command as stored and shown keeps the name (`extensions/secrets.ts` sets it). Whatever output holds a value anyway
 * shows `[secret NAME]` instead: bash's streamed output through `guard()`, every tool's result through the extension's
 * `afterTool` hook, and a person's own message before it is sent. That keeps values out of the model, the transcript,
 * the wiki, and the screen by accident; it is not a boundary against a model set on leaking one.
 *
 * They live in one file in the app's data folder, readable by the app alone (mode 0600), and go into backups with it,
 * as Pi's `auth.json` does.
 */
import type { Context } from "@earendil-works/chord";
import type { ExecutionEnv, ShellExecOptions } from "@earendil-works/pi-durable/env";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What a secret is called: an environment variable's name, upper case. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** Shorter values would be replaced wherever they happen to appear in output, so they are refused. */
export const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 16_384;
const MAX_DESCRIPTION = 300;
const FILE = "secrets.json";

/** A secret as the app shows it: everything but its value. */
export type SecretInfo = {
    name: string;
    description: string;
    /** Folders it may be used in, and below them: phone paths or `machine:<id>:<path>`. Empty: anywhere. */
    folders: string[];
    /** Whether sessions on machines may use it too, not only those on the phone. */
    machines: boolean;
    /** Whether a call that uses it waits for a person to allow it. */
    ask: boolean;
    createdAt: number;
    updatedAt: number;
    usedAt?: number;
};

type Stored = SecretInfo & { value: string };

/** What can change about a secret. A new one needs a value. */
export type SecretPatch = {
    value?: unknown;
    description?: unknown;
    folders?: unknown;
    machines?: unknown;
    ask?: unknown;
};

/** The names a command refers to: `$NAME` or `${NAME}`. */
export function namesIn(command: string): string[] {
    return [...new Set([...command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!))];
}

/** Whether `cwd` is `folder` or below it. */
/** The secrets a file holds, or what is wrong with it. */
function readSecretsFile(file: string): Record<string, Stored> | string {
    let parsed: unknown;

    try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (error) {
        return `${file} is not valid JSON (${String(error)})`;
    }

    const items = (parsed as { secrets?: unknown } | null)?.secrets;

    if (items === undefined || typeof items !== "object" || items === null || Array.isArray(items)) {
        return `${file} has no "secrets" object`;
    }

    return items as Record<string, Stored>;
}

function within(cwd: string, folder: string): boolean {
    const base = folder.replace(/\/+$/, "");

    return cwd === base || cwd.startsWith(`${base}/`);
}

export class Secrets {
    readonly #file: string;
    readonly #now: () => number;
    readonly #secrets = new Map<string, Stored>();
    readonly #listeners = new Set<() => void>();
    /** Each value's forms that are replaced in output, longest first, with the name they stand for. */
    #patterns: { text: string; name: string }[] = [];

    /**
     * A secrets file that cannot be read (not JSON, no "secrets" object) is moved aside to
     * `secrets.json.broken-<time>`, said in the log, and the app starts with no secrets rather than not at all (PP-92).
     */
    constructor(dataDir: string, now: () => number = Date.now, log: (line: string) => void = () => {}) {
        this.#file = join(dataDir, FILE);
        this.#now = now;

        if (existsSync(this.#file)) {
            const items = readSecretsFile(this.#file);

            if (typeof items === "string") {
                const aside = `${this.#file}.broken-${now()}`;

                renameSync(this.#file, aside);
                log(`secrets: ${items}; moved it to ${aside} and started with no secrets`);
            } else {
                for (const [name, item] of Object.entries(items)) {
                    this.#secrets.set(name, { ...item, name });
                }
            }
        }

        this.#index();
    }

    /** Every secret, without values, by name. */
    list(): SecretInfo[] {
        return [...this.#secrets.values()]
            .map(({ value: _value, ...info }) => info)
            .sort((a, b) => a.name.localeCompare(b.name));
    }

    get(name: string): SecretInfo | undefined {
        const found = this.#secrets.get(name);

        if (found === undefined) {
            return undefined;
        }

        const { value: _value, ...info } = found;

        return info;
    }

    has(name: string): boolean {
        return this.#secrets.has(name);
    }

    /**
     * A secret's value, for the app's own requests (a web search provider's key): never for a route, the model, or a
     * log. Undefined when there is none.
     */
    value(name: string): string | undefined {
        return this.#secrets.get(name)?.value;
    }

    /** Add a secret, or change one: what the patch leaves out stays as it was. */
    set(name: unknown, patch: SecretPatch): SecretInfo {
        if (typeof name !== "string" || !SECRET_NAME.test(name)) {
            throw new Error(
                "A secret's name is an environment variable's: capital letters, digits, and _, not starting with a digit (NPM_TOKEN).",
            );
        }

        const before = this.#secrets.get(name);
        const value = patch.value === undefined ? before?.value : patch.value;

        if (typeof value !== "string" || value === "") {
            throw new Error(`${name} needs a value.`);
        }

        if (value.length < MIN_SECRET_LENGTH) {
            throw new Error(
                `${name} is shorter than ${MIN_SECRET_LENGTH} characters: too short to keep out of outputs without hiding ordinary text.`,
            );
        }

        if (value.length > MAX_SECRET_LENGTH || /[\r\n]/.test(value.replace(/\n+$/, ""))) {
            throw new Error(`${name}'s value is one line of at most ${MAX_SECRET_LENGTH} characters.`);
        }

        const description = patch.description === undefined ? (before?.description ?? "") : patch.description;

        if (typeof description !== "string" || description.length > MAX_DESCRIPTION) {
            throw new Error(`The description is text of at most ${MAX_DESCRIPTION} characters.`);
        }

        const folders = patch.folders === undefined ? (before?.folders ?? []) : patch.folders;

        if (!Array.isArray(folders) || folders.some((folder) => typeof folder !== "string" || folder.trim() === "")) {
            throw new Error("Folders are a list of paths.");
        }

        const flag = (given: unknown, was: boolean | undefined, fallback: boolean, what: string): boolean => {
            const result = given === undefined ? (was ?? fallback) : given;

            if (typeof result !== "boolean") {
                throw new Error(`${what} is true or false.`);
            }

            return result;
        };
        const now = this.#now();
        const stored: Stored = {
            name,
            value: value.replace(/\n+$/, ""),
            description: description.trim(),
            folders: [...new Set(folders.map((folder: string) => folder.trim().replace(/\/+$/, "") || "/"))],
            machines: flag(patch.machines, before?.machines, true, "Machines"),
            ask: flag(patch.ask, before?.ask, false, "Ask"),
            createdAt: before?.createdAt ?? now,
            updatedAt: now,
            ...(before?.usedAt === undefined ? {} : { usedAt: before.usedAt }),
        };

        this.#secrets.set(name, stored);
        this.#save();

        return this.get(name)!;
    }

    remove(name: string): boolean {
        if (!this.#secrets.delete(name)) {
            return false;
        }

        this.#save();

        return true;
    }

    /** Whether a session working in `cwd` may use the secret. */
    allowed(name: string, cwd: string): boolean {
        const secret = this.#secrets.get(name);

        if (secret === undefined || (cwd.startsWith("machine:") && !secret.machines)) {
            return false;
        }

        return secret.folders.length === 0 || secret.folders.some((folder) => within(cwd, folder));
    }

    /** The secrets a session in `cwd` may use, without values. */
    usableIn(cwd: string): SecretInfo[] {
        return this.list().filter((secret) => this.allowed(secret.name, cwd));
    }

    /** The values of the named secrets a session in `cwd` may use, for a command's environment. */
    environment(names: readonly string[], cwd: string): Record<string, string> {
        const env: Record<string, string> = {};

        for (const name of names) {
            const secret = this.#secrets.get(name);

            if (secret !== undefined && this.allowed(name, cwd)) {
                env[name] = secret.value;
            }
        }

        return env;
    }

    /** Note that these were used now, for the Secrets sheet. */
    used(names: readonly string[]): void {
        const now = this.#now();
        let changed = false;

        for (const name of names) {
            const secret = this.#secrets.get(name);

            if (secret !== undefined) {
                secret.usedAt = now;
                changed = true;
            }
        }

        if (changed) {
            this.#save(false);
        }
    }

    /** Text with every secret's value, raw, base64, or URL-encoded, replaced by `[secret NAME]`. */
    redact(text: string): string {
        let result = text;

        for (const { text: value, name } of this.#patterns) {
            if (result.includes(value)) {
                result = result.split(value).join(`[secret ${name}]`);
            }
        }

        return result;
    }

    /** The longest form of a value that is replaced: how much of a stream is held back so none is cut in two. */
    longest(): number {
        return this.#patterns[0]?.text.length ?? 0;
    }

    /** An environment like `env`, whose commands' output has secrets' values replaced as it streams. */
    guard(env: ExecutionEnv): ExecutionEnv {
        const known = this.#guarded.get(env);

        if (known !== undefined) {
            return known;
        }

        const secrets = this;
        const exec: ExecutionEnv["exec"] = async (command, options, context) => {
            if (options?.onOutput === undefined || secrets.longest() === 0) {
                return env.exec(command, options, context);
            }

            const onOutput = options.onOutput;
            // Per stream, what came but is held back: it may end in the first part of a value.
            const held = new Map<string, { text: string; context: Context }>();
            const hold = secrets.longest() - 1;
            const wrapped: ShellExecOptions = {
                ...options,
                onOutput: (text, context, info) => {
                    // After omitted output, what was held belongs to the omitted part.
                    const before = info.skipped === undefined ? (held.get(info.stream)?.text ?? "") : "";
                    const joined = secrets.redact(before + text);
                    const cut = Math.max(0, joined.length - hold);

                    held.set(info.stream, { text: joined.slice(cut), context });

                    if (cut > 0 || info.skipped !== undefined) {
                        onOutput(joined.slice(0, cut), context, info);
                    }
                },
            };

            try {
                return await env.exec(command, wrapped, context);
            } finally {
                for (const [stream, rest] of held) {
                    if (rest.text !== "") {
                        onOutput(secrets.redact(rest.text), rest.context, { stream: stream as "stdout" | "stderr" });
                    }
                }
            }
        };
        const guarded = new Proxy(env, {
            get(target, property) {
                if (property === "exec") {
                    return exec;
                }

                // Methods run on the environment itself: its private fields are not the proxy's.
                const value: unknown = Reflect.get(target, property, target);

                return typeof value === "function" ? value.bind(target) : value;
            },
        });

        this.#guarded.set(env, guarded);

        return guarded;
    }

    readonly #guarded = new WeakMap<ExecutionEnv, ExecutionEnv>();

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #index(): void {
        const patterns: { text: string; name: string }[] = [];

        for (const { name, value } of this.#secrets.values()) {
            const bytes = Buffer.from(value, "utf8");
            const forms = new Set([
                value,
                bytes.toString("base64"),
                bytes.toString("base64").replace(/=+$/, ""),
                bytes.toString("base64url"),
                encodeURIComponent(value),
            ]);

            for (const text of forms) {
                if (text.length >= MIN_SECRET_LENGTH) {
                    patterns.push({ text, name });
                }
            }
        }

        this.#patterns = patterns.sort((a, b) => b.text.length - a.text.length);
    }

    #save(changed = true): void {
        const temporary = `${this.#file}.${process.pid}.tmp`;

        writeFileSync(
            temporary,
            `${JSON.stringify({ version: 1, secrets: Object.fromEntries(this.#secrets) }, null, 2)}\n`,
            { mode: 0o600 },
        );
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.#file);

        if (changed) {
            this.#index();

            for (const listener of this.#listeners) {
                listener();
            }
        }
    }
}
