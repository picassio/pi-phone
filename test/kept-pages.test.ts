// Artifacts kept as pages (PP-370): each person's own list, in their order, following the artifact's newest version and
// sent to their tabs; a page whose artifact they cannot see is not shown to them; removing takes it off; the owner's
// artifacts.pages off hides every page and refuses keeping, and on brings them back; Pi's pages.keep and pages.order.
import { type App, cleanUp, fakeTab, lastText, newSession, openApp, owner, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { appSettings } from "../src/server/settings-registry.ts";
import type { KeptPagesView } from "../src/server/kept-pages.ts";

const route: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);
    const call = (args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall("artifact", args as never)], { stopReason: "toolUse" });

    if (role === "toolResult") {
        return fauxAssistantMessage([fauxText("published")]);
    }

    if (text.includes("make the reader")) {
        return call({ id: "paper-reader", title: "Paper reader", content: "<h1>one</h1>" });
    }

    if (text.includes("fix the reader")) {
        return call({ id: "paper-reader", title: "Paper reader 2", content: "<h1>two</h1>" });
    }

    if (text.includes("make the budget")) {
        return call({ id: "budget", title: "Budget", type: "markdown", content: "# Budget" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

const titles = (view: KeptPagesView) => view.pages.map((page) => `${page.artifact}@${page.version}:${page.title}`);

test("kept pages: each person's own, in order, following the newest version, visible only to who can see them, removed, off for everyone (PP-370)", async () => {
    const me = owner(app);
    const id = await newSession(app);
    const other = await newSession(app);

    await say(app, id, "make the reader");
    await say(app, other, "make the budget");

    assert.deepEqual(await app.keptPages.list(me), { on: true, pages: [] }, "none kept yet");

    const tab = fakeTab(undefined, me);

    await app.attach(tab.client);

    // Kept, at the end of the rail: what the page shows, from where.
    const kept = await app.keptPages.set(me, { conversation: Number(id), artifact: "paper-reader", kept: true });

    assert.deepEqual(titles(kept), ["paper-reader@1:Paper reader"]);
    assert.equal(kept.pages[0]!.type, "html");
    assert.equal(kept.pages[0]!.conversation, Number(id));
    await until(() => (tab.last("kept-pages") as KeptPagesView | undefined)?.pages.length === 1, "the owner's tab hears it");

    // Keeping it again changes nothing; one that does not exist is refused.
    assert.deepEqual(titles(await app.keptPages.set(me, { conversation: Number(id), artifact: "paper-reader", kept: true })), ["paper-reader@1:Paper reader"]);
    await assert.rejects(app.keptPages.set(me, { conversation: Number(id), artifact: "nothing-here", kept: true }), /no artifact nothing-here/);
    await assert.rejects(app.keptPages.set(me, { conversation: Number(id), artifact: "Paper Reader!", kept: true }), /A page is an artifact/);

    // A new version: the page follows it, title and all, and the tab hears it.
    await say(app, id, "fix the reader");
    assert.deepEqual(titles(await app.keptPages.list(me)), ["paper-reader@2:Paper reader 2"]);
    await until(() => (tab.last("kept-pages") as KeptPagesView | undefined)?.pages[0]?.version === 2, "the tab hears the new version");

    // A second page, then the order turned around.
    await app.keptPages.set(me, { conversation: Number(other), artifact: "budget", kept: true });
    assert.deepEqual(titles(await app.keptPages.list(me)), ["paper-reader@2:Paper reader 2", "budget@1:Budget"]);
    const turned = await app.keptPages.order(me, {
        pages: [
            { conversation: Number(other), artifact: "budget" },
            { conversation: Number(id), artifact: "paper-reader" },
        ],
    });

    assert.deepEqual(titles(turned), ["budget@1:Budget", "paper-reader@2:Paper reader 2"]);
    await assert.rejects(app.keptPages.order(me, { pages: [{ conversation: Number(other), artifact: "budget" }, { conversation: Number(other), artifact: "budget" }] }), /each page you keep once/);

    // Another person's pages are their own: none of the owner's, and theirs not the owner's.
    const alex = app.config.addUser("Alex", "guest").user;

    assert.deepEqual(await app.keptPages.list(alex), { on: true, pages: [] }, "Alex sees none of the owner's pages");
    assert.deepEqual(titles(await app.keptPages.set(alex, { conversation: Number(id), artifact: "paper-reader", kept: true })), ["paper-reader@2:Paper reader 2"]);
    assert.equal((await app.keptPages.list(me)).pages.length, 2, "the owner's list is as it was");

    // Someone invited to the other session alone cannot keep, nor see, the reader.
    const sam = app.config.addUser("Sam", "guest", [String(other)]).user;

    await assert.rejects(app.keptPages.set(sam, { conversation: Number(id), artifact: "paper-reader", kept: true }), /that you can see/);
    assert.deepEqual(titles(await app.keptPages.set(sam, { conversation: Number(other), artifact: "budget", kept: true })), ["budget@1:Budget"]);

    // Alex loses the reader's session: his page is no longer shown to him.
    app.setAccess(me, alex.id, { sessions: [String(other)] });
    assert.deepEqual(await app.keptPages.list(app.config.userById(alex.id)!), { on: true, pages: [] }, "an artifact he cannot see is not shown");
    app.setAccess(me, alex.id, { sessions: null });
    assert.equal((await app.keptPages.list(app.config.userById(alex.id)!)).pages.length, 1, "shown again with the session");

    // Removed from the rail.
    assert.deepEqual(titles(await app.keptPages.set(me, { conversation: Number(other), artifact: "budget", kept: false })), ["paper-reader@2:Paper reader 2"]);

    // Off for everyone (the owner's artifacts.pages): no pages, no keeping; on again, they are back as they were.
    const setting = appSettings(app).settings.find((each) => each.id === "artifacts.pages")!;

    assert.equal(await setting.read(undefined), "on");
    assert.throws(() => setting.apply(alex, "off", undefined), /Only the owner/);
    await setting.apply(me, "off", undefined);
    assert.equal(await setting.read(undefined), "off");
    assert.deepEqual(await app.keptPages.list(me), { on: false, pages: [] });
    assert.deepEqual(await app.keptPages.list(app.config.userById(alex.id)!), { on: false, pages: [] });
    await until(() => (tab.last("kept-pages") as KeptPagesView | undefined)?.on === false, "the tab hears pages are off");
    await assert.rejects(app.keptPages.set(me, { conversation: Number(other), artifact: "budget", kept: true }), /Pages are off/);
    await setting.apply(me, "on", undefined);
    assert.deepEqual(titles(await app.keptPages.list(me)), ["paper-reader@2:Paper reader 2"]);
    assert.equal((await app.keptPages.list(app.config.userById(alex.id)!)).pages.length, 1);
});

test("Pi keeps and orders pages for the person it works for with pages.keep and pages.order, each said on its card (PP-370)", async () => {
    const me = owner(app);
    const id = await newSession(app);

    await say(app, id, "make the budget");
    const { actions } = appSettings(app);
    const keep = actions.find((each) => each.id === "pages.keep")!;
    const order = actions.find((each) => each.id === "pages.order")!;

    assert.equal(keep.owner, false, "anyone's own pages");
    assert.match(keep.describe({ session: String(id), artifact: "budget", kept: "on" }), new RegExp(`Keep the artifact budget of session ${id} as a page`));
    assert.match(await keep.run(me, { session: String(id), artifact: "budget", kept: "on" }), new RegExp(`Kept budget\\. Their pages, in order: .*${id}/budget \\("Budget", v1\\)`));

    const before = (await app.keptPages.list(me)).pages.map((page) => `${page.conversation}/${page.artifact}`);
    const reversed = [...before].reverse();

    assert.match(await order.run(me, { pages: reversed.join(", ") }), /Done\. Their pages, in order:/);
    assert.deepEqual((await app.keptPages.list(me)).pages.map((page) => `${page.conversation}/${page.artifact}`), reversed);
    assert.match(await keep.run(me, { session: String(id), artifact: "budget", kept: "off" }), /Removed budget\./);
    assert.ok(!(await app.keptPages.list(me)).pages.some((page) => page.conversation === Number(id)));
});
