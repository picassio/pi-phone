// The owner's drop-in extensions (PP-171; the owner's decisions of 2026-10-26): modules in the data folder's
// `extensions`, each off until turned on. A drop-in whose tool has a built-in tool's name is refused whole, and one that
// adds nothing (pi-pocket's browser modules, which look for `host.browser`) is refused saying why. pi-pocket's gallery
// modules (fixtures at fixed commits, test/fixtures/gallery) show both; a drop-in of our own uses host.ask, host.hide
// and host.commandEnv.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { HttpError } from "../src/server/errors.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

const SECRET = "drop-in-secret-value";
const dataDir = join(root, "data");
const dropIns = join(dataDir, "extensions");
const gallery = join(import.meta.dirname, "fixtures", "gallery");
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = (name: string, args: Record<string, unknown>) =>
        fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText(`ok: ${text}`)]);
    }

    if (text.endsWith("use the drop token")) {
        return call("bash", { command: 'printf "%s" "$DROP_TOKEN"; echo; printf "%s" "$DROP_TOKEN" | wc -c' });
    }

    if (text.endsWith("sign in with the drop-in")) {
        return call("drop_sign_in", {});
    }

    if (text.endsWith("write a drop-in")) {
        return call("write", { path: join(dropIns, "sneaky.ts"), content: "export default () => {};\n" });
    }

    if (text.endsWith("copy a drop-in in")) {
        return call("bash", { command: `echo 'export default () => {};' > ${join(dropIns, "sneaky.ts")}` });
    }

    return fauxAssistantMessage([fauxText(`echo: ${text}`)]);
};

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    // As the gallery installs them: the module, and the folder beside it that it uses.
    cpSync(join(gallery, "pi-pocket-secrets", "secrets.ts"), join(dropIns, "secrets.ts"));
    cpSync(join(gallery, "pi-pocket-secrets", "secrets"), join(dropIns, "secrets"), { recursive: true });
    // The same module under a name of its own, so its tools are what it is refused for.
    cpSync(join(gallery, "pi-pocket-secrets", "secrets.ts"), join(dropIns, "gallery-secrets.ts"));

    for (const [folder, name] of [
        ["pi-pocket-browser-sign-in", "browser-sign-in"],
        ["pi-pocket-browser-runs", "browser-runs"],
    ]) {
        for (const ending of [".ts", ".js"]) {
            cpSync(join(gallery, folder!, `${name}${ending}`), join(dropIns, `${name}${ending}`));
        }
    }

    writeFileSync(
        join(dropIns, "points.ts"),
        `/** Points: a drop-in that uses host.ask, host.hide and host.commandEnv, for tests. */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const pocketApi = 2;

export default (host, web) => {
    web.onDispose(host.hide({ value: ${JSON.stringify(SECRET)}, label: "secret DROP_TOKEN" }));
    web.onDispose(
        host.commandEnv(({ command }) =>
            typeof command === "string" && command.includes("$DROP_TOKEN") ? { DROP_TOKEN: ${JSON.stringify(SECRET)} } : undefined,
        ),
    );

    const signIn = defineTool({
        name: "drop_sign_in",
        description: "Sign in, with the person's values.",
        parameters: Type.Object({}),
        execute: async (_args, api, context) => {
            const answer = await host.ask(
                {
                    conversationId: api.conversationId,
                    id: api.taskId + ":" + api.callId,
                    taskId: api.taskId,
                    callId: api.callId,
                    title: "Sign in to drop.test",
                    fields: [{ name: "password", label: "Password", secret: true }],
                },
                context,
            );

            if (!answer.answered) {
                throw new Error(answer.by + " declined");
            }

            return { output: [{ type: "text", text: "filled " + answer.values.password.length }] };
        },
    });

    return defineExtension({ name: "drop-points", tools: [signIn] });
};
`,
    );
    app = await openApp(scriptedModel(route), dataDir);
});

after(async () => {
    await app?.close();
    cleanUp();
});

const stored = async (id: ConversationId) => JSON.stringify(await app.transcripts.allEntries(id, true));
const module = (file: string) => app.loader.list().find((each) => each.file === file);

test("the drop-in folder is the app's, its modules off until turned on, and one named like a built-in is never loaded", async () => {
    const listed = await app.extensions(owner(app));

    assert.equal(listed.dropIns, dropIns);
    assert.deepEqual(listed.nameClashes, [{ file: "secrets.ts", path: join(dropIns, "secrets.ts") }]);
    assert.equal(module("secrets.ts")?.source, "built-in", "the built-in Secrets stays");

    for (const file of ["gallery-secrets.ts", "browser-sign-in.ts", "browser-runs.ts", "points.ts"]) {
        assert.equal(module(file)?.source, "drop-in", file);
        assert.equal(module(file)?.enabled, false, file);
    }

    // Drop-ins import the packages the server runs.
    assert.equal(realpathSync(join(dropIns, "node_modules")), realpathSync(join(import.meta.dirname, "..", "node_modules")));
});

