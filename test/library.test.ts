// The owner's library of skills and commands (PP-466): versions and undo, pins to a session, a board and every session,
// what a session loads and which of a name wins, commands with arguments, and the API.
import { type App, cleanUp, home, lastText, modelTexts, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { APP_ROOT } from "../src/server/config.ts";
import { createHandler } from "../src/server/http.ts";
import { Library, LIBRARY_KEEP_VERSIONS, libraryFiles } from "../src/server/library.ts";
import { Projects } from "../src/server/projects.ts";

/** The skills section as the newest request has it (a change comes as a system message of its own). */
let skillsNow = "";

const route: FauxResponseStep = (context) => {
    const sections = (context.messages as { role: string; sections?: Record<string, string> }[])
        .filter((message) => message.role === "system")
        .map((message) => message.sections ?? {});

    skillsNow = sections.findLast((each) => each.skills !== undefined)?.skills ?? "";

    return fauxAssistantMessage([fauxText(`echo: ${lastText(context as never).text}`)]);
};

const dataDir = join(root, "library-data");
let app: App | undefined;
const started = async () => (app ??= await openApp(scriptedModel(route, { contextWindow: 1_000_000 }), dataDir));

after(async () => {
    await app?.close();
    cleanUp();
});

const skillMd = (name: string, description = `The ${name} skill.`, body = `The steps of ${name}.`) =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;

test("a save keeps a version; undo and restore move between them; names, front matter and files are checked", () => {
    const folder = mkdtempSync(join(root, "library-unit-"));
    let clock = 1000;
    const library = new Library(folder, { now: () => clock++ });

    try {
        const first = library.save("skill", "ssp", libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("ssp", "First."), "scripts/run.sh": "echo 1\n" } }), "made");

        assert.equal(first.version, 1);
        assert.equal(first.description, "First.");
        assert.equal(first.path, join(folder, "library", "skills", "ssp", "SKILL.md"));
        assert.match(readFileSync(first.path, "utf8"), /First\./);
        assert.ok((statSync(join(folder, "library", "skills", "ssp", "scripts", "run.sh")).mode & 0o111) !== 0, "its scripts can run");

        const second = library.save("skill", "ssp", libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("ssp", "Second.") } }), "reworded");

        assert.equal(second.version, 2);
        assert.match(readFileSync(second.path, "utf8"), /Second\./, "at the same path");
        assert.ok(!existsSync(join(folder, "library", "skills", "ssp", "scripts")), "a file the new version has not is gone");
        assert.deepEqual(
            library.versions("skill", "ssp").map(({ n, note, files }) => ({ n, note, files })),
            [
                { n: 2, note: "reworded", files: 1 },
                { n: 1, note: "made", files: 2 },
            ],
        );

        // Undo: back to version 1, its files at the current place again; nothing to undo past the first.
        const undone = library.undo("skill", "ssp");

        assert.equal(undone.version, 1);
        assert.equal(undone.description, "First.");
        assert.equal(readFileSync(join(folder, "library", "skills", "ssp", "scripts", "run.sh"), "utf8"), "echo 1\n");
        assert.throws(() => library.undo("skill", "ssp"), /first kept version/);

        // Restore goes forward again; a save after it is one past the newest.
        assert.equal(library.restore("skill", "ssp", 2).description, "Second.");
        assert.equal(library.save("skill", "ssp", libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("ssp", "Third.") } })).version, 3);
        assert.match(library.versionFiles("skill", "ssp", 1)["SKILL.md"]!, /First\./);
        assert.throws(() => library.versionFiles("skill", "ssp", 9), /no version 9/);

        // Names by the Agent Skills rule; SKILL.md must name it so and describe it; files are text at safe paths.
        for (const name of ["SSP", "ssp--x", "-ssp", "x".repeat(65), "a_b"]) {
            assert.throws(() => libraryFiles("skill", name, { files: { "SKILL.md": skillMd(name) } }), /valid name|at most/, name);
        }

        assert.throws(() => libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("other") } }), /must say name: ssp/);
        assert.throws(() => libraryFiles("skill", "ssp", { files: { "SKILL.md": "---\nname: ssp\n---\nBody\n" } }), /needs a description/);
        assert.throws(() => libraryFiles("skill", "ssp", { files: { "README.md": "x" } }), /needs a SKILL\.md/);
        assert.throws(() => libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("ssp"), "../x": "x" } }), /not a file name/);
        assert.throws(() => libraryFiles("skill", "ssp", { files: { "SKILL.md": skillMd("ssp"), ".hidden": "x" } }), /not a file name/);
        assert.throws(() => libraryFiles("command", "go", { content: "No front matter." }), /needs a description/);

        // A kind of its own: a command may share a skill's name.
        const command = library.save("command", "ssp", libraryFiles("command", "ssp", { content: "---\ndescription: Review.\nargument-hint: <task>\n---\nReview $ARGUMENTS.\n" }));

        assert.equal(command.path, join(folder, "library", "commands", "ssp.md"));
        assert.equal(command.argumentHint, "<task>");
        assert.deepEqual(library.list().map(({ kind, name }) => `${kind} ${name}`), ["skill ssp", "command ssp"]);

        // Only so many versions are kept, never the current one.
        for (let at = 0; at < LIBRARY_KEEP_VERSIONS + 2; at++) {
            library.save("command", "ssp", libraryFiles("command", "ssp", { content: `---\ndescription: Review ${at}.\n---\nReview.\n` }));
        }

        const kept = library.versions("command", "ssp");

        assert.equal(kept.length, LIBRARY_KEEP_VERSIONS);
        assert.equal(kept[0]!.n, LIBRARY_KEEP_VERSIONS + 3);
        assert.ok(!existsSync(join(folder, "library", ".versions", "command", "ssp", "1")), "the oldest's files go too");

        // Delete: its files, versions and pins.
        library.setPin("skill", "ssp", { scope: "all", target: "" }, true);
        library.remove("skill", "ssp");
        assert.ok(!existsSync(join(folder, "library", "skills", "ssp")));
        assert.ok(!existsSync(join(folder, "library", ".versions", "skill", "ssp")));
        assert.deepEqual(library.pinned({ sessions: ["1"] }).map(({ kind, name }) => `${kind} ${name}`), []);
    } finally {
        library.close();
    }
});

