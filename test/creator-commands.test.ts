// `/make` and `/page` (PP-428): what Pi gets for each, a prompt template of the same name that wins, and each refused
// with a clear reason when what it needs is off or nothing follows it.
import { type App, cleanUp, context, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { expandCreatorCommand } from "../src/server/creator-commands.ts";
import { BUILDER_MODULE } from "../src/server/extension-builder.ts";

let app: App;
/** A folder whose own `/page` template wins over the app's. */
const templated = join(work, "templated");

before(async () => {
    mkdirSync(join(templated, ".pi", "prompts"), { recursive: true });
    writeFileSync(join(templated, ".pi", "prompts", "page.md"), "My own page command for $@");
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** Send `text` to session `id` and answer what Pi got as its last user message. */
async function sent(id: Awaited<ReturnType<typeof newSession>>, text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: `r-${Math.random()}` });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const page = await (await app.harness.conversation(id, context))!.entries({}, 20, undefined, context);
    const user = page.items.filter((entry) => entry.kind === "pi.user").sort((a, b) => Number(b.id) - Number(a.id))[0];

    return JSON.stringify(user?.model);
}

const on = { builder: true, pages: true, conversation: 7 };

test("/make and /page expand into the Creator flow and an artifact kept as a page; other words are left alone", () => {
    const make = expandCreatorCommand("/make a pomodoro timer in the side rail", on);

    assert.match(String(make), /^\/make a pomodoro timer in the side rail\n\n<make-request>\n[^]*extension-builder skill[^]*extension_create[^]*\n<\/make-request>$/);

    const page = expandCreatorCommand("/page a currency converter VND/USD", on);

    assert.match(String(page), /^\/page a currency converter VND\/USD\n\n<page-request>\n[^]*artifact tool[^]*app_action pages\.keep with session 7[^]*\n<\/page-request>$/);

    assert.equal(expandCreatorCommand("/makeup", on), undefined);
    assert.equal(expandCreatorCommand("/pages", on), undefined);
    assert.equal(expandCreatorCommand("make a clock", on), undefined);
    assert.deepEqual(expandCreatorCommand("/make", on), { error: "empty", command: "make" });
    assert.deepEqual(expandCreatorCommand("/page   ", on), { error: "empty", command: "page" });
    assert.deepEqual(expandCreatorCommand("/make a clock", { ...on, builder: false }), { error: "off", command: "make" });
    assert.deepEqual(expandCreatorCommand("/page a clock", { ...on, pages: false }), { error: "off", command: "page" });
});

test("sent to a session, /make reaches Pi expanded, and a /page template of the folder wins over the app's /page", async () => {
    const id = await newSession(app);

    assert.match(await sent(id, "/make a pomodoro timer"), /\/make a pomodoro timer\\n\\n<make-request>\\n.*extension_create/);
    assert.match(await sent(id, "/page a converter"), new RegExp(`<page-request>.*pages\\.keep with session ${Number(id)}`));

    const own = await newSession(app, templated);
    const got = await sent(own, "/page a converter");

    assert.match(got, /My own page command for a converter/);
    assert.doesNotMatch(got, /page-request/);
});

test("/make with the Extension builder off, /page with pages off, and either with nothing after it are refused, saying why", async () => {
    const id = await newSession(app);

    await assert.rejects(app.commands.submit(id, owner(app), { text: "/make", requestId: "bare" }), { status: 400, message: /such as \/make a pomodoro timer/ });

    await app.setExtensionEnabled(owner(app), BUILDER_MODULE, false);

    try {
        await assert.rejects(app.commands.submit(id, owner(app), { text: "/make a clock", requestId: "off-1" }), { status: 409, message: /Extension builder/ });
    } finally {
        await app.setExtensionEnabled(owner(app), BUILDER_MODULE, true);
    }

    app.config.artifactPages = false;

    try {
        await assert.rejects(app.commands.submit(id, owner(app), { text: "/page a clock", requestId: "off-2" }), { status: 409, message: /Settings › Pages/ });
    } finally {
        app.config.artifactPages = true;
    }
});
