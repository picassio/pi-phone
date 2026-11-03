// The Creator flow (PP-369; the owner's decisions of 2026-11-03 on the mockup pp366-mockup): Pi asks on a card before it
// makes a drop-in (extension_create), a subagent writes made-<name> and ends READY, extension_made checks it without
// running it and installs it on the owner's card, switched off, keeping each version; the owner switches it on; Keep,
// Undo and Restore. Names under made- are the Creator's alone, and the checks refuse what is not one clean module.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DEFERRED_TOOLS } from "../src/server/deferred-tools.ts";
import { packageFromPath } from "../src/server/drop-in-install.ts";
import { BUILDER_TEMPLATES } from "../src/server/extension-builder.ts";
import { createHandler } from "../src/server/http.ts";
import { checkMade, MADE_KEEP_VERSIONS, MadeDropIns, type MadeState, nameProblem, parseReady } from "../src/server/made-drop-ins.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

/** A made drop-in's folder that passes the checks: the focus-timer template, as made-<name>. */
function goodFolder(folder: string, name: string, extra = ""): void {
    mkdirSync(folder, { recursive: true });

    for (const ending of [".ts", ".js"]) {
        const text = readFileSync(join(BUILDER_TEMPLATES, "focus-timer", `focus-timer${ending}`), "utf8").replaceAll("focus-timer", `made-${name}`);

        writeFileSync(join(folder, `made-${name}${ending}`), ending === ".js" ? `${text}${extra}` : text);
    }
}

// ---- Names, the ready line, the checks, versions ---------------------------------------------------------------

test("a made drop-in's name: lowercase words with hyphens, never another extension's, unless it is this one's next version", () => {
    for (const bad of ["Clock", "9lives", "a--b", "trailing-", "", "x".repeat(41), "under_score"]) {
        assert.match(nameProblem(bad, [], false) ?? "", /is not a name for a drop-in Pi makes/, bad);
    }

    assert.equal(nameProblem("clock", ["artifacts.ts", "clock.ts"], false), undefined);
    assert.match(nameProblem("clock", ["made-clock.ts"], false) ?? "", /made-clock is taken by an extension Pi did not make here/);
    assert.equal(nameProblem("clock", ["made-clock.ts"], true), undefined, "its next version");
});

test("the subagent's last line says READY or NOT READY for this drop-in, and nothing else counts", () => {
    assert.deepEqual(parseReady("Done, all checks ok.\n\nREADY made-clock: first build\n", "made-clock"), { ready: true, note: "first build" });
    assert.deepEqual(parseReady("`READY made-clock: with a dock`", "made-clock"), { ready: true, note: "with a dock" });
    assert.deepEqual(parseReady("**NOT READY made-clock: no timer API**", "made-clock"), { ready: false, note: "no timer API" });
    assert.equal(parseReady("READY made-other: oops", "made-clock"), undefined);
    assert.equal(parseReady("READY made-clock: first\nthen I kept talking", "made-clock"), undefined, "the last line only");
    assert.equal(parseReady("", "made-clock"), undefined);
});

