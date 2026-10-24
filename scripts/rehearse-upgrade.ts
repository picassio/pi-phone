/**
 * Rehearse Pi Durable 1.4's one-way storage upgrade on a real backup (PP-134), without starting pi-phone: nothing
 * resumes, no model is asked, no message goes out. It unpacks the backup into a temporary folder, reads every table of
 * `pocket.sqlite`, makes the safety copy as the app does (`storage-upgrade.ts`), opens the storage with Pi Durable 1.4
 * (which upgrades it), and reads every table again. Every table must read the same after as before (the schema version
 * aside), and the copy the same as the database before. Then the temporary folder is removed.
 *
 *   node scripts/rehearse-upgrade.ts <pi-phone-backup.tar.gz> [--keep]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DATABASE, SAFETY_COPY, safetyCopyBeforeUpgrade } from "../src/server/storage-upgrade.ts";

type Digest = Record<string, { rows: number; sha256: string }>;

/** Every table's row count and a hash of its rows in key order. */
function digest(file: string): Digest {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        const tables = database
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .all() as { name: string }[];
        const result: Digest = {};

        for (const { name } of tables) {
            const quoted = `"${name.replaceAll('"', '""')}"`;
            let rows: unknown[];

            try {
                rows = database.prepare(`SELECT * FROM ${quoted} ORDER BY rowid`).all();
            } catch {
                // A table without rowid: by its columns in order.
                rows = database.prepare(`SELECT * FROM ${quoted} ORDER BY 1, 2`).all();
            }

            const hash = createHash("sha256");

            for (const row of rows) {
                hash.update(JSON.stringify(row, (_key, value: unknown) => (typeof value === "bigint" ? String(value) : value)));
                hash.update("\n");
            }

            result[name] = { rows: rows.length, sha256: hash.digest("hex") };
        }

        return result;
    } finally {
        database.close();
    }
}

function schemaVersion(file: string): number | undefined {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        return (database.prepare("SELECT version FROM durable_schema").get() as { version: number } | undefined)?.version;
    } finally {
        database.close();
    }
}

function taskStatuses(file: string): Record<string, number> {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        const rows = database.prepare("SELECT status, count(*) AS n FROM tasks GROUP BY status ORDER BY status").all() as {
            status: string;
            n: number;
        }[];

        return Object.fromEntries(rows.map((row) => [row.status, row.n]));
    } finally {
        database.close();
    }
}

function integrity(file: string): string {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        return (database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
    } finally {
        database.close();
    }
}

/** Tables whose digests differ, but for the schema version's own table. */
function differences(a: Digest, b: Digest): string[] {
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);

    return [...names].filter(
        (name) => name !== "durable_schema" && (a[name]?.rows !== b[name]?.rows || a[name]?.sha256 !== b[name]?.sha256),
    );
}

const [archive, ...flags] = process.argv.slice(2);

if (archive === undefined || !existsSync(archive)) {
    console.error("Usage: node scripts/rehearse-upgrade.ts <pi-phone-backup.tar.gz> [--keep]");
    process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "pi-phone-rehearsal-"));
let failed = false;

try {
    execFileSync("tar", ["-xzf", archive, "-C", work, ".pi-pocket/pocket.sqlite"]);
    const dataDir = join(work, ".pi-pocket");
    const file = join(dataDir, DATABASE);
    const started = Date.now();

    const beforeVersion = schemaVersion(file);
    const before = digest(file);
    const beforeTasks = taskStatuses(file);
    const copied = await safetyCopyBeforeUpgrade(dataDir);
    const copyMs = Date.now() - started;
    const opening = Date.now();
    const storage = await openNodeSqliteStorage(file);

    await storage.close(BACKGROUND_CONTEXT);
    const upgradeMs = Date.now() - opening;
    const after = digest(file);
    const copy = digest(join(dataDir, SAFETY_COPY));
    const changed = differences(before, after);
    const copyChanged = differences(before, copy);
    const report = {
        bytes: statSync(file).size,
        schema: { before: beforeVersion, after: schemaVersion(file), copy: schemaVersion(join(dataDir, SAFETY_COPY)) },
        safetyCopy: copied,
        copyMs,
        upgradeMs,
        integrity: { database: integrity(file), copy: integrity(join(dataDir, SAFETY_COPY)) },
        rows: Object.fromEntries(Object.entries(before).map(([name, each]) => [name, each.rows])),
        tasks: { before: beforeTasks, after: taskStatuses(file) },
        tablesChangedByUpgrade: changed,
        tablesDifferentInCopy: copyChanged,
    };

    failed =
        changed.length > 0 ||
        copyChanged.length > 0 ||
        report.schema.after !== 2 ||
        report.integrity.database !== "ok" ||
        report.integrity.copy !== "ok" ||
        (beforeVersion !== undefined && beforeVersion < 2 && !copied.made);
    console.log(JSON.stringify(report, null, 2));
    console.log(failed ? "REHEARSAL FAILED" : "REHEARSAL PASSED");
} finally {
    if (!flags.includes("--keep")) {
        rmSync(work, { recursive: true, force: true });
    } else {
        console.log(`Kept ${work}`);
    }
}

process.exit(failed ? 1 : 0);