test("a skill pinned to a session is in its prompt and /skill: commands from its next request, and gone after unpin; other sessions never see it", async () => {
    const app = await started();
    const me = owner(app);

    app.librarySave(me, "skill", "ssp-notes", { files: { "SKILL.md": skillMd("ssp-notes", "How to write SSP notes.") } }, "made");
    const id = await newSession(app);
    const other = await newSession(app);

    await say(app, id, "before");
    assert.doesNotMatch(skillsNow, /ssp-notes/, "unpinned: never there");

    app.librarySetPin(me, "skill", "ssp-notes", "session", String(id), true);
    await say(app, id, "after");
    assert.match(skillsNow, /<name>ssp-notes<\/name>/);
    assert.ok(skillsNow.includes(join(dataDir, "library", "skills", "ssp-notes", "SKILL.md")));
    assert.ok(app.skillCommands(id).some((each) => each.name === "ssp-notes"));
    await say(app, id, "/skill:ssp-notes write one");
    assert.match((await modelTexts(app, id)).join("\n"), /<skill name=\\"ssp-notes\\"/);

    await say(app, other, "elsewhere");
    assert.doesNotMatch(skillsNow, /ssp-notes/, "another session: not pinned there");
    assert.ok(!app.skillCommands(other).some((each) => each.name === "ssp-notes"));

    // Frozen (the default): an edit that only rewords it is not sent again; live sends it.
    app.librarySave(me, "skill", "ssp-notes", { files: { "SKILL.md": skillMd("ssp-notes", "Reworded.") } }, "reworded");
    await say(app, id, "frozen");
    assert.match(skillsNow, /How to write SSP notes\./);
    app.config.setContextPart("skills", "live");

    try {
        await say(app, id, "live");
        assert.match(skillsNow, /Reworded\./);
    } finally {
        app.config.setContextPart("skills", "frozen");
    }

    app.librarySetPin(me, "skill", "ssp-notes", "session", String(id), false);
    await say(app, id, "unpinned");
    assert.doesNotMatch(skillsNow, /ssp-notes/, "the names changed: sent again without it");
    assert.ok(!app.skillCommands(id).some((each) => each.name === "ssp-notes"));
});

