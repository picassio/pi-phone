// Onboarding (PP-232): the first-run welcome's state on the server (PP-234). A new pi-phone's owner sees it the first time
// the app opens; people from before it existed are marked done (owner's decision A); the owner finishes, skips, or asks
// for it again (the app, `POST /api/me`, and Pi's settings tools: `onboarding.welcome`); guests never get it.
import { type App, cleanUp, fakeTab, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import { appSettings } from "../src/server/settings-registry.ts";

const apps: App[] = [];

after(async () => {
    for (const each of apps) {
        await each.close();
    }

    cleanUp();
});

test("a new pi-phone's owner gets the welcome; a guest does not", async () => {
    const app = await openApp(scriptedModel(), join(root, "onboarding-new"), undefined, {}, { welcome: true });

    apps.push(app);
    assert.equal((await app.hello(owner(app))).user.welcome, "show");

    const { user: guest } = app.config.addUser("Guest", "guest");

    assert.equal((await app.hello(guest)).user.welcome, "done", "a guest is not welcomed");
    assert.throws(() => app.setWelcome(guest, "done"), /Only the owner/);
});

test("people from before the welcome existed are marked done once, and keep it", () => {
    const dir = join(root, "onboarding-old");
    const store = new ConfigStore(dir);
    const file = join(dir, "config.json");
    // As a config written before PP-234: no marker, nobody's welcome state.
    const old = JSON.parse(readFileSync(file, "utf8")) as { onboarding?: number; users: { welcome?: string }[] };

    assert.equal(store.users[0]!.welcome, undefined, "a new config's owner is to be welcomed");
    delete old.onboarding;
    old.users.push({ ...old.users[0]!, id: "someone", name: "Someone", role: "guest" } as never);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(old));

    const upgraded = new ConfigStore(dir);

    assert.deepEqual(upgraded.users.map((user) => user.welcome), ["done", "done"]);

    // Shown again later by choice: the marker keeps it from being marked done at the next start.
    upgraded.updateUser(upgraded.users[0]!.id, { welcome: undefined });
    assert.equal(new ConfigStore(dir).users[0]!.welcome, undefined);
});

test("the owner finishes, skips, or asks for it again; their tabs hear it; Pi's settings tools read and set it", async () => {
    const app = await openApp(scriptedModel(), join(root, "onboarding-set"), undefined, {}, { welcome: true });

    apps.push(app);

    const me = owner(app);
    const tab = fakeTab(undefined, me);

    await app.attach(tab.client);
    app.setWelcome(me, "skipped");
    assert.equal((await app.hello(me)).user.welcome, "skipped");
    assert.deepEqual(tab.last("welcome"), { welcome: "skipped" });
    assert.throws(() => app.setWelcome(me, "later"), /show, done, or skipped/);

    const setting = appSettings(app).settings.find((each) => each.id === "onboarding.welcome")!;

    assert.ok(setting.owner);
    await setting.apply(me, "show", undefined);
    assert.equal(await setting.read(undefined), "show");
    assert.deepEqual(tab.last("welcome"), { welcome: "show" });
    await setting.apply(me, "done", undefined);
    assert.equal(await setting.read(undefined), "done");
    await assert.rejects(async () => setting.apply(me, "maybe", undefined), /show, done, or skipped/);
});