test("the checks pass one clean module, and refuse what is more, links, built-in tool names, the wrong name, size, and the skill's own problems", () => {
    const base = mkdtempSync(join(root, "made-checks-"));
    const tools = new Set(BUILT_IN_TOOLS);
    const folder = (name: string) => join(base, name, "made-clock");

    goodFolder(folder("good"), "clock");

    const good = checkMade(folder("good"), "clock", tools);

    assert.equal(good.checks.ok, true, good.checks.problems.join("\n"));
    assert.deepEqual(good.checks.files.sort(), ["made-clock.js", "made-clock.ts"]);
    assert.equal(good.pkg?.module, "made-clock.ts");

    goodFolder(folder("extra"), "clock");
    writeFileSync(join(folder("extra"), "README.md"), "notes");
    assert.match(checkMade(folder("extra"), "clock", tools).checks.problems.join("\n"), /it holds more than the module, its \.js and its folder: README\.md/);

    goodFolder(folder("link"), "clock");
    mkdirSync(join(folder("link"), "made-clock"));
    symlinkSync("/etc/hostname", join(folder("link"), "made-clock", "out.js"));
    assert.match(checkMade(folder("link"), "clock", tools).checks.problems.join("\n"), /made-clock\/out\.js is a symbolic link/);

    goodFolder(folder("tools"), "clock");
    writeFileSync(
        join(folder("tools"), "made-clock.ts"),
        'import { Type } from "@earendil-works/pi-ai";\nimport { defineExtension, defineTool } from "@earendil-works/pi-durable";\nexport const pocketApi = 2;\nconst t = defineTool({ name: "bash", description: "x", parameters: Type.Object({}), execute: async () => ({ output: [] }) });\nexport default () => defineExtension({ name: "made-clock", tools: [t] });\n',
    );
    rmSync(join(folder("tools"), "made-clock.js"));
    assert.match(checkMade(folder("tools"), "clock", tools).checks.problems.join("\n"), /its tools bash have built-in tools' names/);

    goodFolder(folder("named"), "watch");
    assert.match(checkMade(folder("named"), "clock", tools).checks.problems.join("\n"), /its module is made-watch\.ts: it must be made-clock\.ts/);

    goodFolder(folder("big"), "clock", `\n// ${"x".repeat(1100 * 1024)}\n`);
    assert.match(checkMade(folder("big"), "clock", tools).checks.problems.join("\n"), /KB: a drop-in Pi makes holds 1 MB at most/);

    goodFolder(folder("emoji"), "clock", '\nexport const label = "Done \u2705";\n');
    assert.match(checkMade(folder("emoji"), "clock", tools).checks.problems.join("\n"), /made-clock\.js: an emoji or dingbat/);

    assert.match(checkMade(join(base, "none"), "clock", tools).checks.problems.join("\n"), /there is nothing at/);
});

test("versions: each install kept with its note; Undo goes back one, then removes it; Restore installs a kept one; the newest 20 stay", async () => {
    const drop = mkdtempSync(join(root, "made-versions-"));
    const store = new MadeDropIns(drop);
    const done: string[] = [];
    const hands = {
        install: async (pkg: ReturnType<typeof packageFromPath>) => {
            done.push(`install ${pkg.files.find((file) => file.path.endsWith(".js"))!.data.toString("utf8").match(/version (\d+)/)?.[1]}`);
        },
        remove: async (file: string) => {
            done.push(`remove ${file}`);
        },
    };
    const state: MadeState = store.save({
        name: "clock",
        module: "made-clock",
        title: "Clock",
        brief: "A clock.",
        places: ["rail"],
        session: 1,
        folder: join(drop, "src"),
        phase: "installed",
        build: { n: 1 },
        versions: [],
        current: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
    });

    for (const n of [1, 2]) {
        goodFolder(state.folder, "clock", `\n// version ${n}\n`);
        state.current = store.keep(state, packageFromPath(state.folder), n === 1 ? "first build" : "bigger digits").n;
    }

    store.save(state);
    assert.deepEqual(state.versions.map((version) => [version.n, version.note]), [[1, "first build"], [2, "bigger digits"]]);
    assert.ok(readFileSync(join(drop, ".versions", "made-clock", "2", "files", "made-clock.js"), "utf8").includes("version 2"));
    assert.equal(JSON.parse(readFileSync(join(drop, ".versions", "made-clock", "1", "version.json"), "utf8")).note, "first build");

    let after = await store.undo(store.get("clock")!, hands);

    assert.equal(after.current, 1);
    after = await store.undo(after, hands);
    assert.equal(after.current, null);
    assert.equal(after.phase, "removed");
    await assert.rejects(store.undo(after, hands), /is not installed now: restore one of its versions instead/);
    after = await store.restore(after, 2, hands);
    assert.equal(after.current, 2);
    await assert.rejects(store.restore(after, 7, hands), /made-clock has no version 7: it has 1, 2/);
    assert.deepEqual(done, ["install 1", "remove made-clock.ts", "install 2"]);
    assert.deepEqual(store.list().map((each) => each.module), ["made-clock"]);

    // Past the bound the oldest go, never the one installed now.
    const kept = store.get("clock")!;

    kept.current = 1;

    for (let n = 0; n < MADE_KEEP_VERSIONS + 3; n++) {
        store.keep(kept, packageFromPath(state.folder), `build ${n}`);
    }

    assert.equal(kept.versions.length, MADE_KEEP_VERSIONS);
    assert.ok(kept.versions.some((version) => version.n === 1), "the installed one stays");
    assert.equal(existsSync(join(drop, ".versions", "made-clock", "2")), false, "the oldest other went");
});

test("the Creator's tools are built-in tool names, loaded with tool_search", () => {
    for (const tool of ["extension_create", "extension_made"]) {
        assert.ok(BUILT_IN_TOOLS.has(tool), tool);
        assert.ok(DEFERRED_TOOLS.includes(tool), tool);
    }
});

// ---- The flow in a running app -----------------------------------------------------------------------------------

const dataDir = join(root, "creator-data");
const calls: Record<string, [string, Record<string, unknown>]> = {
    "make a clock": ["extension_create", { name: "clock", title: "Clock", brief: "A rail page with a clock that counts focus rounds.", places: ["rail", "page"] }],
    "make it bigger": ["extension_create", { name: "clock", title: "Clock", brief: "Bigger digits.", places: ["rail", "page"] }],
    "make an artifacts": ["extension_create", { name: "BAD name", title: "X", brief: "x", places: ["rail"] }],
    "install the clock": ["extension_made", { action: "install", name: "clock" }],
    "the clock is checked": ["extension_made", { action: "checked", name: "clock", note: "the rail opens the page; nothing spills at 390 px" }],
    "undo the clock": ["extension_made", { action: "undo", name: "made-clock" }],
    "restore clock 2": ["extension_made", { action: "restore", name: "clock", version: 2 }],
    "list them": ["extension_made", { action: "list" }],
    "install a made one by hand": ["extension_install", { path: join(work, ".made", "made-clock") }],
};
/** What the clock's subagent ends its answer with, next. */
let ready = "READY made-clock: first build";
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    // The subagent: it was asked to make or change made-clock.
    if (role === "user" && text.includes("pi-phone drop-in made-clock")) {
        return fauxAssistantMessage([fauxText(`I wrote it and the check says ok.\n\n${ready}`)]);
    }

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let base = "";
let session: ConversationId;
const scratch = join(work, ".made", "made-clock");
const dropIns = join(dataDir, "extensions");

before(async () => {
    app = await openApp(scriptedModel(route), dataDir);
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

/** A message's text, from what the model sees of it. */
const plain = (content: string) => {
    const parsed = JSON.parse(content) as string | { type: string; text?: string }[];

    return typeof parsed === "string" ? parsed : parsed.map((part) => part.text ?? "").join("");
};

/**
 * Ask Pi; answer each card it raises with `answers` in turn; what Pi was told by the tool it called (a subagent's report
 * may come after it, and Pi answers that too).
 */
async function turn(text: string, answers: boolean[] = []): Promise<string> {
    const before = (await modelTexts(app, session)).length;
    const { submissionId } = await app.commands.submit(session, owner(app), { text, requestId: crypto.randomUUID() });

    for (const allow of answers) {
        await until(() => app.approvals.forConversation(session).length > 0, "a card");
        await app.answerApproval(app.approvals.forConversation(session)[0]!.id, allow, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const said = (await modelTexts(app, session)).slice(before).map(plain);

    return said.findLast((each) => each.startsWith("told: ")) ?? said.join("\n");
}

const made = () => JSON.parse(readFileSync(join(dropIns, ".versions", "made-clock", "made.json"), "utf8")) as MadeState;
const routeCall = (path: string, body?: unknown) =>
    fetch(`${base}/api/x/extension-builder/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as { made?: MadeState & { enabled: boolean }; error?: string } }));

test("Not now makes nothing; a bad name is refused before any card", async () => {
    assert.match(await turn("please make a clock", [false]), /said not now: nothing was made/);
    assert.equal(existsSync(join(dropIns, ".versions", "made-clock")), false);
    assert.equal(existsSync(scratch), false);
    assert.match(await turn("please make an artifacts"), /is not a name for a drop-in Pi makes/);
    assert.equal(app.approvals.forConversation(session).length, 0);
});

test("the card is the owner's: someone else who can steer cannot say Make it", async () => {
    const guest = app.config.addUser("Gus", "guest").user;
    const { submissionId } = await app.commands.submit(session, owner(app), { text: "please make a clock", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(session).length > 0, "the card");

    const [card] = app.approvals.forConversation(session);

    assert.deepEqual(card!.form, {
        type: "creator",
        module: "made-clock",
        title: "Clock",
        brief: "A rail page with a clock that counts focus rounds.",
        places: ["rail", "page"],
        next: false,
    });
    await assert.rejects(app.answerApproval(card!.id, true, guest), { status: 403 });
    await app.answerApproval(card!.id, false, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
});

test("Make it: the subagent made-clock writes it and says READY; install checks it and installs it on the owner's card, switched off, as version 1", async () => {
    goodFolder(scratch, "clock");
    assert.match(await turn("please make a clock", [true]), /The subagent made-clock is writing it in .*\.made\/made-clock/);

    let state = made();

    assert.equal(state.phase, "writing");
    assert.equal(state.session, Number(session));
    assert.equal(typeof state.subagent?.conversationId, "number");
    await until(async () => (await app.lastAnswer(state.subagent!.conversationId as never, true)).includes("READY made-clock"), "the subagent's answer");

    // The install card is extension_install's, from the scratch folder.
    const { submissionId } = await app.commands.submit(session, owner(app), { text: "please install the clock", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(session).length > 0, "the install card");

    const [card] = app.approvals.forConversation(session);

    assert.equal(card!.form?.type, "extension");
    assert.equal((card!.form as { module: string }).module, "made-clock.ts");
    assert.equal(made().build.checks?.ok, true);
    await app.answerApproval(card!.id, true, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
    assert.ok((await modelTexts(app, session)).map(plain).some((each) => /Installed made-clock version 1, switched off/.test(each)));

    state = made();
    assert.equal(state.phase, "installed");
    assert.equal(state.current, 1);
    assert.deepEqual(state.versions.map((version) => [version.n, version.note]), [[1, "first build"]]);
    assert.ok(existsSync(join(dropIns, "made-clock.ts")) && existsSync(join(dropIns, "made-clock.js")));
    assert.equal(app.loader.enabled("made-clock.ts"), false, "it lands off");
    assert.ok(existsSync(join(dropIns, ".versions", "made-clock", "1", "files", "made-clock.ts")));

    // Checked needs it on: the owner switches it on.
    assert.match(await turn("the clock is checked"), /made-clock is not switched on: the owner switches it on first/);
    await app.setExtensionEnabled(owner(app), "made-clock.ts", true);
    assert.equal(app.loader.list().find((each) => each.file === "made-clock.ts")?.error, undefined);
    assert.match(await turn("the clock is checked"), /made-clock version 1 is checked/);
    assert.equal(made().phase, "checked");
    assert.equal((await routeCall("made/clock")).body.made?.enabled, true);
});

test("a next version: the same name asks again, the subagent changes it, and install keeps version 2; the progress is in the routes", async () => {
    ready = "READY made-clock: bigger digits";
    goodFolder(scratch, "clock", "\n// bigger digits\n");
    assert.match(await turn("please make it bigger", [true]), /writing its next version/);
    assert.equal(made().build.n, 2);
    await until(async () => (await app.lastAnswer(made().subagent!.conversationId as never, true)).includes("bigger digits"), "its next answer");
    assert.match(await turn("please install the clock", [true]), /Installed made-clock version 2, switched off/);

    const listed = await routeCall("made");

    assert.equal(listed.status, 200);
    assert.deepEqual((listed.body as unknown as { made: MadeState[] }).made.map((each) => [each.module, each.current, each.versions.length]), [["made-clock", 2, 2]]);
    assert.match(await turn("please list them"), /made-clock \(Clock\): installed, version 2 installed, off; versions: 1 \(.*first build\); 2 \(.*bigger digits\)/);
});

test("Undo and Restore: the owner's buttons answer at once; Pi's ask on a card", async () => {
    // The owner's button: back to version 1.
    let answer = await routeCall("made/clock/undo", {});

    assert.equal(answer.status, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.made?.current, 1);
    assert.match(readFileSync(join(dropIns, "made-clock.js"), "utf8"), /version|focus/);
    assert.doesNotMatch(readFileSync(join(dropIns, "made-clock.js"), "utf8"), /bigger digits/);

    // Pi's undo asks; declined, nothing changes.
    assert.match(await turn("please undo the clock", [false]), /said no: made-clock stays at version 1/);
    // Allowed: version 1 was the first, so it goes, and its versions stay.
    assert.match(await turn("please undo the clock", [true]), /made-clock is removed; its versions are kept, to restore/);
    assert.equal(existsSync(join(dropIns, "made-clock.ts")), false);
    assert.equal(made().phase, "removed");
    assert.deepEqual(readdirSync(join(dropIns, ".versions", "made-clock")).sort(), ["1", "2", "made.json"]);

    // Restore 2 on Pi's card: back, switched off.
    assert.match(await turn("please restore clock 2", [true]), /made-clock is at version 2, switched off/);
    assert.match(readFileSync(join(dropIns, "made-clock.js"), "utf8"), /bigger digits/);
    assert.equal(app.loader.enabled("made-clock.ts"), false);

    answer = await routeCall("made/clock/restore", { version: 9 });
    assert.equal(answer.status, 400);
    assert.match(JSON.stringify(answer.body), /made-clock has no version 9/);
    answer = await routeCall("made/clock/keep", {});
    assert.equal(answer.body.made?.phase, "kept");
});

test("made- names are the Creator's: extension_install and the upload refuse them", async () => {
    assert.match(await turn("please install a made one by hand", [true]), /names starting with made- are for drop-ins Pi makes with extension_create/);

    const upload = await fetch(`${base}/api/extensions/drop-ins?name=made-other.ts`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/octet-stream" },
        body: "export default () => {};\n",
    });

    assert.equal(upload.status, 400);
    assert.match(await upload.text(), /names starting with made- are for drop-ins Pi makes/);
});
