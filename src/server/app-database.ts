/**
 * The app's own database (PP-382): boards (`projects.ts`) and SSH private keys (`ssh-keys.ts`) in `app.sqlite`, apart
 * from Pi Durable's `pocket.sqlite`.
 *
 * They were tables in `pocket.sqlite`, through connections of their own on the server's one thread. Pi Durable's write
 * transaction awaits between its statements (`BEGIN IMMEDIATE`, then one awaited statement after another, then
 * `COMMIT`), so other code runs in the middle of it. A board write that ran there asked for the file's write lock and
 * waited for it synchronously, with SQLite's busy timeout: the event loop stood still, so the transaction that held the
 * lock could never finish. After 5 s the write failed with "database is locked", and the whole server had stood still
 * that long. Pi Durable 1.5's transactions hold the lock over more awaits (21 microtask turns for a one-document commit
 * against 13 with 1.4) and commit more often, so board tools failed so in a row while sessions worked.
 *
 * In a file of their own, the app's writes never wait for Pi Durable's lock. Its connections are synchronous: each
 * transaction ends before another can start, so they never wait for each other across an await either.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** The app's own database, in the data folder. */
export const APP_DATABASE = "app.sqlite";
/** Pi Durable's storage, in the data folder. */
export const DURABLE_DATABASE = "pocket.sqlite";
/** The app's tables that lived in Pi Durable's file before PP-382: boards' and SSH keys'. */
const APP_TABLES = /^pocket_/;

/** A connection to the app's database in `dataDir` (or `file` there), in WAL mode, which other connections read beside. */
export function openAppDatabase(dataDir: string, file = APP_DATABASE): DatabaseSync {
    const database = new DatabaseSync(join(dataDir, file), { timeout: 5000 });

    database.exec("PRAGMA journal_mode = WAL");

    return database;
}

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * Move the app's tables out of Pi Durable's `pocket.sqlite` into `app.sqlite`: each made there as it was (its indexes
 * too) unless it is there, its rows copied (a row there already stays), then dropped from `pocket.sqlite`. Run as the app
 * starts, with the data folder's lock held and before Pi Durable opens its storage. Copying again finds the rows there,
 * so a start stopped between the copy and the drop finishes it the next time. Answers the tables it moved.
 */
export function moveAppTables(dataDir: string): string[] {
    if (!existsSync(join(dataDir, DURABLE_DATABASE))) {
        return [];
    }

    const database = openAppDatabase(dataDir);

    try {
        database.prepare("ATTACH DATABASE ? AS durable").run(join(dataDir, DURABLE_DATABASE));

        try {
            const tables = (database.prepare("SELECT name, sql FROM durable.sqlite_master WHERE type = 'table'").all() as { name: string; sql: string }[]).filter((table) =>
                APP_TABLES.test(table.name),
            );

            if (tables.length === 0) {
                return [];
            }

            const names = new Set(tables.map((table) => table.name));
            const indexes = (database.prepare("SELECT name, tbl_name, sql FROM durable.sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as { name: string; tbl_name: string; sql: string }[]).filter(
                (index) => names.has(index.tbl_name),
            );
            const inMain = (type: string, name: string) => database.prepare("SELECT 1 FROM main.sqlite_master WHERE type = ? AND name = ?").get(type, name) !== undefined;

            database.exec("BEGIN IMMEDIATE");

            try {
                for (const table of tables) {
                    if (!inMain("table", table.name)) {
                        // The statement that made it, as SQLite keeps it (with columns added since): made in main.
                        database.exec(table.sql);
                    }

                    const columns = (database.prepare(`PRAGMA durable.table_info(${quote(table.name)})`).all() as { name: string }[]).map((column) => quote(column.name)).join(", ");

                    database.exec(`INSERT OR IGNORE INTO main.${quote(table.name)} (${columns}) SELECT ${columns} FROM durable.${quote(table.name)}`);
                }

                for (const index of indexes) {
                    if (!inMain("index", index.name)) {
                        database.exec(index.sql);
                    }
                }

                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }

            // Kept in one place only: a private key deleted here must not stay in Pi Durable's file.
            database.exec("BEGIN IMMEDIATE");

            try {
                for (const table of tables) {
                    database.exec(`DROP TABLE durable.${quote(table.name)}`);
                }

                database.exec("COMMIT");
            } catch (error) {
                database.exec("ROLLBACK");

                throw error;
            }

            return [...names];
        } finally {
            database.exec("DETACH DATABASE durable");
        }
    } finally {
        database.close();
    }
}
