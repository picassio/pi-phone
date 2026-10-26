/**
 * The owner's secrets, in one file: `<data>/secrets/secrets.json`, readable by Pi Pocket alone (mode 0600). Each has a
 * name that is an environment variable's (`NPM_TOKEN`), a value, what it is for, and where it may be used: in any
 * folder or some, by the owner's work alone or by guests' too, with or without asking first.
 *
 * No function here gives a value to the browser: `list` and `get` leave it out.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** What a secret is called: an environment variable's name, upper case. */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** `host.hide` takes values of 4 characters or more; shorter would hide ordinary text. We ask for 8. */
export const MIN_LENGTH = 8;
/** `host.hide` takes values up to 4096 characters: every form of a value (its base64 is longer) must fit. */
export const MAX_FORM = 4096;
/** A value, as typed: the longest whose every form `host.hide` can take is checked by `hideable`. */
export const MAX_LENGTH = 3000;
export const MAX_DESCRIPTION = 300;
export const MAX_FOLDERS = 20;
export const MAX_SECRETS = 400;

/** A secret as the app shows it: everything but its value. */
export type SecretInfo = {
    name: string;
    description: string;
    /** Folders it may be used in, and below them. Empty: anywhere. */
    folders: string[];
    /** Whether a guest's message may use it too, not only the owner's. */
    guests: boolean;
    /** Whether a command that uses it waits for a person to allow it. */
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
    guests?: unknown;
    ask?: unknown;
};

/** The names a command refers to: `$NAME` or `${NAME}`. */
export function namesIn(command: string): string[] {
    return [
        ...new Set(
            [...command.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!),
        ),
    ];
}

/**
 * The forms of a value that output can hold: as it is, base64 (with and without padding), base64url, URL-encoded. Each
 * is hidden; a value with a form too long to hide is refused (`hideable`), never kept half hidden.
 */
export function formsOf(value: string): string[] {
    const bytes = Buffer.from(value, "utf8");

    return [
        ...new Set([
            value,
            bytes.toString("base64"),
            bytes.toString("base64").replace(/=+$/, ""),
            bytes.toString("base64url"),
            encodeURIComponent(value),
        ]),
    ].filter((form) => form.length >= MIN_LENGTH);
}

/** Whether `host.hide` can take every form of a value. */
export const hideable = (value: string) => formsOf(value).every((form) => form.length <= MAX_FORM);

/** A folder as written (`~/work/site`), as an absolute path without a trailing `/`. */
export function folderPath(folder: string): string {
    const expanded =
        folder === "~" || folder.startsWith("~/") ? homedir() + folder.slice(1) : folder;

    return resolve(expanded);
}

/** Whether `cwd` is `folder` or below it. */
export function within(cwd: string, folder: string): boolean {
    const base = folderPath(folder);
    const here = resolve(cwd);

    return here === base || here.startsWith(base === "/" ? "/" : `${base}/`);
}

export class Store {
    readonly #folder: string;
    readonly #file: string;
    readonly #now: () => number;
    readonly #secrets = new Map<string, Stored>();
    /** The owner's person id, learnt from an owner's request: the guest rule needs it. */
    #owner: string | undefined;
    /** Why the file could not be read, when it could not: the owner gets a notice. */
    readonly problem: string | undefined;

