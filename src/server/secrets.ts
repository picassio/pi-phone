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
 * Values extensions hide (`host.hide`, `hidden.ts`) go through the same redaction, in the session they are hidden in:
 * given a session, `redact`, `longest`, and `guard` replace them too, as `[label]`.
 *
 * They live in one file in the app's data folder, readable by the app alone (mode 0600), and go into backups with it,
 * as Pi's `auth.json` does.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HiddenValues, longestFirst, redactStream, type Replacement, replaceAll } from "./hidden.ts";

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
    } catch {
        // Not the parser's message: it can quote the file, and so a value, into the log, where Pi's bash reads it
        // (pi-pocket's review of our port, TannerMidd/pi-pocket-extensions#28).
        return `${file} is not valid JSON`;
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
    /** Each value's forms that are replaced in output, longest first, with `[secret NAME]`. */
    #patterns: Replacement[] = [];
    /** Values extensions hide (`host.hide`), redacted with the secrets in the session they are hidden in. */
    readonly hidden: HiddenValues;

    /**
     * A secrets file that cannot be read (not JSON, no "secrets" object) is moved aside to
     * `secrets.json.broken-<time>`, said in the log, and the app starts with no secrets rather than not at all (PP-92).
     */
    constructor(
        dataDir: string,
        now: () => number = Date.now,
        log: (line: string) => void = () => {},
        hidden: HiddenValues = new HiddenValues(),
    ) {
        this.#file = join(dataDir, FILE);
        this.#now = now;
        this.hidden = hidden;

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

        // The file first, from a copy: a write that fails leaves the secrets as they were, and no unsaved value is given
        // to commands (TannerMidd/pi-pocket-extensions#28).
        this.#write(new Map(this.#secrets).set(name, stored));
        this.#secrets.set(name, stored);
        this.#changed();

        return this.get(name)!;
    }

    remove(name: string): boolean {
        if (!this.#secrets.has(name)) {
            return false;
        }

        const next = new Map(this.#secrets);

        next.delete(name);
        this.#write(next);
        this.#secrets.delete(name);
        this.#changed();

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
            this.#write(this.#secrets);
        }
    }

    /**
     * What is replaced in a session's output, longest first: every secret's forms, and with `conversationId` the values
     * extensions hide there.
     */
    #replacements(conversationId?: ConversationId | number): Replacement[] {
        if (conversationId === undefined) {
            return this.#patterns;
        }

        const hidden = this.hidden.for(conversationId);

        return hidden.length === 0 ? this.#patterns : longestFirst([...this.#patterns, ...hidden]);
    }

    /**
     * Text with every secret's value, raw, base64, or URL-encoded, replaced by `[secret NAME]`; with `conversationId`,
     * the values extensions hide in that session too, by `[label]`.
     */
    redact(text: string, conversationId?: ConversationId | number): string {
        return replaceAll(text, this.#replacements(conversationId));
    }

    /** The longest text that is replaced: how much of a stream is held back so none is cut in two. */
    longest(conversationId?: ConversationId | number): number {
        return this.#replacements(conversationId)[0]?.text.length ?? 0;
    }

    /**
     * An environment like `env`, whose commands' output has secrets' values replaced as it streams; with
     * `conversationId` (the session it runs for), the values extensions hide there too.
     */
    guard(env: ExecutionEnv, conversationId?: number): ExecutionEnv {
        const key = conversationId ?? 0;
        const known = this.#guarded.get(env)?.get(key);

        if (known !== undefined) {
            return known;
        }

        const exec: ExecutionEnv["exec"] = async (command, options, context) => {
            const replacements = this.#replacements(conversationId);

            if (options?.onOutput === undefined || replacements.length === 0) {
                return env.exec(command, options, context);
            }

            const stream = redactStream(
                (text) => replaceAll(text, replacements),
                replacements[0]!.text.length - 1,
                options.onOutput,
            );

            try {
                return await env.exec(command, { ...options, onOutput: stream.onOutput }, context);
            } finally {
                stream.flush();
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

        const ofEnv = this.#guarded.get(env) ?? new Map<number, ExecutionEnv>();

        ofEnv.set(key, guarded);
        this.#guarded.set(env, ofEnv);

        return guarded;
    }

    /** Each environment's guards, by the session they run for (0: none). */
    readonly #guarded = new WeakMap<ExecutionEnv, Map<number, ExecutionEnv>>();

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #index(): void {
        const patterns: Replacement[] = [];

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
                    patterns.push({ text, replacement: `[secret ${name}]` });
                }
            }
        }

        this.#patterns = longestFirst(patterns);
    }

    /** Write `secrets` to the file, whole (a temporary file, then renamed): throws when it cannot, changing nothing. */
    #write(secrets: ReadonlyMap<string, Stored>): void {
        const temporary = `${this.#file}.${process.pid}.tmp`;

        writeFileSync(temporary, `${JSON.stringify({ version: 1, secrets: Object.fromEntries(secrets) }, null, 2)}\n`, { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.#file);
    }

    /** The secrets changed: what output hides, and who listens, follow. */
    #changed(): void {
        this.#index();

        for (const listener of this.#listeners) {
            listener();
        }
    }
}
