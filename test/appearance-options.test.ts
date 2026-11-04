// A person's appearance options that follow them on every device (PP-345): their defaults in hello, Appearance's
// switch (POST /api/me) and Pi's setting (appearance.*) change them, kept with the person and told to their own tabs.
import { type App, cleanUp, fakeTab, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appSettings } from "../src/server/settings-registry.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

test("Reply to a passage: on until turned off, by Appearance or by Pi's setting, for that person only", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;
    const mine = fakeTab(undefined, me);
    const theirs = fakeTab(undefined, guest);
    const setting = appSettings(app).settings.find((each) => each.id === "appearance.quoteReply")!;

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        assert.equal((await app.hello(me)).user.appearance.quoteReply, true, "on until turned off");
        assert.equal(setting.target, "person");
        assert.equal(await setting.read(me.name), "on");

        // Appearance's switch.
        app.setAppearance(me, "quoteReply", false);
        assert.deepEqual(app.config.userById(me.id)?.appearance, { quoteReply: false });
        assert.equal((mine.last("appearance") as { appearance: { quoteReply: boolean } }).appearance.quoteReply, false);
        assert.equal(theirs.last("appearance"), undefined, "only their own tabs");
        assert.equal((await app.hello(me)).user.appearance.quoteReply, false);
        assert.equal((await app.hello(guest)).user.appearance.quoteReply, true, "another person keeps theirs");

        // Pi's setting, after the owner's card.
        await setting.apply(me, "on", me.name);
        assert.equal(await setting.read(me.name), "on");
        assert.equal((mine.last("appearance") as { appearance: { quoteReply: boolean } }).appearance.quoteReply, true);
        assert.throws(() => setting.apply(me, "maybe", me.name), { status: 400 });

        assert.throws(() => app.setAppearance(me, "nope", true), { status: 400 });
        assert.throws(() => app.setAppearance(me, "quoteReply", "yes"), { status: 400 });
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

// GitHub #7 (PP-384): the message box's mic, hidden until the person turns it on in Menu › Dictation or Pi does.
test("The mic button: hidden until turned on, by Menu › Dictation or by Pi's dictation.micButton, for that person only", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest two", "guest").user;
    const mine = fakeTab(undefined, me);
    const setting = appSettings(app).settings.find((each) => each.id === "dictation.micButton")!;
    const micOf = (data: unknown) => (data as { appearance: { micButton: boolean } }).appearance.micButton;

    await app.attach(mine.client);

    try {
        assert.equal((await app.hello(me)).user.appearance.micButton, false, "hidden until turned on");
        assert.equal(setting.area, "dictation");
        assert.equal(setting.target, "person");
        assert.deepEqual(setting.choices?.(), ["on", "off"]);
        assert.equal(await setting.read(me.name), "off");

        // Pi's setting, after the owner's card.
        await setting.apply(me, "on", me.name);
        assert.equal(await setting.read(me.name), "on");
        assert.equal(app.config.userById(me.id)?.appearance?.micButton, true);
        assert.equal(micOf(mine.last("appearance")), true, "their tabs show it");
        assert.equal((await app.hello(me)).user.appearance.micButton, true);
        assert.equal((await app.hello(guest)).user.appearance.micButton, false, "another person keeps theirs");

        // Menu › Dictation's switch.
        app.setAppearance(me, "micButton", false);
        assert.equal(await setting.read(me.name), "off");
        assert.equal(micOf(mine.last("appearance")), false);
        assert.throws(() => setting.apply(me, "hidden", me.name), { status: 400 });
    } finally {
        app.detach(mine.client);
    }
});