test("the gallery's secrets is refused whole: its tools have built-in tools' names", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "gallery-secrets.ts", true),
        (error) => error instanceof HttpError && error.status === 409 && /refused: its tools secrets_list, secret_request, secret_save/.test(error.message),
    );
    assert.deepEqual(module("gallery-secrets.ts")?.refused, { kind: "tool-names", names: ["secrets_list", "secret_request", "secret_save"] });
    assert.ok(!app.loader.extensionNames().includes("secrets"), "nothing of it is installed");
    assert.deepEqual(module("secrets.ts")?.extensions.flatMap((each) => each.tools), ["secrets_list", "secret_request", "secret_save"]);
});

test("the gallery's browser modules are refused: they look for host.browser, which pi-phone does not have", async () => {
    for (const file of ["browser-sign-in.ts", "browser-runs.ts"]) {
        await assert.rejects(
            app.setExtensionEnabled(owner(app), file, true),
            (error) => error instanceof HttpError && error.status === 409 && /it needs host\.browser, which pi-phone does not have yet/.test(error.message),
        );
        assert.deepEqual(module(file)?.refused, { kind: "nothing", missing: ["browser"] }, file);
    }

    // pi-phone's own browser tools are still its own.
    assert.ok(module("browser.ts")?.extensions.some((each) => each.tools.includes("browser_sign_in")));
});

test("a drop-in of the owner's uses host.ask, host.hide and host.commandEnv", async () => {
    await app.setExtensionEnabled(owner(app), "points.ts", true);
    assert.equal(module("points.ts")?.error, undefined);
    assert.deepEqual(module("points.ts")?.extensions.flatMap((each) => each.tools), ["drop_sign_in"]);

    // Its variable reaches bash, and its value is hidden in what comes back.
    const id = await newSession(app);

    await app.commands.submit(id, owner(app), { text: "please use the drop token", requestId: crypto.randomUUID() });
    await until(async () => (await stored(id)).includes("ok: "), "the answer");
    assert.match(await stored(id), /\[secret DROP_TOKEN\]\\n20\\n/);
    assert.doesNotMatch(await stored(id), new RegExp(SECRET));

    // Its tool runs, and asks the owner on a card; what they type reaches the tool alone.
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "please sign in with the drop-in", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(id).length === 1, "the card");
    const [card] = app.approvals.forConversation(id);

    assert.equal(card!.form?.type, "ask");
    assert.equal(await app.answerAsk(card!.id, { password: "correct-horse" }, owner(app)), true);
    await (await app.harness.submission(submissionId, context))!.wait(context);
    await until(async () => (await stored(id)).includes("ok: filled 13"), "the tool's answer");
    assert.doesNotMatch(await stored(id), /correct-horse/);

    // Turned off, what it hid and added goes with it.
    await app.setExtensionEnabled(owner(app), "points.ts", false);
    assert.equal(app.secrets.redact(SECRET, id), SECRET);
    assert.equal(app.commandEnvs.any, false);
});

test("Pi's tools do not put files in the drop-in folder: only the owner does", async () => {
    const id = await newSession(app);

    for (const ask of ["please write a drop-in", "please copy a drop-in in"]) {
        const { submissionId } = await app.commands.submit(id, owner(app), { text: ask, requestId: crypto.randomUUID() });

        await (await app.harness.submission(submissionId, context))!.wait(context);
    }

    const results = async () =>
        (await app.transcripts.allEntries(id, true)).filter((entry) => entry.kind === "toolResult").map((entry) => JSON.stringify(entry));

    await until(async () => (await results()).length === 2, "both results");

    for (const result of await results()) {
        assert.match(result, /the owner's to put in place/);
    }

    assert.equal(existsSync(join(dropIns, "sneaky.ts")), false);
});

test("the built-in tool names cover every tool the built-in modules install", async () => {
    // The ones off by default too.
    for (const each of app.loader.list().filter((one) => one.source === "built-in" && !one.enabled)) {
        await app.setExtensionEnabled(owner(app), each.file, true);
    }

    const installed = app.loader
        .list()
        .filter((each) => each.source === "built-in")
        .flatMap((each) => each.extensions.flatMap((extension) => extension.tools));

    assert.ok(installed.length > 50, installed.join(", "));
    assert.deepEqual(
        installed.filter((name) => !BUILT_IN_TOOLS.has(name)),
        [],
        "BUILT_IN_TOOLS in reload.ts lacks these",
    );
    assert.ok(existsSync(dropIns));
});
