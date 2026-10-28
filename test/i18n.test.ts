// The app in the person's language (PP-81): sentences by their English, placeholders kept, English where a catalog has
// none; the language kept with the person and told to every tab of theirs; Pi told when it is Chinese; and the check
// that finds the sentences and refuses a translation that loses a placeholder.
import { type App, cleanUp, fakeTab, home, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { appSettings } from "../src/server/settings-registry.ts";
import { after, before, test } from "node:test";
import { sentences, serverMessages, templatePattern } from "../scripts/i18n-check.ts";
import { scan, wrap } from "../scripts/i18n-scan.ts";
// @ts-expect-error: plain JS, no types.
import { resolveLanguage, t, timeAgo, tn, tServer, tx, useCatalog } from "../web/i18n.js";

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

test("what a group of calls did reads as whole phrases in Chinese, joined as Chinese joins a list (PP-84)", async () => {
    // @ts-expect-error: plain JS, no types.
    const { summarize } = await import("../web/turns.js");
    const call = (name: string, args: Record<string, unknown>, id: string) => ({ block: { type: "toolCall", name, args, id } });
    const steps = [
        { block: { type: "thinking" } },
        call("read", { path: "a.ts" }, "1"),
        call("read", { path: "b.ts" }, "2"),
        call("bash", { command: "ls" }, "3"),
        call("some_extension_tool", {}, "4"),
    ];

    assert.equal(summarize(steps, false), "Thought, read 2 files, ran 1 command, used some_extension_tool");
    useCatalog("zh-CN", JSON.parse(readFileSync(new URL("../web/i18n/zh-CN.json", import.meta.url), "utf8")));

    try {
        assert.equal(summarize(steps, false), "思考了、读取了 2 个文件、运行了 1 条命令和使用了 some_extension_tool");
        assert.equal(summarize([{ block: { type: "thinking" } }], true), "正在思考");
    } finally {
        useCatalog("en", {});
    }
});

test("the server's messages: found in its source, and shown in the person's language, a reason inside one too (PP-85)", () => {
    const source = [
        'throw new HttpError(404, `There is no folder ${absolute.value} on ${machine.name}.`);',
        'throw new HttpError(502, `${machine.name} does not answer: ${sshProblem(reached.error)}`);',
        'throw new HttpError(400, "Name the machine.");',
        'app.ownerNotice("warning", `Port ${ended.forward.remotePort} of ${`${ended.forward.machine}`} closed: ${ended.reason}`);',
        'throw new HttpError(500, error.message);',
        'throw new HttpError(400, `${what}`);',
    ].join("\n");

    assert.deepEqual(serverMessages(source), [
        "There is no folder {1} on {2}.",
        "{1} does not answer: {2}",
        "Name the machine.",
        "Port {1} of {2} closed: {3}",
    ]);
    assert.equal(templatePattern("a ${b ? `c ${d}` : e} f\\n"), "a {1} f\n");

    useCatalog("zh-CN", {}, {
        "Name the machine.": "给机器起个名字。",
        "There is no folder {1} on {2}.": "{2} 上没有文件夹 {1}。",
        "{1} does not answer: {2}": "{1} 没有响应：{2}",
        "the machine is not reachable from the phone (off, asleep, or another network)": "手机连不上这台机器（关机、休眠或不在同一网络）",
    });

    try {
        assert.equal(tServer("Name the machine."), "给机器起个名字。");
        assert.equal(tServer("There is no folder /srv/app on box."), "box 上没有文件夹 /srv/app。");
        assert.equal(
            tServer("laptop does not answer: the machine is not reachable from the phone (off, asleep, or another network)"),
            "laptop 没有响应：手机连不上这台机器（关机、休眠或不在同一网络）",
            "the reason inside is a message of its own",
        );
        assert.equal(tServer("Something the catalog lacks."), "Something the catalog lacks.");
    } finally {
        useCatalog("en", {});
    }

    assert.equal(tServer("There is no folder /srv/app on box."), "There is no folder /srv/app on box.", "English as it came");
});

test("the language: a choice, else the browser's when the app speaks it, else English", () => {
    assert.equal(resolveLanguage("zh-CN", ["en-US"]), "zh-CN");
    assert.equal(resolveLanguage("auto", ["zh-TW", "en"]), "zh-CN", "Chinese of any script reads Simplified for now");
    assert.equal(resolveLanguage("auto", ["fr-FR", "en-GB"]), "en");
    assert.equal(resolveLanguage("auto", ["vi-VN"]), "vi", "Vietnamese (PP-236)");
    assert.equal(resolveLanguage("vi", ["en-US"]), "vi");
    assert.equal(resolveLanguage("auto", ["fr-FR", "vi", "en"]), "vi");
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
        await app.setLanguage(me, "vi");
        assert.equal(app.config.userById(me.id)?.language, "vi", "Vietnamese (PP-236)");
        assert.deepEqual(mine.last("language"), { language: "vi" });

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
    assert.match(source, /write to them in Vietnamese unless they write to you in another language/);
});

test("Vietnamese is a language of the app (PP-236): in the picker, Appearance's setting, and the check's catalogs", async () => {
    // @ts-expect-error: plain JS, no types.
    const { LANGUAGES } = await import("../web/i18n.js");

    assert.deepEqual(LANGUAGES.map((each: { id: string }) => each.id), ["en", "zh-CN", "vi"]);
    assert.equal(LANGUAGES.find((each: { id: string }) => each.id === "vi").name, "Tiếng Việt");

    const setting = appSettings(app).settings.find((each) => each.id === "appearance.language")!;

    assert.deepEqual(await setting.choices?.(), ["auto", "en", "zh-CN", "vi"]);

    // The check knows the vi catalogs: what each lacks, as JSON, and its line in the summary.
    const check = (...args: string[]) =>
        execFileSync(process.execPath, [new URL("../scripts/i18n-check.ts", import.meta.url).pathname, ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
    const sentencesLacked = JSON.parse(check("--missing", "vi")) as Record<string, string>;
    const messagesLacked = JSON.parse(check("--missing", "vi.server")) as Record<string, string>;
    const catalog = JSON.parse(readFileSync(new URL("../web/i18n/vi.json", import.meta.url), "utf8")) as Record<string, string>;

    assert.ok(Object.keys(sentencesLacked).every((each) => catalog[each] === undefined || catalog[each] === ""), "only what vi.json lacks");
    assert.equal(typeof messagesLacked, "object");
    assert.match(check(), /^vi: \d+ of \d+ sentences translated/m);
    assert.match(check(), /^vi\.server: \d+ of \d+ server messages translated/m);
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
