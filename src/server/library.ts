/**
 * The owner's library of skills and slash commands (PP-466, epic PP-464): kept in the app, pinned to a session, a board,
 * or every session, and loaded only where pinned.
 *
 * - Files: the current version of each in `<data>/library/skills/<name>/` (an Agent Skills folder: SKILL.md and its
 *   files) or `<data>/library/commands/<name>.md` (a prompt template: `description`, `argument-hint`, `$ARGUMENTS`,
 *   `$1`…). Sessions read these paths, so an edit shows at the same place. Each version's files stay in
 *   `<data>/library/.versions/<kind>/<name>/<n>/`.
 * - The rest in the app's database (`app.sqlite`): each item and the version it is at, its versions (time, note, size),
 *   and its pins.
 * - Every save keeps a new version (one past the newest) and makes it current. Undo goes back to the version before the
 *   current one, restore to any kept one: both only move which version is current (its files are copied to the current
 *   place), so a later save is one past the newest again. `LIBRARY_KEEP_VERSIONS` are kept, never the current one.
 *
 * All of it is synchronous (node:fs, node:sqlite): one change ends before another starts.
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { APP_DATABASE, openAppDatabase } from "./app-database.ts";
import { HttpError } from "./errors.ts";

export const LIBRARY_KINDS = ["skill", "command"] as const;
export type LibraryKind = (typeof LIBRARY_KINDS)[number];
/** Where an item is pinned: one session (and its subagents), a board's sessions, or every session of the owner's. */
export const PIN_SCOPES = ["session", "board", "all"] as const;
export type PinScope = (typeof PIN_SCOPES)[number];
/** A pin: its scope and what it names there (a conversation id, a board's key, or "" for every session). */
export type LibraryPin = { scope: PinScope; target: string };
/** A pin as the page shows it: its session's title or board's name, or `gone` when that is no longer there. */
export type PinView = LibraryPin & { label?: string; gone?: true };
/** An item's files: paths below its folder, and their text. */
export type LibraryFiles = Record<string, string>;
export type LibraryVersion = { n: number; at: number; note: string; bytes: number; files: number };
export type LibraryItem = {
    kind: LibraryKind;
    name: string;
    description: string;
    argumentHint?: string;
    /** The version that is current. */
    version: number;
    /** How many versions are kept. */
    versions: number;
    createdAt: number;
    updatedAt: number;
    pins: LibraryPin[];
    /** The current file sessions read: the skill's SKILL.md, or the command's `.md`. */
    path: string;
};
/** What a conversation is pinned through: the conversations up its subagent chain, and its board's key. */
export type PinPlace = { sessions: readonly string[]; board?: string };
/** An item a conversation has, and the pin that gives it (session before board before every session). */
export type PinnedItem = { kind: LibraryKind; name: string; path: string; pin: LibraryPin };

/** The Agent Skills name rule: lowercase letters and digits, single hyphens between them, 64 at most. */
export const LIBRARY_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const LIBRARY_NAME_MAX = 64;
export const LIBRARY_DESCRIPTION_MAX = 1024;
export const LIBRARY_COMPATIBILITY_MAX = 500;
export const LIBRARY_MAX_FILES = 100;
export const LIBRARY_MAX_BYTES = 1024 * 1024;
export const LIBRARY_KEEP_VERSIONS = 50;
/** A board's key, as `projects.ts` makes them. */
const BOARD_KEY = /^[A-Z][A-Z0-9]{1,5}$/;
/** A part of a file's path: no hidden files, no `..`. */
const PATH_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/;
const NOTE_MAX = 200;

const bad = (message: string) => new HttpError(400, message);

export function libraryKind(value: unknown): LibraryKind {
    if (typeof value !== "string" || !(LIBRARY_KINDS as readonly string[]).includes(value)) {
        throw bad("The kind is skill or command.");
    }

    return value as LibraryKind;
}

/** What is wrong with a name, by the Agent Skills rule; undefined when nothing is. */
export function libraryNameProblem(name: unknown): string | undefined {
    if (typeof name !== "string" || name === "") {
        return "A name is needed.";
    }

    if (name.length > LIBRARY_NAME_MAX) {
        return `A name is ${LIBRARY_NAME_MAX} characters at most.`;
    }

    return LIBRARY_NAME.test(name)
        ? undefined
        : `${name} is not a valid name: lowercase letters, digits, and single hyphens between them (like ssp-review).`;
}

