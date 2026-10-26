// Installing a drop-in through the app (PP-173): on the phone the drop-in folder is the app's private storage, so a
// module comes in as an upload in Settings › Extensions or with `extension_install` after the owner's card. Both read it
// with the same checks (`drop-in-install.ts`): no path out of the folder, no symbolic link, at most 5 MB, one module,
// never a built-in module's name, and a drop-in replaced only when the owner says so. It lands switched off.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { crc32, deflateRawSync } from "node:zlib";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { MAX_DROP_IN_BYTES, packageFromPath, packageFromUpload, readZip } from "../src/server/drop-in-install.ts";
import { HttpError } from "../src/server/errors.ts";
import { createHandler } from "../src/server/http.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

type Entry = { name: string; data?: string | Buffer; mode?: number; deflate?: boolean };

/** A zip file, made here so its names and modes can be whatever a test needs (an attacker's, say). */
function zip(entries: Entry[]): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;

    for (const entry of entries) {
        const data = Buffer.from(entry.data ?? "");
        const packed = entry.deflate === true ? deflateRawSync(data) : data;
        const name = Buffer.from(entry.name, "utf8");
        const local = Buffer.alloc(30);

        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(entry.deflate === true ? 8 : 0, 8);
        local.writeUInt32LE(crc32(data), 14);
        local.writeUInt32LE(packed.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(name.length, 26);

        const central = Buffer.alloc(46);

        central.writeUInt32LE(0x02014b50, 0);
        // Made on Unix, so the mode in the external attributes counts.
        central.writeUInt16LE((3 << 8) | 20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(entry.deflate === true ? 8 : 0, 10);
        central.writeUInt32LE(crc32(data), 16);
        central.writeUInt32LE(packed.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);

        locals.push(local, name, packed);
        centrals.push(central, name);
        offset += local.length + name.length + packed.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);

    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);

    return Buffer.concat([...locals, directory, end]);
}

const MODULE = `/** Tiny: a drop-in for tests. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export default () =>
    defineExtension({
        name: "tiny",
        tools: [defineTool({ name: "tiny_hello", description: "Say hello.", parameters: Type.Object({}), execute: async () => ({ output: [{ type: "text", text: "hello" }] }) })],
    });
`;

const source = join(root, "sources");
const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`tool said: ${text}`)]);
    }

    const install = /install (\S+)$/.exec(text);

    return install === null
        ? fauxAssistantMessage([fauxText(`echo: ${text}`)])
        : fauxAssistantMessage([fauxToolCall("extension_install", { path: install[1]! } as never)], { stopReason: "toolUse" });
};

let app: App;
let server: Server;
let base = "";

