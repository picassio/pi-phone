// Favorite models (PP-350, after pi-pocket 0.28 #169): a person's stars, kept on the server, a setting Pi can change, and
// the models tool marks them for the person a session works for.
import { type App, cleanUp, newSession, openApp, owner, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { appSettings } from "../src/server/settings-registry.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("a person stars models, their tabs hear it, and hello carries them", async () => {
    const me = owner(app);
    const heard: unknown[] = [];
    const tab = { id: "t", connection: "c", user: me, conversationId: undefined, protocol: 4, sentEntries: new Set<number>(), orderKey: "", send: (event: string, data: unknown) => event === "model-favorites" && heard.push(data) };

    assert.deepEqual((await app.hello(me)).user.favoriteModels, []);
    await app.attach(tab);

    try {
        assert.deepEqual(app.setModelFavorite(me, "faux/faux-2", true), ["faux/faux-2"]);
        assert.deepEqual(app.setModelFavorite(me, "faux/faux-1", true), ["faux/faux-2", "faux/faux-1"]);
        // Starred again, it moves to the end, and is there once.
        assert.deepEqual(app.setModelFavorite(me, "faux/faux-2", true), ["faux/faux-1", "faux/faux-2"]);
        assert.deepEqual(app.setModelFavorite(me, "faux/faux-1", false), ["faux/faux-2"]);
        assert.deepEqual((await app.hello(me)).user.favoriteModels, ["faux/faux-2"]);
        assert.deepEqual(heard.at(-1), { favoriteModels: ["faux/faux-2"] });
        assert.throws(() => app.setModelFavorite(me, "no-slash", true), /provider\/modelId/);
        assert.throws(() => app.setModelFavorite(me, "faux/faux-1", "yes"), /true or false/);
    } finally {
        app.detach(tab);
        app.setModelFavorites(me, []);
    }

    assert.equal(owner(app).favoriteModels, undefined, "none is not stored");
});

test("models.favorites reads and sets a person's stars, and none clears them", async () => {
    const me = owner(app);
    const setting = appSettings(app).settings.find((each) => each.id === "models.favorites")!;

    assert.equal(await setting.read(me.name), "none");
    await setting.apply(me, "faux/faux-1, faux/faux-2", me.name);
    assert.equal(await setting.read(me.name), "faux/faux-1, faux/faux-2");
    await setting.apply(me, "none", me.name);
    assert.equal(await setting.read(me.name), "none");
});

test("the models tool marks the favorites of the person a session works for, and lists only them when asked", async () => {
    const id = await newSession(app);

    // The session works for the owner once the owner wrote to it.
    await say(app, id, "hello");
    app.setModelFavorites(owner(app), ["faux/faux-2"]);

    try {
        const all = await app.modelsReport(undefined, false, { caller: id });

        assert.match(all, /- faux\/faux-2 \([^)]*\): [^\n]*a favorite of /);
        assert.doesNotMatch(all, /- faux\/faux-1 [^\n]*a favorite of/);

        const only = await app.modelsReport(undefined, false, { caller: id, favorites: true });

        assert.match(only, /faux\/faux-2/);
        assert.doesNotMatch(only, /faux\/faux-1/);
        app.setModelFavorites(owner(app), []);
        assert.match(await app.modelsReport(undefined, false, { caller: id, favorites: true }), /has starred no model/);
    } finally {
        app.setModelFavorites(owner(app), []);
    }
});