/** A pin as given, checked: its scope, and a conversation id, a board's key, or nothing for every session. */
export function libraryPin(scope: unknown, target: unknown): LibraryPin {
    if (typeof scope !== "string" || !(PIN_SCOPES as readonly string[]).includes(scope)) {
        throw bad("A pin's scope is session, board, or all.");
    }

    const given = target === undefined || target === null ? "" : String(target).trim();

    if (scope === "all") {
        return { scope, target: "" };
    }

    if (scope === "session" && !/^\d+$/.test(given)) {
        throw bad("A session pin names the session's id.");
    }

    if (scope === "board" && !BOARD_KEY.test(given)) {
        throw bad("A board pin names the board's key, like PP.");
    }

    return { scope: scope as PinScope, target: given };
}

/** A file's path below an item's folder, checked: relative, no hidden parts, no `..`. */
function filePath(path: string): string {
    const parts = path.split("/");

    if (parts.length > 8 || !parts.every((part) => PATH_PART.test(part) && part !== "." && !part.includes(".."))) {
        throw bad(`${path} is not a file name the library takes: parts of letters, digits, . _ -, none hidden, 8 deep at most.`);
    }

    return path;
}

/** The front matter and body of a Markdown file, or a 400 naming the file. */
function frontOf(file: string, text: string): { frontmatter: Record<string, unknown>; body: string } {
    try {
        return parseFrontmatter(text) as { frontmatter: Record<string, unknown>; body: string };
    } catch (error) {
        throw bad(`${file}'s front matter cannot be read: ${error instanceof Error ? error.message : String(error)}`);
    }
}

/** What the item's main file says of it: its description, and a command's argument hint. */
function described(kind: LibraryKind, name: string, files: LibraryFiles): { description: string; argumentHint?: string } {
    const main = kind === "skill" ? "SKILL.md" : `${name}.md`;
    const text = files[main];

    if (text === undefined) {
        throw bad(kind === "skill" ? "A skill needs a SKILL.md." : "A command needs its text.");
    }

    const { frontmatter, body } = frontOf(main, text);
    const description = frontmatter.description;

    if (typeof description !== "string" || description.trim() === "") {
        throw bad(`${main} needs a description in its front matter: what it does and when to use it.`);
    }

    if (description.length > LIBRARY_DESCRIPTION_MAX) {
        throw bad(`A description is ${LIBRARY_DESCRIPTION_MAX} characters at most.`);
    }

    if (body.trim() === "") {
        throw bad(`${main} has nothing after its front matter.`);
    }

    if (kind === "skill") {
        if (frontmatter.name !== name) {
            throw bad(`SKILL.md's front matter names it ${String(frontmatter.name ?? "nothing")}: it must say name: ${name}.`);
        }

        const compatibility = frontmatter.compatibility;

        if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > LIBRARY_COMPATIBILITY_MAX)) {
            throw bad(`compatibility is text of ${LIBRARY_COMPATIBILITY_MAX} characters at most.`);
        }

        return { description };
    }

    const hint = frontmatter["argument-hint"];

    if (hint !== undefined && typeof hint !== "string") {
        throw bad("argument-hint is text, like [file] [focus].");
    }

    return { description, ...(hint === undefined || hint === "" ? {} : { argumentHint: hint }) };
}

/** An item's files as given (`files` for a skill, `content` for a command), checked. */
export function libraryFiles(kind: LibraryKind, name: string, given: { files?: unknown; content?: unknown }): LibraryFiles {
    const problem = libraryNameProblem(name);

    if (problem !== undefined) {
        throw bad(problem);
    }

    let files: LibraryFiles;

    if (kind === "command") {
        if (typeof given.content !== "string") {
            throw bad("A command is given as content: its Markdown text.");
        }

        files = { [`${name}.md`]: given.content };
    } else {
        if (typeof given.files !== "object" || given.files === null || Array.isArray(given.files)) {
            throw bad("A skill is given as files: each path below its folder and its text, SKILL.md among them.");
        }

        files = {};

        for (const [path, text] of Object.entries(given.files)) {
            if (typeof text !== "string") {
                throw bad(`${path}: the library keeps text files only.`);
            }

            files[filePath(path)] = text;
        }
    }

    const paths = Object.keys(files);
    const bytes = paths.reduce((sum, path) => sum + Buffer.byteLength(files[path]!), 0);

    if (paths.length > LIBRARY_MAX_FILES) {
        throw bad(`An item has ${LIBRARY_MAX_FILES} files at most.`);
    }

    if (bytes > LIBRARY_MAX_BYTES) {
        throw bad(`An item is ${LIBRARY_MAX_BYTES / 1024} KB at most.`);
    }

    // A file and a folder of one name cannot both be written.
    for (const path of paths) {
        if (paths.some((other) => other.startsWith(`${path}/`))) {
            throw bad(`${path} is a file and a folder.`);
        }
    }

    described(kind, name, files);

    return files;
}

