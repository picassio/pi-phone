// Onboarding (PP-232): the first-run welcome's state on the server (PP-234). A new pi-phone's owner sees it the first time
// the app opens; people from before it existed are marked done (owner's decision A); the owner finishes, skips, or asks
// for it again (the app, `POST /api/me`, and Pi's settings tools: `onboarding.welcome`); guests never get it.
import { type App, cleanUp, fakeTab, lastText, modelTexts, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigStore } from "../src/server/config.ts";
import { GuideDoc } from "../src/server/docs.ts";
import { appSettings } from "../src/server/settings-registry.ts";
import { newestBig, parseWhatsNew, readWhatsNew, WHATS_NEW_DIR } from "../src/server/whats-new.ts";

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

// ─── Getting started (PP-235) ───

/** What Pi saw last in each request: its system prompt and the last message, for the scripted model's route. */
const prompts: string[] = [];
/** Pi in a Getting started session: sets the checklist, ticks the first part, finishes, as the skill says. */
const guiding: FauxResponseStep = (context) => {
    const { role, text } = lastText(context as never);

    for (const message of (context as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections?.["getting-started"]) {
            prompts.push(message.sections["getting-started"]);
        }
    }

    if (role === "user" && (text.includes("Show me around.") || text.includes("带我熟悉一下。"))) {
        return fauxAssistantMessage([fauxToolCall("guide", { action: "set", items: ["The basics", "How the app looks", "Voice"] } as never)], { stopReason: "toolUse" });
    }

    if (role === "toolResult" && text.includes("[ ] The basics")) {
        return fauxAssistantMessage([fauxToolCall("guide", { action: "tick", item: "1" } as never)], { stopReason: "toolUse" });
    }

    if (role === "toolResult" && text.includes("[x] The basics") && !text.includes("settled")) {
        return fauxAssistantMessage([fauxToolCall("guide", { action: "finish" } as never)], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("That is the tour.")]);
};

test("Menu › Getting started makes the owner's session once, in their language, and opens the same one again", async () => {
    const app = await openApp(scriptedModel(guiding), join(root, "onboarding-guide"));

    apps.push(app);

    const me = owner(app);
    const id = await app.gettingStarted(me, { language: "zh-CN" });

    assert.equal(app.sessionMeta(id)?.title, "入门引导");
    assert.equal(me.guide, String(id));
    await until(async () => (await modelTexts(app, id)).some((each) => each.includes("带我熟悉一下。")), "the first message, in Chinese");

    // The prompt names the session and the skill; the skill is among the built-in ones.
    await until(() => prompts.some((each) => each.includes("Getting started session") && each.includes("getting-started")), "the section");
    assert.ok(app.skills(app.defaultCwd).some((skill) => skill.name === "getting-started"), "the getting-started skill");

    // Again: the same session, back in the active list.
    await until(() => app.sessionMeta(id)?.settle?.state === "settled", "settled by guide finish");
    assert.equal(await app.gettingStarted(me), id);
    assert.notEqual(app.sessionMeta(id)?.settle?.state, "settled");

    // What's new: the same session, asked about a version.
    assert.equal(await app.gettingStarted(me, { whatsNew: "0.9.0" }), id);
    await until(async () => (await modelTexts(app, id)).some((each) => each.includes("Show me what's new in 0.9.0.")), "the What's new message");

    const guest = app.config.addUser("Ana", "guest").user;

    await assert.rejects(app.gettingStarted(guest), /Only the owner/);
});

test("the guide tool keeps the checklist the bar shows: set, tick, finish settles the session", async () => {
    const app = await openApp(scriptedModel(guiding), join(root, "onboarding-checklist"));

    apps.push(app);

    const id: ConversationId = await app.gettingStarted(owner(app), { language: "en" });
    const guide = async () => app.harness.snapshot(GuideDoc, id, BACKGROUND_CONTEXT);

    await until(async () => (await guide())?.finished === true, "the guide finished");
    assert.deepEqual((await guide())?.items, [
        { text: "The basics", done: true },
        { text: "How the app looks", done: false },
        { text: "Voice", done: false },
    ]);
    assert.equal(app.sessionMeta(id)?.settle?.state, "settled");

    // The tab's view has it, for the bar.
    const tab = fakeTab(id, owner(app));

    await app.attach(tab.client);
    await until(() => tab.field("guide") !== undefined, "the view's checklist");
    assert.deepEqual(tab.field("guide"), { items: (await guide())!.items, finished: true });
});

// ─── What a guide sets up besides the registry's settings (PP-235) ───

test("show_screen puts a card in the chat and opens nothing; a screen it does not know is refused", async () => {
    const results: string[] = [];
    const app = await openApp(
        scriptedModel((context) => {
            const { role, text } = lastText(context as never);

            if (role === "user" && text.includes("turn on phone control")) {
                return fauxAssistantMessage([fauxToolCall("show_screen", { screen: "android-accessibility", why: "Turn on pi: phone control." } as never)], { stopReason: "toolUse" });
            }

            if (role === "user" && text.includes("the kitchen")) {
                return fauxAssistantMessage([fauxToolCall("show_screen", { screen: "kitchen" } as never)], { stopReason: "toolUse" });
            }

            if (role === "toolResult") {
                results.push(text);
            }

            return fauxAssistantMessage([fauxText("ok")]);
        }),
        join(root, "onboarding-screens"),
    );

    apps.push(app);

    const id = await app.gettingStarted(owner(app), { language: "en" });

    await app.commands.submit(id, owner(app), { text: "turn on phone control", requestId: crypto.randomUUID() });
    await until(() => results.some((each) => each.includes("open android-accessibility")), "the card's result");
    assert.match(results.find((each) => each.includes("android-accessibility"))!, /Nothing opens until they tap it/);
    await app.commands.submit(id, owner(app), { text: "show me the kitchen", requestId: crypto.randomUUID() });
    await until(() => results.length >= 2, "the refusal");
    assert.doesNotMatch(results.at(-1)!, /A card with a button/);
});