test("pinned to a board, its sessions have it; pinned to every session, all the owner's do, a guest's none", async () => {
    const app = await started();
    const me = owner(app);
    const boards = new Projects(dataDir, () => app.config.users.map((user) => ({ id: user.id, name: user.name, role: user.role })));

    try {
        const actor = { kind: "person" as const, person: { id: me.id, name: me.name, role: me.role } };

        boards.create(actor, { key: "SSP", name: "SSP work" });
        app.librarySave(me, "skill", "board-skill", { files: { "SKILL.md": skillMd("board-skill") } }, "");
        app.librarySave(me, "skill", "every-skill", { files: { "SKILL.md": skillMd("every-skill") } }, "");
        assert.throws(() => app.librarySetPin(me, "skill", "board-skill", "board", "NOPE", true), /no board NOPE/);
        app.librarySetPin(me, "skill", "board-skill", "board", "SSP", true);

        const onBoard = await newSession(app);
        const offBoard = await newSession(app);

        boards.setBoardMode(actor, String(onBoard), true, "SSP");
        await say(app, onBoard, "on the board");
        assert.match(skillsNow, /<name>board-skill<\/name>/);
        assert.deepEqual(app.libraryPinned(onBoard).map(({ name, pin }) => `${name} ${pin.scope} ${pin.target}`), ["board-skill board SSP"]);
        await say(app, offBoard, "not on it");
        assert.doesNotMatch(skillsNow, /board-skill/);

        // Board mode off: no longer its board's.
        boards.setBoardMode(actor, String(onBoard), false, "SSP");
        await say(app, onBoard, "left the board");
        assert.doesNotMatch(skillsNow, /board-skill/);

        app.librarySetPin(me, "skill", "every-skill", "all", undefined, true);
        await say(app, offBoard, "every session");
        assert.match(skillsNow, /<name>every-skill<\/name>/);
        assert.deepEqual(
            app.libraryList(me).find((item) => item.name === "board-skill")!.pins,
            [{ scope: "board", target: "SSP", label: "SSP work" }],
        );

        // The library is the owner's: a session a guest started has none of it.
        const guest = app.config.addUser("Gus", "guest").user;
        const { id: theirs } = await app.commands.createSession(guest, {});

        assert.deepEqual(app.libraryPinned(theirs), []);
        assert.ok(!app.skillCommands(theirs).some((each) => each.name === "every-skill"));
        assert.throws(() => app.libraryList(guest), /the owner's/);
        app.librarySetPin(me, "skill", "every-skill", "all", undefined, false);
    } finally {
        boards.close();
    }
});

test("a name another place has: the owner's own skill wins over the library's, the library's over the app's", async () => {
    const app = await started();
    const me = owner(app);
    const project = realpathSync(mkdtempSync(join(root, "library-clash-")));
    const own = join(home, ".agents", "skills", "clash");

    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, "SKILL.md"), skillMd("clash", "The owner's own."));
    app.librarySave(me, "skill", "clash", { files: { "SKILL.md": skillMd("clash", "The library's.") } }, "");
    app.librarySave(me, "skill", "ui-verify", { files: { "SKILL.md": skillMd("ui-verify", "The library's ui-verify.") } }, "");
    const id = await newSession(app, project);

    app.librarySetPin(me, "skill", "clash", "session", String(id), true);
    app.librarySetPin(me, "skill", "ui-verify", "session", String(id), true);
    await say(app, id, "which wins");
    assert.match(skillsNow, /<name>clash<\/name>\s*<description>The owner&apos;s own\.<\/description>/);
    assert.match(skillsNow, /<name>ui-verify<\/name>\s*<description>The library&apos;s ui-verify\.<\/description>/);
    assert.ok(!skillsNow.includes(join(APP_ROOT, "src", "skills", "ui-verify")), "the app's own is shadowed");

    const view = app.sessionLibrary(me, id);

    assert.deepEqual(
        view.items.map(({ name, shadowedBy }) => ({ name, shadowedBy })),
        [
            { name: "clash", shadowedBy: join(own, "SKILL.md") },
            { name: "ui-verify", shadowedBy: undefined },
        ],
    );
});