before(async () => {
    mkdirSync(source, { recursive: true });
    app = await openApp(scriptedModel(route), dataDir);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const refused = (pattern: RegExp) => (error: unknown) => error instanceof HttpError && pattern.test(error.message);

test("a zip's paths stay inside the extension, and it holds no symbolic link", () => {
    for (const name of ["../evil.ts", "tiny/../../evil.ts", "/etc/evil.ts", "tiny\\evil.ts", "C:/evil.ts", "tiny//x.js"]) {
        assert.throws(() => readZip(zip([{ name: "tiny.ts", data: MODULE }, { name, data: "x" }])), refused(/not a path inside the extension/), name);
    }

    assert.throws(() => readZip(zip([{ name: "tiny.ts", data: MODULE }, { name: "tiny/link", data: "/etc/passwd", mode: 0o120777 }])), refused(/symbolic link/));
    assert.throws(() => readZip(Buffer.from("not a zip at all, just words")), refused(/not a zip file/));
});

test("an extension is at most 5 MB, given or unpacked", () => {
    const big = Buffer.alloc(MAX_DROP_IN_BYTES + 1, 0x61);

    assert.throws(() => packageFromUpload("tiny.ts", big), refused(/larger than 5 MB/));
    // Small as a zip, too large unpacked.
    assert.throws(() => readZip(zip([{ name: "tiny.ts", data: big, deflate: true }])), refused(/larger than 5 MB/));
});

test("a package is one module at its top and what belongs to it; a zipped folder is read from inside", () => {
    const pkg = packageFromUpload(
        "pi-tiny.zip",
        zip([
            { name: "pi-tiny/tiny.ts", data: MODULE, deflate: true },
            { name: "pi-tiny/tiny.js", data: "export default () => {};" },
            { name: "pi-tiny/tiny/store.ts", data: "export const x = 1;" },
            { name: "pi-tiny/LICENSE", data: "MIT" },
            { name: "pi-tiny/docs/a.png", data: "png" },
        ]),
    );

    assert.equal(pkg.module, "tiny.ts");
    assert.deepEqual(pkg.files.map((file) => file.path), ["tiny.js", "tiny/store.ts", "tiny.ts"], "the module last");
    assert.deepEqual(pkg.leftOut, ["LICENSE", "docs/"]);
    assert.equal(pkg.files.at(-1)!.data.toString(), MODULE);

    assert.throws(() => packageFromUpload("two.zip", zip([{ name: "a.ts", data: "x" }, { name: "b.ts", data: "y" }])), refused(/2 modules/));
    assert.throws(() => packageFromUpload("none.zip", zip([{ name: "README.md", data: "x" }])), refused(/holds no module/));
    assert.throws(() => packageFromUpload("tiny.js", Buffer.from("x")), refused(/Put both in a \.zip/));
    assert.throws(() => packageFromUpload("bad name.ts", Buffer.from("x")), refused(/not a module's name/));
});

test("a folder is read as a zip is, and a symbolic link in it is refused", () => {
    const folder = join(source, "folder-module");

    mkdirSync(join(folder, "tiny"), { recursive: true });
    writeFileSync(join(folder, "tiny.ts"), MODULE);
    writeFileSync(join(folder, "tiny", "data.json"), "{}");
    writeFileSync(join(folder, "README.md"), "read me");
    assert.deepEqual(packageFromPath(folder).files.map((file) => file.path), ["tiny/data.json", "tiny.ts"]);

    symlinkSync("/etc/passwd", join(folder, "tiny", "secrets"));
    assert.throws(() => packageFromPath(folder), refused(/symbolic link/));
});

test("installing: never a built-in module's name, a drop-in replaced only when asked, and it lands switched off", async () => {
    const me = owner(app);

    await assert.rejects(app.installDropIn(me, packageFromUpload("secrets.ts", Buffer.from(MODULE)), true), refused(/built-in module's name/));

    const tiny = packageFromUpload("tiny.ts", Buffer.from(MODULE));

    assert.deepEqual(await app.installDropIn(me, tiny, false), { file: "tiny.ts", installed: true, replaces: [] });
    assert.equal(readFileSync(join(dropIns, "tiny.ts"), "utf8"), MODULE);
    assert.equal(app.loader.list().find((each) => each.file === "tiny.ts")?.enabled, false);

    // On, then given again: nothing is written until the owner says replace, and then it is off again, uninstalled.
    await app.setExtensionEnabled(me, "tiny.ts", true);
    assert.ok(app.loader.extensionNames().includes("tiny"));

    const again = packageFromUpload("tiny.ts", Buffer.from(MODULE.replace("hello", "hello again")));

    assert.deepEqual(await app.installDropIn(me, again, false), { file: "tiny.ts", installed: false, replaces: ["tiny.ts"] });
    assert.equal(readFileSync(join(dropIns, "tiny.ts"), "utf8"), MODULE);
    assert.equal((await app.installDropIn(me, again, true)).installed, true);
    assert.match(readFileSync(join(dropIns, "tiny.ts"), "utf8"), /hello again/);
    assert.equal(app.loader.list().find((each) => each.file === "tiny.ts")?.enabled, false);
    assert.ok(!app.loader.extensionNames().includes("tiny"), "the old version went when it was switched off");

    const guest = app.config.addUser("Gina", "guest").user;

    await assert.rejects(app.installDropIn(guest, tiny, true), (error) => error instanceof HttpError && error.status === 403);
});

test("the upload route is the owner's", async () => {
    const { token } = app.config.addUser("Gil", "guest");
    const upload = (bearer: string, name: string, body: Buffer, replace = false) =>
        fetch(`${base}/api/extensions/drop-ins?name=${encodeURIComponent(name)}${replace ? "&replace=1" : ""}`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "x-pocket": "1", "content-type": "application/octet-stream" },
            body: new Uint8Array(body),
        });
    const zipped = zip([{ name: "uploaded.ts", data: MODULE.replace('"tiny"', '"uploaded"').replace("tiny_hello", "uploaded_hello"), deflate: true }]);

    assert.equal((await upload(token, "uploaded.zip", zipped)).status, 403);
    assert.equal(existsSync(join(dropIns, "uploaded.ts")), false);

    const response = await upload(app.config.ownerToken, "uploaded.zip", zipped);
    const result = (await response.json()) as { installed: boolean; file: string; modules: { file: string; enabled: boolean }[] };

    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.installed, true);
    assert.equal(result.modules.find((each) => each.file === "uploaded.ts")?.enabled, false, "it lands off, in the list the sheet shows");

    // Given again: the sheet is told what it would replace, and asks.
    const second = (await (await upload(app.config.ownerToken, "uploaded.zip", zipped)).json()) as { installed: boolean; replaces: string[] };

    assert.deepEqual({ installed: second.installed, replaces: second.replaces }, { installed: false, replaces: ["uploaded.ts"] });
    assert.equal((await upload(app.config.ownerToken, "evil.zip", zip([{ name: "../evil.ts", data: "x" }]))).status, 400);
});

async function turn(id: ConversationId, text: string, as = owner(app)) {
    const { submissionId } = await app.commands.submit(id, as, { text, requestId: crypto.randomUUID() });

    return submissionId;
}

const lastAnswer = async (id: ConversationId) =>
    JSON.stringify((await app.transcripts.allEntries(id, true)).filter((entry) => entry.kind === "assistant").at(-1));

test("extension_install asks the owner on a card first: declined copies nothing, approved lands off, a guest is refused", async () => {
    assert.ok(BUILT_IN_TOOLS.has("extension_install"));

    const folder = join(source, "carded");

    mkdirSync(join(folder, "carded"), { recursive: true });
    writeFileSync(join(folder, "carded.ts"), MODULE.replace('"tiny"', '"carded"').replace("tiny_hello", "carded_hello"));
    writeFileSync(join(folder, "carded", "notes.txt"), "notes");
    writeFileSync(join(folder, "LICENSE"), "MIT");

    const id = await newSession(app);
    const first = await turn(id, `please install ${folder}`);

    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    const [card] = app.approvals.forConversation(id);
    const form = card!.form;

    assert.equal(form?.type, "extension");
    assert.ok(form?.type === "extension");
    assert.equal(form.module, "carded.ts");
    assert.deepEqual(form.files, ["carded/notes.txt", "carded.ts"]);
    assert.deepEqual(form.leftOut, ["LICENSE"]);
    assert.match(form.head, /Tiny: a drop-in for tests/);
    // A plain Allow is the Install button here, but only the owner's.
    const guest = app.config.addUser("Gus", "guest").user;

    await assert.rejects(app.answerApproval(card!.id, true, guest), (error) => error instanceof HttpError && error.status === 403);
    assert.equal(await app.answerApproval(card!.id, false, owner(app)), true);
    await (await app.harness.submission(first, context))!.wait(context);
    await until(async () => (await lastAnswer(id)).includes("nothing was installed"), "the decline");
    assert.equal(existsSync(join(dropIns, "carded.ts")), false);

    const second = await turn(id, `please install ${folder}`);

    await until(() => app.approvals.forConversation(id).length === 1, "the second card");
    assert.equal(await app.answerApproval(app.approvals.forConversation(id)[0]!.id, true, owner(app)), true);
    await (await app.harness.submission(second, context))!.wait(context);
    await until(async () => (await lastAnswer(id)).includes("Installed carded.ts"), "the install");
    assert.match(await lastAnswer(id), /setting_change extensions\.carded\.ts on/);
    assert.ok(existsSync(join(dropIns, "carded", "notes.txt")));
    assert.equal(existsSync(join(dropIns, "LICENSE")), false);
    assert.equal(app.loader.list().find((each) => each.file === "carded.ts")?.enabled, false);

    // Asked by a guest, nobody is asked at all.
    const theirs = await turn(id, `please install ${folder}`, guest);

    await (await app.harness.submission(theirs, context))!.wait(context);
    await until(async () => (await lastAnswer(id)).includes("extension_install is the owner's"), "the refusal");
    assert.equal(app.approvals.forConversation(id).length, 0);
});
