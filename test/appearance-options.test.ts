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
