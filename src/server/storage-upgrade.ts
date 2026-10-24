/**
 * The safety copy before Pi Durable 1.4's one-way storage upgrade (PP-134, owner's decision of 2026-10-24). Pi Durable
 * 1.4 moves `pocket.sqlite` from schema 1 to 2 as the storage opens, and no older pi-phone can open it after. So before
 * that, on the first start of a pi-phone with 1.4, the database is copied whole (SQLite's own backup, consistent while
 * it is in use) to `pocket.sqlite.before-pi-1.4`, checked, and only then opened. No good copy, no upgrade: the start
 * stops with the reason, and the data stays as it was. The copy is kept 14 days, then removed at a start.
 */
import { existsSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";

export const DATABASE = "pocket.sqlite";
export const SAFETY_COPY = `${DATABASE}.before-pi-1.4`;
/** The schema Pi Durable 1.4 upgrades to; a database below it gets the copy first. */
const UPGRADED_SCHEMA = 2;
export const SAFETY_COPY_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The database's Pi Durable schema version: undefined when it has none (a new database, or only pi-phone's own tables). */
function schemaVersion(file: string): number | undefined {
    const database = new DatabaseSync(file, { readOnly: true, timeout: 5000 });

    try {
        const table = database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'")
            .get();

        if (table === undefined) {
            return undefined;
        }

        const row = database.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as
            | { version: number }
            | undefined;

        return row?.version;
    } finally {
        database.close();
    }
}

/** Bytes the database takes, with its write-ahead log. */
function databaseBytes(file: string): number {
    const wal = `${file}-wal`;

    return statSync(file).size + (existsSync(wal) ? statSync(wal).size : 0);
}

/**
 * Why a copy is not good, or undefined when it is: SQLite's own check, and the same schema as the database's. The copy
 * comes in the database's write-ahead-log mode; it leaves it first, so the copy is one file, with no `-wal` or `-shm`
 * beside it to lose when it is renamed.
 */
function copyFault(file: string, version: number): string | undefined {
    const database = new DatabaseSync(file);

    try {
        database.exec("PRAGMA journal_mode = DELETE");
        const check = database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;

        if (check?.quick_check !== "ok") {
            return `SQLite's check of the copy says: ${check?.quick_check ?? "nothing"}`;
        }
    } finally {
        database.close();
    }

    const copied = schemaVersion(file);

    return copied === version ? undefined : `the copy has schema ${String(copied)}, the database ${version}`;
}

export type SafetyCopyResult =
    | { made: false; removed?: string }
    | { made: true; file: string; bytes: number };

/**
 * Make the safety copy when the database is about to be upgraded, else remove one older than 14 days. Throws, with
 * what to do, when it cannot make a good copy: the caller must then not open the storage.
 */
export async function safetyCopyBeforeUpgrade(
    dataDir: string,
    { now = Date.now(), freeBytes = freeBytesOf }: { now?: number; freeBytes?: (dir: string) => number } = {},
): Promise<SafetyCopyResult> {
    const file = join(dataDir, DATABASE);
    const copy = join(dataDir, SAFETY_COPY);

    if (!existsSync(file)) {
        return { made: false };
    }

    const version = schemaVersion(file);

    if (version === undefined || version >= UPGRADED_SCHEMA) {
        if (existsSync(copy) && now - statSync(copy).mtimeMs > SAFETY_COPY_DAYS * DAY_MS) {
            rmSync(copy, { force: true });

            return { made: false, removed: copy };
        }

        return { made: false };
    }

    const bytes = databaseBytes(file);
    const free = freeBytes(dataDir);

    if (free < bytes * 2) {
        throw new Error(
            `pi-phone did not upgrade its database for Pi 1.4: its safety copy needs ${megabytes(bytes * 2)} free, and the phone has ${megabytes(free)}. Your data is unchanged. Free some space, then open pi-phone again.`,
        );
    }

    const partial = `${copy}.partial`;

    const sidecars = (path: string) => [path, `${path}-wal`, `${path}-shm`, `${path}-journal`];

    try {
        for (const each of sidecars(partial)) {
            rmSync(each, { force: true });
        }

        const database = new DatabaseSync(file, { readOnly: true, timeout: 5000 });

        try {
            await backup(database, partial);
        } finally {
            database.close();
        }

        const fault = copyFault(partial, version);

        if (fault !== undefined) {
            throw new Error(fault);
        }

        renameSync(partial, copy);
    } catch (error) {
        for (const each of sidecars(partial)) {
            rmSync(each, { force: true });
        }

        throw new Error(
            `pi-phone did not upgrade its database for Pi 1.4: its safety copy failed (${error instanceof Error ? error.message : String(error)}). Your data is unchanged.`,
        );
    }

    return { made: true, file: copy, bytes: statSync(copy).size };
}

/** The bytes free to this user on the folder's file system. */
function freeBytesOf(dir: string): number {
    const { bavail, bsize } = statfsSync(dir);

    return Number(bavail) * Number(bsize);
}

function megabytes(bytes: number): string {
    return `${Math.ceil(bytes / 1_000_000)} MB`;
}
