// Hooks (PP-419, src/server/hooks.ts): the checks the app runs around Pi's work by itself, each on or off. Pi lists them
// with settings and changes one with setting_change (hooks.<id>) after the owner's card; Settings › Hooks reads and
// changes them through /api/hooks, with the built-in behaviours beside them; only the owner changes them, and a hook
// that is not one is refused naming the hooks there are. The owner's choice is kept, a default is not written.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";

const calls: Record<string, [string, Record<string, unknown>]> = {
    "list hooks": ["settings", { area: "hooks" }],
    "reminder off": ["setting_change", { id: "hooks.uiReminder", value: "off", reason: "Too chatty for this work" }],
    "publish a page": ["artifact", { id: "page", title: "Page", content: "<!doctype html><p>Hi</p>" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text.slice(0, 20000)}` : "ok")]);
};
let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(scriptedModel(route));
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

async function turn(id: number, text: string, answer?: boolean): Promise<{ said: string; subject?: string }> {
    const { submissionId } = await app.commands.submit(id as never, owner(app), { text, requestId: crypto.randomUUID() });
    let subject: string | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id as never).length > 0, "the card");
        const asked = app.approvals.forConversation(id as never)[0]!;

        subject = asked.subject;
        await app.answerApproval(asked.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return { said: (await modelTexts(app, id as never)).at(-1)!, ...(subject === undefined ? {} : { subject }) };
}

const call = (path: string, init: RequestInit = {}) =>
    fetch(`${base}/api/${path}`, { ...init, headers: { authorization: `Bearer ${app.config.ownerToken}`, "content-type": "application/json", "x-pocket": "1", ...init.headers } });

test("Pi lists the hooks with settings and turns one off with setting_change, after the owner's card", async () => {
    const id = await newSession(app);
    const listed = (await turn(id, "list hooks")).said;

    assert.match(listed, /hooks\.artifactCheck: on/);
    assert.match(listed, /hooks\.uiReminder: on/);
    assert.match(listed, /Check artifacts on publish/);
    assert.match(listed, /Remind to check UI before finishing/);

    const changed = await turn(id, "reminder off", true);

    assert.equal(changed.subject, "Change Remind to check UI before finishing: on → off");
    assert.match(changed.said, /Changed hooks\.uiReminder: on → off/);
    assert.equal(app.config.hookOn("uiReminder"), false);
    assert.equal(app.config.hookOn("artifactCheck"), true, "the other keeps its default");
    app.setHook(owner(app), "uiReminder", true);
});

test("Settings › Hooks: the API lists and switches the hooks, with the built-in behaviours; the owner's choice is kept", async () => {
    const listed = (await (await call("hooks")).json()) as { hooks: { id: string; on: boolean; default: boolean; title: string }[]; builtIn: { id: string; setting: string | null }[] };

    assert.deepEqual(listed.hooks.map((hook) => [hook.id, hook.on, hook.default]), [["artifactCheck", true, true], ["uiReminder", true, true]]);
    // Ask before paying (PP-455): listed, with no setting: it cannot be turned off.
    assert.deepEqual(listed.builtIn.map((item) => [item.id, item.setting]), [["wikiCapture", "wiki.captureMinutes"], ["autoCompact", "sessions.compactAt"], ["askBeforeRisky", null]]);

    const off = (await (await call("hooks/artifactCheck", { method: "PUT", body: JSON.stringify({ on: false }) })).json()) as typeof listed;

    assert.equal(off.hooks.find((hook) => hook.id === "artifactCheck")?.on, false);
    assert.equal(app.config.hookOn("artifactCheck"), false);
    // Kept in the app's config: only what differs from the defaults.
    const saved = () => (JSON.parse(readFileSync(app.config.file, "utf8")) as { hooks?: unknown }).hooks;

    assert.deepEqual(saved(), { artifactCheck: false });
    await call("hooks/artifactCheck", { method: "PUT", body: JSON.stringify({ on: true }) });
    assert.equal(saved(), undefined, "back to its default: nothing written");

    const unknown = await call("hooks/everything", { method: "PUT", body: JSON.stringify({ on: false }) });

    assert.equal(unknown.status, 404);
    assert.match(((await unknown.json()) as { error: string }).error, /No hook everything: the hooks are artifactCheck, uiReminder/);
    assert.equal((await call("hooks/uiReminder", { method: "PUT", body: JSON.stringify({ on: "yes" }) })).status, 400);
    assert.throws(() => app.setHook({ ...owner(app), role: "viewer" }, "uiReminder", false), /Only the owner/);
    assert.throws(() => app.hooksView({ ...owner(app), role: "guest" }), /Only the owner/);
});

test("the artifact check with no phone to render: the publish stands, and the result says once why it has no numbers (PP-421)", async () => {
    app.serverPort = 8799;
    const id = await newSession(app);
    const told = (await turn(id, "publish a page")).said;

    assert.match(told, /Published \\"Page\\" as artifact page, version 1\./);
    assert.match(told, /Settings › Hooks; screenshot shows the pictures\): not run\. No phone is rendering: [^]*The artifact is published; look with screenshot once the phone renders\./);
    assert.equal(told.split("No phone is rendering").length, 2, "said once, not for each width");
});