/** Every file below `folder`, by its path there. */
function readFolder(folder: string, below = ""): LibraryFiles {
    const files: LibraryFiles = {};

    for (const entry of readdirSync(join(folder, below), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const path = below === "" ? entry.name : `${below}/${entry.name}`;

        if (entry.isDirectory()) {
            Object.assign(files, readFolder(folder, path));
        } else if (entry.isFile()) {
            files[path] = readFileSync(join(folder, path), "utf8");
        }
    }

    return files;
}

/** Write `files` into a new folder `folder`; a skill's `scripts/` can be run. */
function writeFolder(folder: string, files: LibraryFiles): void {
    mkdirSync(folder, { recursive: true });

    for (const [path, text] of Object.entries(files)) {
        const at = join(folder, path);

        mkdirSync(dirname(at), { recursive: true });
        writeFileSync(at, text);

        if (path.startsWith("scripts/")) {
            chmodSync(at, 0o755);
        }
    }
}

type ItemRow = { kind: string; name: string; current: number; description: string; argument_hint: string | null; created_at: number; updated_at: number };

/** The library: its files under `<dataDir>/library`, the rest in the app's database. */
export class Library {
    readonly root: string;
    readonly #db: DatabaseSync;
    readonly #now: () => number;
    #revision = 0;

    constructor(dataDir: string, { file = APP_DATABASE, now = Date.now }: { file?: string; now?: () => number } = {}) {
        this.root = join(dataDir, "library");
        this.#now = now;
        this.#db = openAppDatabase(dataDir, file);
        this.#db.exec(`
            CREATE TABLE IF NOT EXISTS pocket_library_items (
                kind TEXT NOT NULL, name TEXT NOT NULL, current INTEGER NOT NULL, description TEXT NOT NULL,
                argument_hint TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (kind, name)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_library_versions (
                kind TEXT NOT NULL, name TEXT NOT NULL, n INTEGER NOT NULL, at INTEGER NOT NULL, note TEXT NOT NULL,
                bytes INTEGER NOT NULL, files INTEGER NOT NULL, PRIMARY KEY (kind, name, n)
            ) STRICT;
            CREATE TABLE IF NOT EXISTS pocket_library_pins (
                kind TEXT NOT NULL, name TEXT NOT NULL, scope TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL,
                PRIMARY KEY (kind, name, scope, target)
            ) STRICT;
        `);
    }

    close(): void {
        this.#db.close();
    }

    /** A number that changes with every change to the library (a save, undo, restore, delete, pin): caches key on it. */
    get revision(): number {
        return this.#revision;
    }

    /** The current file sessions read: a skill's SKILL.md, a command's `.md`. */
    pathOf(kind: LibraryKind, name: string): string {
        return kind === "skill" ? join(this.root, "skills", name, "SKILL.md") : join(this.root, "commands", `${name}.md`);
    }

    /** A skill's folder, which its SKILL.md names its files from. */
    skillFolder(name: string): string {
        return join(this.root, "skills", name);
    }

    #versionsDir(kind: LibraryKind, name: string): string {
        return join(this.root, ".versions", kind, name);
    }

    #row(kind: LibraryKind, name: string): ItemRow | undefined {
        return this.#db.prepare("SELECT * FROM pocket_library_items WHERE kind = ? AND name = ?").get(kind, name) as ItemRow | undefined;
    }

    #need(kind: LibraryKind, name: string): ItemRow {
        const row = this.#row(kind, name);

        if (row === undefined) {
            throw new HttpError(404, `The library has no ${kind} named ${name}.`);
        }

        return row;
    }

    #pins(kind: LibraryKind, name: string): LibraryPin[] {
        return (this.#db.prepare("SELECT scope, target FROM pocket_library_pins WHERE kind = ? AND name = ? ORDER BY at, scope, target").all(kind, name) as LibraryPin[]).map(
            ({ scope, target }) => ({ scope, target }),
        );
    }

    #item(row: ItemRow): LibraryItem {
        const kind = row.kind as LibraryKind;

        return {
            kind,
            name: row.name,
            description: row.description,
            ...(row.argument_hint === null ? {} : { argumentHint: row.argument_hint }),
            version: Number(row.current),
            versions: Number(
                (this.#db.prepare("SELECT COUNT(*) AS n FROM pocket_library_versions WHERE kind = ? AND name = ?").get(kind, row.name) as { n: number }).n,
            ),
            createdAt: Number(row.created_at),
            updatedAt: Number(row.updated_at),
            pins: this.#pins(kind, row.name),
            path: this.pathOf(kind, row.name),
        };
    }

    /** Every item, skills first, by name. */
    list(): LibraryItem[] {
        return (this.#db.prepare("SELECT * FROM pocket_library_items ORDER BY kind DESC, name").all() as ItemRow[]).map((row) => this.#item(row));
    }

    item(kind: LibraryKind, name: string): LibraryItem {
        return this.#item(this.#need(kind, name));
    }

    /** The current version's files. */
    files(kind: LibraryKind, name: string): LibraryFiles {
        return this.versionFiles(kind, name, Number(this.#need(kind, name).current));
    }

    /** The kept versions, newest first. */
    versions(kind: LibraryKind, name: string): LibraryVersion[] {
        this.#need(kind, name);

        return (this.#db.prepare("SELECT n, at, note, bytes, files FROM pocket_library_versions WHERE kind = ? AND name = ? ORDER BY n DESC").all(kind, name) as LibraryVersion[]).map(
            ({ n, at, note, bytes, files }) => ({ n: Number(n), at: Number(at), note, bytes: Number(bytes), files: Number(files) }),
        );
    }

    /** A kept version's files. */
    versionFiles(kind: LibraryKind, name: string, n: number): LibraryFiles {
        const kept = this.versions(kind, name);

        if (!kept.some((version) => version.n === n)) {
            throw new HttpError(404, `${name} has no version ${n}: it has ${kept.map((version) => version.n).join(", ")}.`);
        }

        return readFolder(join(this.#versionsDir(kind, name), String(n)));
    }

    /**
     * Save an item's files as its next version, which becomes current: a new item, or a new version of one. `files` come
     * checked by `libraryFiles`.
     */
    save(kind: LibraryKind, name: string, files: LibraryFiles, note = ""): LibraryItem {
        const { description, argumentHint } = described(kind, name, files);
        const row = this.#row(kind, name);
        const dir = this.#versionsDir(kind, name);
        // One past the newest, in the database or left on disk by a save that stopped before it was recorded.
        const onDisk = existsSync(dir) ? readdirSync(dir).filter((each) => /^\d+$/.test(each)).map(Number) : [];
        const recorded = row === undefined ? [] : this.versions(kind, name).map((version) => version.n);
        const n = Math.max(0, ...onDisk, ...recorded) + 1;
        const at = this.#now();
        const bytes = Object.values(files).reduce((sum, text) => sum + Buffer.byteLength(text), 0);

        rmSync(join(dir, String(n)), { recursive: true, force: true });
        writeFolder(join(dir, String(n)), files);
        this.#makeCurrent(kind, name, files);
        this.#write(() => {
            this.#db
                .prepare(
                    `INSERT INTO pocket_library_items (kind, name, current, description, argument_hint, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT (kind, name) DO UPDATE SET current = excluded.current, description = excluded.description,
                     argument_hint = excluded.argument_hint, updated_at = excluded.updated_at`,
                )
                .run(kind, name, n, description, argumentHint ?? null, at, at);
            this.#db
                .prepare("INSERT INTO pocket_library_versions (kind, name, n, at, note, bytes, files) VALUES (?, ?, ?, ?, ?, ?, ?)")
                .run(kind, name, n, at, note.trim().slice(0, NOTE_MAX), bytes, Object.keys(files).length);
        });
        this.#prune(kind, name, n);
        this.#revision++;

        return this.item(kind, name);
    }

    /** Make a kept version current again: its files back at the current place. */
    restore(kind: LibraryKind, name: string, n: number): LibraryItem {
        const files = this.versionFiles(kind, name, n);
        const { description, argumentHint } = described(kind, name, files);

        this.#makeCurrent(kind, name, files);
        this.#db
            .prepare("UPDATE pocket_library_items SET current = ?, description = ?, argument_hint = ?, updated_at = ? WHERE kind = ? AND name = ?")
            .run(n, description, argumentHint ?? null, this.#now(), kind, name);
        this.#revision++;

        return this.item(kind, name);
    }

    /** Back to the version before the current one. */
    undo(kind: LibraryKind, name: string): LibraryItem {
        const current = Number(this.#need(kind, name).current);
        const before = this.versions(kind, name).find((version) => version.n < current);

        if (before === undefined) {
            throw new HttpError(409, `${name} is at its first kept version: there is nothing to undo.`);
        }

        return this.restore(kind, name, before.n);
    }

    /** Delete an item: its files, its versions, and its pins. */
    remove(kind: LibraryKind, name: string): void {
        this.#need(kind, name);
        this.#write(() => {
            for (const table of ["pocket_library_items", "pocket_library_versions", "pocket_library_pins"]) {
                this.#db.prepare(`DELETE FROM ${table} WHERE kind = ? AND name = ?`).run(kind, name);
            }
        });
        rmSync(kind === "skill" ? this.skillFolder(name) : this.pathOf(kind, name), { recursive: true, force: true });
        rmSync(this.#versionsDir(kind, name), { recursive: true, force: true });
        this.#revision++;
    }

    /** Pin an item (`pinned`) or take a pin away; its pins after. */
    setPin(kind: LibraryKind, name: string, pin: LibraryPin, pinned: boolean): LibraryPin[] {
        this.#need(kind, name);

        if (pinned) {
            this.#db
                .prepare("INSERT OR IGNORE INTO pocket_library_pins (kind, name, scope, target, at) VALUES (?, ?, ?, ?, ?)")
                .run(kind, name, pin.scope, pin.target, this.#now());
        } else {
            this.#db.prepare("DELETE FROM pocket_library_pins WHERE kind = ? AND name = ? AND scope = ? AND target = ?").run(kind, name, pin.scope, pin.target);
        }

        this.#revision++;

        return this.#pins(kind, name);
    }

    /**
     * The items a conversation has: pinned to it or a session up its subagent chain, to its board, or to every session;
     * each once, with the first pin that gives it (session, board, every session), by name within each kind.
     */
    pinned(place: PinPlace): PinnedItem[] {
        const rank = (pin: LibraryPin): number | undefined =>
            pin.scope === "session" ? (place.sessions.includes(pin.target) ? 0 : undefined) : pin.scope === "board" ? (pin.target === place.board ? 1 : undefined) : 2;
        const rows = this.#db.prepare("SELECT kind, name, scope, target FROM pocket_library_pins ORDER BY kind DESC, name").all() as (LibraryPin & { kind: LibraryKind; name: string })[];
        const found = new Map<string, { item: PinnedItem; rank: number }>();

        for (const { kind, name, scope, target } of rows) {
            const pin = { scope, target };
            const at = rank(pin);
            const key = `${kind} ${name}`;
            const had = found.get(key);

            if (at !== undefined && (had === undefined || at < had.rank)) {
                found.set(key, { item: { kind, name, path: this.pathOf(kind, name), pin }, rank: at });
            }
        }

        return [...found.values()].map(({ item }) => item);
    }

    /** The current files at the place sessions read them: written beside it, then swapped in. */
    #makeCurrent(kind: LibraryKind, name: string, files: LibraryFiles): void {
        if (kind === "command") {
            const path = this.pathOf(kind, name);
            const next = join(dirname(path), `.${name}.md.next`);

            mkdirSync(dirname(path), { recursive: true });
            writeFileSync(next, files[`${name}.md`]!);
            renameSync(next, path);

            return;
        }

        const folder = this.skillFolder(name);
        const next = join(dirname(folder), `.${name}.next`);
        const old = join(dirname(folder), `.${name}.old`);

        rmSync(next, { recursive: true, force: true });
        rmSync(old, { recursive: true, force: true });
        writeFolder(next, files);

        if (existsSync(folder)) {
            renameSync(folder, old);
        }

        renameSync(next, folder);
        rmSync(old, { recursive: true, force: true });
    }

    /** Past `LIBRARY_KEEP_VERSIONS`, the oldest go (never the current one, `keep`). */
    #prune(kind: LibraryKind, name: string, keep: number): void {
        const kept = this.versions(kind, name);
        const current = Number(this.#need(kind, name).current);

        for (const version of kept.slice(LIBRARY_KEEP_VERSIONS).filter((each) => each.n !== keep && each.n !== current)) {
            this.#db.prepare("DELETE FROM pocket_library_versions WHERE kind = ? AND name = ? AND n = ?").run(kind, name, version.n);
            rmSync(join(this.#versionsDir(kind, name), String(version.n)), { recursive: true, force: true });
        }
    }

    #write(change: () => void): void {
        this.#db.exec("BEGIN IMMEDIATE");

        try {
            change();
            this.#db.exec("COMMIT");
        } catch (error) {
            this.#db.exec("ROLLBACK");

            throw error;
        }
    }
}
