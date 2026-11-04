// A board write while Pi Durable commits (PP-382). The app's own tables (boards, SSH keys) and Pi Durable's storage were
// one SQLite file, with two connections on the server's one thread. Pi Durable's write transaction awaits between its
// statements; a board write that ran in one of those awaits waited for the file's lock synchronously, so the transaction
// that held it could never go on: the server stood still for the 5 s busy timeout, and the write failed with "database is
// locked". Pi 1.5 starts the tools of one answer while it still commits their starts: of 80 board tool calls made three
// at once, 56 failed so and took 286 s on one core (0 with Pi 1.4). Now the app's tables are in `app.sqlite`
// (`app-database.ts`), moved there as the app starts, and a tool's database error is logged.
import { cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NotesDoc } from "../src/server/docs.ts";
import { type Actor, type Person, Projects } from "../src/server/projects.ts";

const OWNER: Person = { id: "u-owner", name: "Owner", role: "owner" };
/** The files by name (as `app-database.ts` names them), so this file runs on the code before it too. */
const APP_DATABASE = "app.sqlite";
const DURABLE_DATABASE = "pocket.sqlite";
const as: Actor = { kind: "person", person: OWNER };

after(() => cleanUp());

/** The app's tables in a database file: those whose name starts with pocket_. */
function appTables(file: string): string[] {
    const database = new DatabaseSync(file, { readOnly: true });

    try {
        return (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'pocket\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[]).map((row) => row.name);
    } finally {
        database.close();
    }
}

test("a board write in the middle of Pi Durable's commit neither waits for it nor fails", async () => {
    const dataDir = join(root, "locks");
    const app = await openApp(scriptedModel(), dataDir);
    const projects = new Projects(dataDir, () => [OWNER]);

    try {
        projects.create(as, { key: "DB", name: "Locks" });
        const id = await newSession(app);
        let worst = 0;
        let failure: unknown;

        // Each commit is a SQL transaction that awaits between its statements: a write lands in it at some offset.
        for (let offset = 0; offset < 300 && failure === undefined; offset++) {
            const commit = app.harness.commit(async (tx) => {
                const notes = await tx.doc(NotesDoc, id);

                notes.text = `note ${offset}`;
                notes.rev += 1;
            }, context);

            for (let tick = 0; tick < offset; tick++) {
                await Promise.resolve();
            }

            const started = performance.now();

            try {
                projects.createTask(as, "DB", { title: `task ${offset}` });
            } catch (error) {
                failure = error;
            }

            worst = Math.max(worst, performance.now() - started);
            await commit;
        }

        assert.equal(failure, undefined, `a board write failed: ${String(failure)}`);
        assert.ok(worst < 1000, `a board write waited ${Math.round(worst)} ms`);
        const stored = new DatabaseSync(join(dataDir, APP_DATABASE), { readOnly: true });

        try {
            assert.equal((stored.prepare("SELECT count(*) AS n FROM pocket_tasks").get() as { n: number }).n, 300);
        } finally {
            stored.close();
        }
        assert.deepEqual(appTables(join(dataDir, DURABLE_DATABASE)), [], "none of the app's tables in Pi Durable's file");
    } finally {
        projects.close();
        await app.close();
    }
});

test("board tools that Pi calls several at once, as it does, neither fail nor wait (Pi 1.5 starts them inside its commit)", async () => {
    const dataDir = join(root, "parallel");
    const src = resolve(import.meta.dirname, "..", "src", "server", "projects.ts");

    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    // A board tool as the Projects extension's are: a synchronous write to the boards' database as it starts.
    writeFileSync(
        join(dataDir, "extensions", "boardy.ts"),
        `/** Boardy: comments on a board, as a board tool does. */
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Projects } from ${JSON.stringify(src)};

const ME = ${JSON.stringify(OWNER)};

export default (host) => {
    const projects = new Projects(host.dataDir, () => [ME]);

    return defineExtension({ name: "boardy", tools: [defineTool({
        name: "board_note",
        description: "Comment on BT-1.",
        parameters: { type: "object", properties: {} },
        execute: async () => {
            projects.comment({ kind: "person", person: ME }, "BT-1", "noted");

            return { output: [{ type: "text", text: "commented" }] };
        },
    })] });
};
`,
    );
    const app = await openApp(
        scriptedModel(
            (request) => {
                const calls = (request.messages as { role: string }[]).filter((message) => message.role === "toolResult").length;

                // As Pi updates a board: several calls in one answer, which run at once.
                return calls < 6
                    ? fauxAssistantMessage([fauxToolCall("board_note", {}), fauxToolCall("board_note", {}), fauxToolCall("board_note", {})], { stopReason: "toolUse" })
                    : fauxAssistantMessage([fauxText("done")]);
            },
            { contextWindow: 1_000_000 },
        ),
        dataDir,
    );
    const projects = new Projects(dataDir, () => [OWNER]);

    try {
        projects.create(as, { key: "BT", name: "Boardy" });
        projects.createTask(as, "BT", { title: "target" });
        await app.setExtensionEnabled(owner(app), "boardy.ts", true);
        const ids = await Promise.all([0, 1].map(() => newSession(app)));
        const started = performance.now();

        await Promise.all(ids.map((id) => say(app, id, "go")));
        const took = performance.now() - started;
        const locked = (await Promise.all(ids.map((id) => modelTexts(app, id)))).flat().filter((text) => text.includes("database is locked"));

        assert.deepEqual(locked, [], `${locked.length} board tool calls failed with "database is locked"`);
        assert.ok(took < 4000, `the calls took ${Math.round(took)} ms`);
        assert.equal(projects.task(as, "BT-1").comments.length, 12);
    } finally {
        projects.close();
        await app.close();
    }
});

test("boards and SSH keys move out of pocket.sqlite into app.sqlite as the app starts, once and whole", async () => {
    const dataDir = join(root, "moved");

    mkdirSync(dataDir, { recursive: true });
    // As a pi-phone before PP-382 left them: the boards and the keys in Pi Durable's file.
    const before = new Projects(dataDir, () => [OWNER], Date.now, DURABLE_DATABASE);

    before.create(as, { key: "MV", name: "Moved" });
    before.createTask(as, "MV", { title: "carried over" });
    before.close();
    const keys = new DatabaseSync(join(dataDir, DURABLE_DATABASE));

    keys.exec("CREATE TABLE pocket_ssh_keys (id TEXT PRIMARY KEY, private_key TEXT NOT NULL, created_at INTEGER NOT NULL) STRICT");
    keys.prepare("INSERT INTO pocket_ssh_keys VALUES (?, ?, ?)").run("k1", "PRIVATE", 1);
    keys.close();

    const lines: string[] = [];

    for (let start = 0; start < 2; start++) {
        const app = await openApp(scriptedModel(), dataDir, undefined, { log: (line: string) => lines.push(line) });

        await app.close();
    }

    assert.deepEqual(appTables(join(dataDir, DURABLE_DATABASE)), [], "dropped from Pi Durable's file");
    assert.ok(appTables(join(dataDir, APP_DATABASE)).includes("pocket_tasks"));
    assert.equal(lines.filter((line) => line.startsWith("Moved the app's tables")).length, 1, "once");
    const after = new Projects(dataDir, () => [OWNER]);

    try {
        assert.deepEqual(
            after.tasks(as, "MV").map((task) => task.title),
            ["carried over"],
        );
    } finally {
        after.close();
    }

    const moved = new DatabaseSync(join(dataDir, APP_DATABASE), { readOnly: true });

    try {
        assert.deepEqual(
            moved.prepare("SELECT id, private_key FROM pocket_ssh_keys").all().map((row) => ({ ...row })),
            [{ id: "k1", private_key: "PRIVATE" }],
        );
    } finally {
        moved.close();
    }
});

test("a tool that fails on a database says so in the server's log", async () => {
    const dataDir = join(root, "logged");
    const locked = join(root, "locked.sqlite");
    const holder = new DatabaseSync(locked);

    holder.exec("CREATE TABLE t (x)");
    mkdirSync(join(dataDir, "extensions"), { recursive: true });
    // A drop-in whose tool writes to a database another connection holds: SQLite's own "database is locked".
    writeFileSync(
        join(dataDir, "extensions", "writer.ts"),
        `/** Writer: writes to a locked database, for tests. */
import { DatabaseSync } from "node:sqlite";
import { obj } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () => defineExtension({ name: "writer", tools: [defineTool({
    name: "write_row",
    description: "Write a row.",
    parameters: obj({}),
    execute: async () => {
        const database = new DatabaseSync(${JSON.stringify(locked)}, { timeout: 0 });

        try {
            database.exec("INSERT INTO t VALUES (1)");
        } finally {
            database.close();
        }

        return { output: [{ type: "text", text: "written" }] };
    },
})] });
`,
    );
    const lines: string[] = [];
    const app = await openApp(
        scriptedModel((request) => {
            const { role, text } = lastText(request as never);

            return role === "user" && text.includes("write it")
                ? fauxAssistantMessage([fauxToolCall("write_row", {})], { stopReason: "toolUse" })
                : fauxAssistantMessage([fauxText("ok")]);
        }),
        dataDir,
        undefined,
        { log: (line: string) => lines.push(line) },
    );

    try {
        await app.setExtensionEnabled(owner(app), "writer.ts", true);
        const id = await newSession(app);

        holder.exec("BEGIN IMMEDIATE");
        await say(app, id, "write it");
        holder.exec("ROLLBACK");
        assert.ok(
            lines.some((line) => line.startsWith(`The tool write_row failed on a database in session ${String(id)}: `) && line.includes("database is locked")),
            lines.join("\n"),
        );
    } finally {
        holder.close();
        await app.close();
    }
});
