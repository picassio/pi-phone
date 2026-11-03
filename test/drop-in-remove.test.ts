// Removing a drop-in (PP-372): before it pi-phone had only Add drop-in and the switch, and Pi must never delete the
// app's data files itself. Now the owner removes one in Settings › Extensions (DELETE /api/extensions/<file>), or Pi
// asks with app_action extensions.remove on the owner's card: it is switched off and unloaded, its <name>.ts, <name>.js
// and <name>/ are deleted, and its data in extension-data/<name>/ stays unless data is on. Guests are refused; a built-in
// module is never removed.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createHandler } from "../src/server/http.ts";
import { appSettings } from "../src/server/settings-registry.ts";

const dataDir = join(root, "remove-data");
const dropIns = join(dataDir, "extensions");
const kept = join(dataDir, "extension-data");

/** A drop-in with a browser part and a folder, and data of its own in extension-data. */
function dropIn(name: string): void {
    mkdirSync(join(dropIns, name), { recursive: true });
    writeFileSync(join(dropIns, `${name}.ts`), `/** ${name}: a drop-in to remove. */\nexport default (_host: unknown, web: { client(entry: string): void }) => {\n    web.client("${name}.js");\n};\n`);
    writeFileSync(join(dropIns, `${name}.js`), "export default () => {};\n");
    writeFileSync(join(dropIns, name, "notes.txt"), "kept with it");
    mkdirSync(join(kept, name), { recursive: true });
    writeFileSync(join(kept, name, "state.json"), "{}");
}

const asks: Record<string, Record<string, unknown>> = {
    "remove water": { id: "extensions.remove", args: { file: "water.ts" }, reason: "The owner asked" },
    "remove bucket with its data": { id: "extensions.remove", args: { file: "bucket", data: "on" }, reason: "The owner asked" },
    "remove nothing named": { id: "extensions.remove", args: {}, reason: "x" },
    "remove artifacts": { id: "extensions.remove", args: { file: "artifacts.ts" }, reason: "x" },
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, args] of Object.entries(asks)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall("app_action", args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let server: Server;
let base = "";
let session: ConversationId;

before(async () => {
    for (const name of ["water", "bucket", "lamp", "kettle"]) {
        dropIn(name);
    }

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

/** Ask Pi; answer the card it raises, if any; what the tool told Pi. */
async function turn(text: string, allow?: boolean): Promise<string> {
    const { submissionId } = await app.commands.submit(session, owner(app), { text, requestId: crypto.randomUUID() });

    if (allow !== undefined) {
        await until(() => app.approvals.forConversation(session).length > 0, "the card");

        const [card] = app.approvals.forConversation(session);

        assert.equal(card!.tool, "app_action");
        cards.push(card!.subject);
        await app.answerApproval(card!.id, allow, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, session)).at(-1)!;
}

const cards: string[] = [];
const files = (name: string) => [`${name}.ts`, `${name}.js`, name].filter((each) => existsSync(join(dropIns, each)));
const remove = (file: string, token: string, data = false) =>
    fetch(`${base}/api/extensions/${file}${data ? "?data=1" : ""}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, "x-pocket": "1" } });

test("only the owner removes a drop-in: a guest is refused, in the app and over the API, and nothing goes", async () => {
    const guest = app.config.addUser("Gus", "guest");

    await assert.rejects(app.removeDropIn(guest.user, "water.ts"), { status: 403 });
    assert.equal((await remove("water.ts", guest.token)).status, 403);
    assert.deepEqual(files("water"), ["water.ts", "water.js", "water"]);
});

test("Pi asks on a card first; declined, it stays; allowed, it is off, unloaded, its files gone and its data kept, and Pi is told where", async () => {
    await app.setExtensionEnabled(owner(app), "water.ts", true);
    assert.equal(app.loader.enabled("water.ts"), true);
    assert.match(await turn("please remove water", false), /said no: nothing was done/);
    assert.deepEqual(files("water"), ["water.ts", "water.js", "water"]);
    assert.match(cards.at(-1)!, /^Remove the drop-in water\.ts: switch it off and delete its files; its data in extension-data stays$/);

    const told = await turn("please remove water", true);

    assert.match(told, /Removed water\.ts: water\.js, water\.ts, water\/\. Its data is kept in .*extension-data\/water: extensions\.remove with data on deletes it\./);
    assert.deepEqual(files("water"), []);
    assert.equal(app.loader.list().some((each) => each.file === "water.ts"), false, "unloaded and gone from the list");
    assert.equal(app.webs.clients(owner(app)).some((each) => each.module === "water"), false, "its browser part too");
    assert.deepEqual(readdirSync(join(kept, "water")), ["state.json"]);
    // The rest of the drop-in folder is untouched.
    assert.deepEqual(files("bucket"), ["bucket.ts", "bucket.js", "bucket"]);
});

test("data on deletes its data too; data can be left out but the file cannot; built-in modules are never removed", async () => {
    assert.match(await turn("please remove bucket with its data", true), /Removed bucket\.ts: .*Its data in .*extension-data\/bucket was deleted too\./);
    assert.match(cards.at(-1)!, /and its data in extension-data$/);
    assert.equal(existsSync(join(kept, "bucket")), false);
    assert.deepEqual(files("bucket"), []);
    assert.match(await turn("please remove nothing named"), /extensions\.remove needs file/);
    assert.match(await turn("please remove artifacts", true), /There is no drop-in artifacts\.ts/);
    assert.ok(app.loader.list().some((each) => each.file === "artifacts.ts" && each.enabled));
});

test("the owner's Remove (Settings › Extensions): the module goes from the list, its data stays unless asked", async () => {
    let answer = await remove("lamp.ts", app.config.ownerToken);
    let body = (await answer.json()) as { file: string; removed: string[]; data: { kept: boolean; folder: string }; modules: { file: string }[] };

    assert.equal(answer.status, 200);
    assert.deepEqual(body.removed, ["lamp.js", "lamp.ts", "lamp/"]);
    assert.equal(body.data.kept, true);
    assert.ok(!body.modules.some((each) => each.file === "lamp.ts"));
    assert.ok(existsSync(join(kept, "lamp", "state.json")));

    answer = await remove("kettle.ts", app.config.ownerToken, true);
    body = (await answer.json()) as typeof body;
    assert.equal(body.data.kept, false);
    assert.equal(existsSync(join(kept, "kettle")), false);
    assert.equal((await remove("kettle.ts", app.config.ownerToken)).status, 404, "nothing left to remove");
});

test("settings lists extensions.remove with its optional data", async () => {
    const { actions } = appSettings(app);
    const action = actions.find((each) => each.id === "extensions.remove");

    assert.equal(action?.owner, true);
    assert.deepEqual(Object.keys(action?.args ?? {}), ["file", "data"]);
    assert.deepEqual(action?.optional, ["data"]);
});
