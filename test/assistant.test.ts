// The phone's assistant sheet settings (PP-146, src/server/assistant.ts): checked patches, only what differs from the
// defaults kept in config.json, the owner's alone, sent to the owner's tabs in the server state, and changed by Pi's
// setting_change through the same method.
import { type App, cleanUp, openApp, owner, scriptedModel } from "./helpers.ts";
import { DEFAULT_ASSISTANT, readAssistant, storedAssistant, withAssistant } from "../src/server/assistant.ts";
import type { User } from "../src/server/config.ts";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

test("a patch is checked key by key, and opening one session needs that session", () => {
    assert.deepEqual(withAssistant(DEFAULT_ASSISTANT, { send: "auto" }), { ...DEFAULT_ASSISTANT, send: "auto" });
    assert.deepEqual(withAssistant(DEFAULT_ASSISTANT, { opens: "session", session: 37 }), { ...DEFAULT_ASSISTANT, opens: "session", session: 37 });
    assert.deepEqual(withAssistant(DEFAULT_ASSISTANT, { opens: "new", folder: " ~/work " }).folder, "~/work");
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, { opens: "session" }), /Pick the session/);
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, { send: "sometimes" }), /tap or auto/);
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, { from: "yes" }), /true or false/);
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, { session: 1.5 }), /session's number/);
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, { colour: "red" }), /no setting "colour"/);
    assert.throws(() => withAssistant(DEFAULT_ASSISTANT, "auto"), /an object/);
});

test("only what differs from the defaults is kept, and what is kept reads back whole", () => {
    assert.equal(storedAssistant(DEFAULT_ASSISTANT), undefined);
    assert.deepEqual(storedAssistant({ ...DEFAULT_ASSISTANT, send: "auto", from: false }), { send: "auto", from: false });
    assert.deepEqual(readAssistant({ send: "auto", from: false }), { ...DEFAULT_ASSISTANT, send: "auto", from: false });
    assert.deepEqual(readAssistant(undefined), DEFAULT_ASSISTANT);
    assert.deepEqual(readAssistant({ opens: "everywhere", session: -2 }), DEFAULT_ASSISTANT);
});

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the owner sets it, config.json keeps it, and the owner's server state carries it; a guest is refused", async () => {
    await app.setAssistant(owner(app), { opens: "new", folder: "/tmp/voice", send: "auto" });

    assert.deepEqual(app.config.assistant, { ...DEFAULT_ASSISTANT, opens: "new", folder: "/tmp/voice", send: "auto" });

    const saved = JSON.parse(readFileSync(app.config.file, "utf8")) as { assistant?: unknown };

    assert.deepEqual(saved.assistant, { opens: "new", folder: "/tmp/voice", send: "auto" });

    const hello = (await app.hello(owner(app))) as { server: { assistant?: unknown } };

    assert.deepEqual(hello.server.assistant, app.config.assistant);

    const guest: User = { id: "guest-1", name: "Gina", role: "guest" } as User;

    await assert.rejects(app.setAssistant(guest, { send: "tap" }), /Only the owner/);

    // Back to the defaults: nothing is kept.
    await app.setAssistant(owner(app), { opens: "last", folder: null, send: "tap" });
    assert.equal((JSON.parse(readFileSync(app.config.file, "utf8")) as { assistant?: unknown }).assistant, undefined);
});