test("a command pinned to a session: in its / list, filled with its arguments for the message box and when sent; the API is the owner's", async () => {
    const app = await started();
    const id = await newSession(app);
    const other = await newSession(app);
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Gil", "guest");
    const call = async (path: string, method = "GET", body?: unknown, token = app!.config.ownerToken) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };

    try {
        const content = "---\ndescription: Review an SSP task.\nargument-hint: <task> [focus]\n---\nReview task $1 for $ARGUMENTS.\n";
        const saved = await call("library/command/ssp-review", "PUT", { content, note: "made" });

        assert.equal(saved.status, 200, JSON.stringify(saved.body));
        assert.equal((await call("library/command/ssp-review", "PUT", { content: "nothing" })).status, 400);
        assert.equal((await call("library/command/ssp-review", "PUT", { content }, guest.token)).status, 403);
        assert.equal((await call("library", "GET", undefined, guest.token)).status, 403);

        // Not pinned: not in the list, and not filled.
        assert.ok(!((await call(`c/${id}/prompts`)).body as unknown as { name: string }[]).some((each) => each.name === "ssp-review"));
        assert.equal((await call(`c/${id}/library-command`, "POST", { text: "/ssp-review abc" })).status, 404);

        const pins = await call("library/command/ssp-review/pins", "PUT", { scope: "session", target: String(id), pinned: true });

        assert.equal(pins.status, 200);
        assert.equal((await call("library/command/ssp-review/pins", "PUT", { scope: "session", target: "999999", pinned: true })).status, 404);

        const listed = ((await call(`c/${id}/prompts`)).body as unknown as { name: string }[]).find((each) => each.name === "ssp-review");

        assert.deepEqual(listed, { name: "ssp-review", description: "Review an SSP task.", argumentHint: "<task> [focus]", library: true });
        assert.ok(!((await call(`c/${other}/prompts`)).body as unknown as { name: string }[]).some((each) => each.name === "ssp-review"));

        const filled = await call(`c/${id}/library-command`, "POST", { text: "/ssp-review PP-12 the pins" });

        assert.deepEqual(filled.body, { text: "Review task PP-12 for PP-12 the pins." });
        await say(app, id, "/ssp-review PP-7 tests");
        assert.match((await modelTexts(app, id)).join("\n"), /Review task PP-7 for PP-7 tests\./);

        // What the session has, by which pin; versions and undo through the API.
        const has = await call(`c/${id}/library`);

        assert.deepEqual(has.body, {
            owner: true,
            board: null,
            items: [{ kind: "command", name: "ssp-review", path: join(dataDir, "library", "commands", "ssp-review.md"), pin: { scope: "session", target: String(id) } }],
        });
        await call("library/command/ssp-review", "PUT", { content: content.replace("Review task", "Check task") });
        assert.deepEqual(((await call("library/command/ssp-review/versions")).body as { current: number }).current, 2);
        assert.equal(((await call("library/command/ssp-review/undo", "POST", {})).body.item as { version: number }).version, 1);
        assert.match(((await call("library/command/ssp-review")).body as { content: string }).content, /Review task \$1/);
        assert.equal(((await call("library/command/ssp-review/restore", "POST", { n: 2 })).body.item as { version: number }).version, 2);
        assert.match(((await call("library/command/ssp-review/versions/1")).body.files as Record<string, string>)["ssp-review.md"]!, /Review task/);
        assert.equal((await call("library/command/ssp-review", "DELETE")).status, 200);
        assert.ok(!((await call(`c/${id}/prompts`)).body as unknown as { name: string }[]).some((each) => each.name === "ssp-review"), "deleted: gone from the list");
    } finally {
        server.close();
    }
});
