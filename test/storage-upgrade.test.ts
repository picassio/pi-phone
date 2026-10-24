// The safety copy before Pi Durable 1.4's one-way storage upgrade (PP-134): made and checked before the storage opens,
// never made over a database that is already upgraded or has no Pi Durable tables, removed after 14 days, and a start
// that cannot make a good one leaves the database as it was.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type TestContext, test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { SQLITE_MIGRATIONS, applySqliteMigrations } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase, openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { DATABASE, SAFETY_COPY, safetyCopyBeforeUpgrade } from "../src/server/storage-upgrade.ts";

function folder(t: TestContext): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-phone-upgrade-test-"));

    t.after(() => rmSync(dir, { recursive: true, force: true }));

    return dir;
}

/** A database as Pi Durable 1.3 left it: schema 1, with a row of its own to find in the copy. */
async function schemaOne(dir: string): Promise<string> {
    const file = join(dir, DATABASE);
    const database = await openNodeSqliteDatabase(file);

    try {
        await applySqliteMigrations(database, SQLITE_MIGRATIONS.slice(0, 1));
    } finally {
        await database.close();
    }

    const raw = new DatabaseSync(file);

    raw.exec("CREATE TABLE pocket_ssh_keys (name TEXT PRIMARY KEY, key TEXT); INSERT INTO pocket_ssh_keys VALUES ('k1', 'kept')");
    raw.close();

    return file;
}

function versionOf(file: string): number | undefined {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        return (database.prepare("SELECT version FROM durable_schema").get() as { version: number } | undefined)?.version;
    } finally {
        database.close();
    }
}

test("a schema 1 database is copied and checked before Pi 1.4 upgrades it, and the copy stays as it was", async (t) => {
    const dir = folder(t);
    const file = await schemaOne(dir);
    const made = await safetyCopyBeforeUpgrade(dir);

    assert.equal(made.made, true);
    // One file: nothing of it in a write-ahead log beside it, and nothing left of the partial copy.
    assert.deepEqual(
        readdirSync(dir).filter((name) => name.startsWith(SAFETY_COPY)),
        [SAFETY_COPY],
    );
    assert.equal(versionOf(join(dir, SAFETY_COPY)), 1);

    // Pi Durable 1.4 opens and upgrades it; the copy keeps schema 1, with the rows it had.
    const storage = await openNodeSqliteStorage(file);

    await storage.close(BACKGROUND_CONTEXT);
    assert.equal(versionOf(file), 2);
    assert.equal(versionOf(join(dir, SAFETY_COPY)), 1);
    const copy = new DatabaseSync(join(dir, SAFETY_COPY), { readOnly: true });

    assert.deepEqual({ ...(copy.prepare("SELECT key FROM pocket_ssh_keys").get() as object) }, { key: "kept" });
    copy.close();

    // Upgraded: no new copy, and this one stays until it is 14 days old.
    assert.deepEqual(await safetyCopyBeforeUpgrade(dir), { made: false });
    assert.equal(existsSync(join(dir, SAFETY_COPY)), true);
    const old = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);

    utimesSync(join(dir, SAFETY_COPY), old, old);
    assert.deepEqual(await safetyCopyBeforeUpgrade(dir), { made: false, removed: join(dir, SAFETY_COPY) });
    assert.equal(existsSync(join(dir, SAFETY_COPY)), false);
});

test("no database, or one without Pi Durable's tables, gets no copy", async (t) => {
    const dir = folder(t);

    assert.deepEqual(await safetyCopyBeforeUpgrade(dir), { made: false });
    const raw = new DatabaseSync(join(dir, DATABASE));

    raw.exec("CREATE TABLE pocket_ssh_keys (name TEXT PRIMARY KEY, key TEXT)");
    raw.close();
    assert.deepEqual(await safetyCopyBeforeUpgrade(dir), { made: false });
    assert.equal(existsSync(join(dir, SAFETY_COPY)), false);
});

test("without room for the copy, or when it cannot be written, nothing is upgraded and the reason is given", async (t) => {
    const dir = folder(t);
    const file = await schemaOne(dir);

    await assert.rejects(
        safetyCopyBeforeUpgrade(dir, { freeBytes: () => 1000 }),
        /did not upgrade its database for Pi 1\.4: its safety copy needs \d+ MB free, and the phone has 1 MB\. Your data is unchanged/,
    );
    assert.equal(existsSync(join(dir, SAFETY_COPY)), false);

    // A folder, not empty, where the copy goes: the checked copy cannot take its place.
    mkdirSync(join(dir, SAFETY_COPY, "x"), { recursive: true });
    await assert.rejects(safetyCopyBeforeUpgrade(dir), /its safety copy failed .*Your data is unchanged/);
    assert.equal(existsSync(join(dir, `${SAFETY_COPY}.partial`)), false);
    assert.equal(versionOf(file), 1);
});