    constructor(dataDir: string, now: () => number = Date.now) {
        this.#folder = join(dataDir, "secrets");
        this.#file = join(this.#folder, "secrets.json");
        this.#now = now;

        let problem: string | undefined;

        if (existsSync(this.#file)) {
            try {
                const parsed = JSON.parse(readFileSync(this.#file, "utf8")) as {
                    owner?: unknown;
                    secrets?: unknown;
                } | null;
                const items = parsed?.secrets;

                if (typeof items !== "object" || items === null || Array.isArray(items)) {
                    throw new Error('it has no "secrets" object');
                }

                this.#owner = typeof parsed?.owner === "string" ? parsed.owner : undefined;

                for (const [name, item] of Object.entries(items as Record<string, Stored>)) {
                    if (SECRET_NAME.test(name) && typeof item?.value === "string") {
                        this.#secrets.set(name, {
                            name,
                            value: item.value,
                            description:
                                typeof item.description === "string" ? item.description : "",
                            folders: Array.isArray(item.folders)
                                ? item.folders.filter((folder) => typeof folder === "string")
                                : [],
                            guests: item.guests === true,
                            ask: item.ask === true,
                            createdAt: Number(item.createdAt) || 0,
                            updatedAt: Number(item.updatedAt) || 0,
                            ...(typeof item.usedAt === "number" ? { usedAt: item.usedAt } : {}),
                        });
                    }
                }
            } catch (error) {
                this.#secrets.clear();
                this.#owner = undefined;
                const aside = `${this.#file}.bad-${this.#now()}`;

                renameSync(this.#file, aside);
                // A fixed message: a parser's words can quote the file, and so a value, into a notice.
                problem = `The secrets file could not be read. It was moved to ${aside}, and Secrets starts with none.`;
            }
        }

        this.problem = problem;
    }

    /** The owner's person id, once an owner's request told it. */
    get owner(): string | undefined {
        return this.#owner;
    }

    /** Keep the owner's id, from a request that the owner made. */
    learnOwner(id: string): void {
        if (this.#owner !== id) {
            this.#owner = id;
            this.#save();
        }
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

    /** A value, for a command's environment and for hiding. Never for a route. */
    value(name: string): string | undefined {
        return this.#secrets.get(name)?.value;
    }

    /** Add a secret, or change one: what the patch leaves out stays as it was. Throws with words for the person. */
    set(name: unknown, patch: SecretPatch): SecretInfo {
        if (typeof name !== "string" || !SECRET_NAME.test(name)) {
            throw new Error(
                "A secret's name is an environment variable's: capital letters, digits, and _, not starting with a digit (NPM_TOKEN).",
            );
        }

        const before = this.#secrets.get(name);

        if (before === undefined && this.#secrets.size >= MAX_SECRETS) {
            throw new Error(`There are ${MAX_SECRETS} secrets already: remove one first.`);
        }

        const given = patch.value === undefined ? before?.value : patch.value;

        if (typeof given !== "string" || given.trim() === "") {
            throw new Error(`${name} needs a value.`);
        }

        const value = given.replace(/[\r\n]+$/, "");

        if (value.length < MIN_LENGTH) {
            throw new Error(
                `${name} is shorter than ${MIN_LENGTH} characters: too short to keep out of output without hiding ordinary text.`,
            );
        }

        if (value.length > MAX_LENGTH || /[\r\n\0]/.test(value)) {
            throw new Error(`${name}'s value is one line of at most ${MAX_LENGTH} characters.`);
        }

        if (!hideable(value)) {
            throw new Error(`${name}'s value is too long to keep out of output in all its forms.`);
        }

        const description =
            patch.description === undefined ? (before?.description ?? "") : patch.description;

        if (
            typeof description !== "string" ||
            description.length > MAX_DESCRIPTION ||
            /[\r\n]/.test(description)
        ) {
            throw new Error(
                `The description is one line of at most ${MAX_DESCRIPTION} characters.`,
            );
        }

        const folders = patch.folders === undefined ? (before?.folders ?? []) : patch.folders;

        if (
            !Array.isArray(folders) ||
            folders.length > MAX_FOLDERS ||
            folders.some(
                (folder) =>
                    typeof folder !== "string" || folder.trim() === "" || folder.length > 500,
            )
        ) {
            throw new Error(`Folders are a list of at most ${MAX_FOLDERS} paths.`);
        }

        const flag = (given: unknown, was: boolean | undefined, what: string): boolean => {
            const result = given === undefined ? (was ?? false) : given;

            if (typeof result !== "boolean") {
                throw new Error(`${what} is true or false.`);
            }

            return result;
        };

        const now = this.#now();
        const stored: Stored = {
            name,
            value,
            description: description.trim(),
            folders: [
                ...new Set(folders.map((folder: string) => folder.trim().replace(/(.)\/+$/, "$1"))),
            ],
            guests: flag(patch.guests, before?.guests, "Guests"),
            ask: flag(patch.ask, before?.ask, "Ask"),
            createdAt: before?.createdAt ?? now,
            updatedAt: now,
            ...(before?.usedAt === undefined ? {} : { usedAt: before.usedAt }),
        };

        // The file first: if it cannot be written, nothing changes, and no unsaved value is given to commands.
        this.#save(new Map(this.#secrets).set(name, stored));
        this.#secrets.set(name, stored);

        return this.get(name)!;
    }

    remove(name: string): boolean {
        if (!this.#secrets.has(name)) {
            return false;
        }

        const rest = new Map(this.#secrets);

        rest.delete(name);
        this.#save(rest);
        this.#secrets.delete(name);

        return true;
    }

    /** Whether a session working in `cwd` may use the secret there, by its folders. */
    inFolder(name: string, cwd: string): boolean {
        const secret = this.#secrets.get(name);

        return (
            secret !== undefined &&
            (secret.folders.length === 0 || secret.folders.some((folder) => within(cwd, folder)))
        );
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
            this.#save();
        }
    }

    #save(secrets: ReadonlyMap<string, Stored> = this.#secrets): void {
        mkdirSync(this.#folder, { recursive: true, mode: 0o700 });
        chmodSync(this.#folder, 0o700);
        const temporary = `${this.#file}.${process.pid}.tmp`;

        writeFileSync(
            temporary,
            `${JSON.stringify(
                {
                    version: 1,
                    ...(this.#owner === undefined ? {} : { owner: this.#owner }),
                    secrets: Object.fromEntries(secrets),
                },
                null,
                2,
            )}\n`,
            { mode: 0o600 },
        );
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.#file);
    }
}