test("the dictation language is one person's on all their devices, set in the app or by Pi; notifications on a device can be turned off, not on", async () => {
    const app = await openApp(scriptedModel(), join(root, "onboarding-settings"));

    apps.push(app);

    const me = owner(app);
    const tab = fakeTab(undefined, me);
    const registry = appSettings(app);
    const dictation = registry.settings.find((each) => each.id === "dictation.language")!;

    await app.attach(tab.client);
    assert.equal((await app.hello(me)).user.dictation, "auto");
    await dictation.apply(me, "vi-VN", me.name);
    assert.equal(await dictation.read(me.name), "vi-VN");
    assert.equal((await app.hello(me)).user.dictation, "vi-VN");
    assert.deepEqual(tab.last("dictation"), { dictation: "vi-VN" });
    await assert.rejects(async () => dictation.apply(me, "Vietnamese please", me.name), /language tag/);
    app.setDictationLanguage(me, "auto");
    assert.equal(me.dictation, undefined);

    const notifications = registry.settings.find((each) => each.id === "notifications.device")!;

    assert.equal(notifications.target, "device");
    assert.equal(await notifications.read("Chrome on Windows"), "off");
    await assert.rejects(async () => notifications.apply(me, "on", "Chrome on Windows"), /only on the device itself/);
    await assert.rejects(async () => notifications.apply(me, "off", "Chrome on Windows"), /No device gets notifications/);

    const key = createECDH("prime256v1");

    key.generateKeys();
    app.webPush.subscribe({ endpoint: "https://push.example.test/one", keys: { p256dh: key.getPublicKey().toString("base64url"), auth: Buffer.from("fedcba9876543210").toString("base64url") } }, { name: "Chrome on Windows", origin: "https://pi.example.test" });
    assert.equal(await notifications.read("Chrome on Windows"), "on");
    assert.deepEqual(await registry.targets.device(), ["Chrome on Windows"]);
    await notifications.apply(me, "off", "Chrome on Windows");
    assert.equal(app.webPush.list().length, 0);
});

// ─── What's new (PP-235) ───

const notes = (title: string, date: string, big: boolean) => `---\ntitle: ${title}\ndate: ${date}\nbig: ${big}\n---\n\n- something new\n`;

test("release notes: their header read, newest first; the app's own parse", () => {
    const dir = join(root, "whatsnew-read");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0.9.md"), notes("Onboarding", "2026-10-28", true));
    writeFileSync(join(dir, "0.10.md"), notes("Small fixes", "2026-11-02", false));
    writeFileSync(join(dir, "notes.txt"), "not a release");
    assert.deepEqual(readWhatsNew(dir).map((each) => [each.version, each.big]), [["0.10", false], ["0.9", true]]);
    assert.equal(newestBig(dir)?.title, "Onboarding");
    assert.throws(() => parseWhatsNew("1.0", "- no header"), /header/);
    assert.throws(() => parseWhatsNew("1.0", "---\ntitle: x\n---"), /date/);
    assert.ok(readWhatsNew(WHATS_NEW_DIR).length > 0, "the app's own notes parse");
});

test("a big release's card shows to people past the welcome, until dismissed; Show me goes to the guide; a new person starts without it", async () => {
    const dir = join(root, "whatsnew-card");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "0.9.md"), notes("Onboarding", "2026-10-28", true));
    writeFileSync(join(dir, "0.10.md"), notes("Small fixes", "2026-11-02", false));

    const app = await openApp(scriptedModel(), join(root, "whatsnew-app"), undefined, { whatsNewDir: dir });

    apps.push(app);

    const me = owner(app);
    const tab = fakeTab(undefined, me);
    const setting = appSettings(app).settings.find((each) => each.id === "onboarding.whatsNew")!;

    await app.attach(tab.client);
    // Someone who used the app before this release: the big one's card, not the small one's.
    assert.deepEqual((await app.hello(me)).user.whatsNew, { version: "0.9", title: "Onboarding", date: "2026-10-28", big: true });
    assert.match(await setting.read(undefined), /^show \(0\.9: Onboarding\)/);

    app.setWhatsNew(me, "seen");
    assert.equal((await app.hello(me)).user.whatsNew, null);
    assert.deepEqual(tab.last("whats-new"), { whatsNew: null });
    await setting.apply(me, "show", undefined);
    assert.equal((await app.hello(me)).user.whatsNew?.version, "0.9");
    assert.throws(() => app.setWhatsNew(me, "later"), /show or seen/);

    // A new person: the welcome first, and past it nothing new to see.
    app.setWelcome(me, "show");
    app.config.updateUser(me.id, { whatsNewSeen: undefined });
    assert.equal((await app.hello(me)).user.whatsNew, null, "the welcome, not the card");
    app.setWelcome(me, "done");
    assert.equal((await app.hello(me)).user.whatsNew, null, "the newest release counts as seen");
});
