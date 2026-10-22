// The app in the person's language (PP-81): sentences by their English, placeholders kept, English where a catalog has
// none; the language kept with the person and told to every tab of theirs; Pi told when it is Chinese; and the check
// that finds the sentences and refuses a translation that loses a placeholder.
import { type App, cleanUp, fakeTab, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { sentences } from "../scripts/i18n-check.ts";
import { scan, wrap } from "../scripts/i18n-scan.ts";
// @ts-expect-error: plain JS, no types.
import { resolveLanguage, t, timeAgo, tn, tx, useCatalog } from "../web/i18n.js";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app.close();
    cleanUp();
});

test("sentences come from the catalog with their placeholders; one it lacks stays English", () => {
    useCatalog("zh-CN", { "Move {title} to a group": "将“{title}”移到分组", "{n} chat": "{n} 个会话", "{n} chats": "{n} 个会话", now: "刚刚", "{n}m": "{n}分钟" });

    assert.equal(t("Move {title} to a group", { title: "Plan" }), "将“Plan”移到分组");
    assert.equal(t("Not in the catalog, {name}", { name: "Ana" }), "Not in the catalog, Ana", "English when missing");
    assert.equal(t("Keep {this}"), "Keep {this}", "a placeholder with no value stays as written");
    assert.equal(tn(1, "{n} chat", "{n} chats"), "1 个会话");
    assert.equal(tn(3, "{n} chat", "{n} chats"), "3 个会话");
    assert.deepEqual(tx("Move {title} to a group", { title: { node: true } }), ["将“", { node: true }, "”移到分组"], "an element where the language puts it");
    assert.equal(timeAgo(Date.now()), "刚刚");
    assert.equal(timeAgo(Date.now() - 5 * 60_000), "5分钟");

    useCatalog("en", {});
    assert.equal(tn(1, "{n} chat", "{n} chats"), "1 chat");
    assert.equal(timeAgo(Date.now() - 2 * 3_600_000), "2h");
});

test("the language: a choice, else the browser's when the app speaks it, else English", () => {
    assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
    assert.equal(resolveLanguage("auto", ["zh-TW", "en"]), "zh-CN", "Chinese of any script reads Simplified for now");
    assert.equal(resolveLanguage("auto", ["fr-FR", "en-GB"]), "en");
    assert.equal(resolveLanguage("auto", ["vi-VN"]), "en");
    assert.equal(resolveLanguage("klingon", ["zh-CN"]), "zh-CN", "an unknown choice falls to the browser's");
});

test("a person's language is kept with them, told to their tabs, in hello, and to Pi when it is Chinese", async () => {
    const me = owner(app);
    const guest = app.config.addUser("Guest", "guest").user;
    const mine = fakeTab(undefined, me);
    const theirs = fakeTab(undefined, guest);

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        assert.equal((await app.hello(me)).user.language, "auto", "the browser's until chosen");
        await app.setLanguage(me, "zh-CN");
        assert.equal(app.config.userById(me.id)?.language, "zh-CN");
        assert.deepEqual(mine.last("language"), { language: "zh-CN" });
        assert.equal(theirs.last("language"), undefined, "only their own tabs");
        assert.equal((await app.hello(me)).user.language, "zh-CN");
        await assert.rejects(app.setLanguage(me, "fr"), { status: 400 });

        await app.setLanguage(me, "auto");
        assert.equal(app.config.userById(me.id)?.language, undefined, "auto keeps nothing");
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

test("Pi's prompt says so when the person's app is in Chinese", () => {
    const source = readFileSync(new URL("../src/server/extensions/prompt.ts", import.meta.url), "utf8");

    assert.match(source, /section\("language"/);
    assert.match(source, /write to them in Chinese unless they write to you in another language/);
});

test("the check finds sentences in t(), tx(), tn() and item(), and the scan wraps whole text only", () => {
    const source = `
        t("One {x}", { x }); tx("Two {y}", { y }); tn(n, "{n} file", "{n} files");
        item("Rename", () => go(), "this browser"); item(html\`<span class="pulse"></span>\`, run, \`\${n} more\`);
        const label = cond ? "Not a t call" : "x";
    `;

    assert.deepEqual(sentences(source).sort(), ["One {x}", "Rename", "Two {y}", "this browser", "{n} file", "{n} files"].sort());

    const template = 'html`<div title="Open the menu"><b>Hello there</b> <span>${n} here</span><i class="x">${a}</i></div>`';
    const found = scan(template);

    assert.deepEqual(found.map((each) => [each.kind, each.text]), [["attr", "Open the menu"], ["text", "Hello there"], ["mixed", "here"]]);
    assert.equal(wrap(template).out, 'html`<div title=${t("Open the menu")}><b>${t("Hello there")}</b> <span>${n} here</span><i class="x">${a}</i></div>`', "a sentence in pieces is left for a person");
});
