// What the app's background service notifies the owner of: a session's run ending, with its answer.
import { type App, cleanUp, context, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { resolveLanguage, translator } from "../src/server/i18n.ts";
import { inLanguage, said } from "../src/server/phone-events.ts";

let app: App;

before(async () => {
    app = await openApp(scriptedModel());
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("the phone's notifications are said in the owner's language: their choice, or with Auto the phone's (PP-85)", () => {
    // Auto follows the phone's own language (Android's locale tag); a choice wins over it.
    assert.equal(resolveLanguage("auto", "zh-Hans-CN"), "zh-CN");
    assert.equal(resolveLanguage(undefined, "zh-TW"), "zh-CN");
    assert.equal(resolveLanguage("auto", "vi-VN"), "vi", "Vietnamese (PP-236)");
    assert.equal(resolveLanguage("auto", "fr-FR"), "en");
    assert.equal(resolveLanguage("vi", "en-US"), "vi");
    assert.equal(resolveLanguage("en", "zh-CN"), "en");
    assert.equal(resolveLanguage("zh-CN", "en-US"), "zh-CN");

    const asked = said("Pi has {n} questions: {title}", { n: 3, title: "Plan" });
    const event = { seq: 1, at: 0, kind: "approval" as const, session: 7, title: "Fix the build", text: translator("en")(asked.text, asked.vars), say: { text: asked } };
    const english = inLanguage(event, translator("en"));

    assert.equal(english.heading, "Waiting for you: Fix the build");
    assert.equal(english.text, "Pi has 3 questions: Plan");

    const vietnamese = inLanguage(event, translator("vi"));

    assert.equal(vietnamese.heading, "Đang chờ bạn: Fix the build");
    assert.equal(vietnamese.text, "Pi có 3 câu hỏi: Plan");

    const chinese = inLanguage(event, translator("zh-CN"));

    assert.equal(chinese.heading, "等你处理：Fix the build", "the session's title is data: as it is");
    assert.equal(chinese.text, "Pi 有 3 个问题：Plan");

    // Pi's own words stay Pi's; the app's "Done." and the security notice are said in the language.
    const answered = inLanguage({ seq: 2, at: 0, kind: "done", session: 7, title: "Fix the build", text: "All green." }, translator("zh-CN"));

    assert.deepEqual([answered.heading, answered.text], ["已完成：Fix the build", "All green."]);
    assert.equal(inLanguage({ seq: 3, at: 0, kind: "done", session: 7, title: "x", text: "Done.", say: { text: said("Done.") } }, translator("zh-CN")).text, "已完成。");
    assert.equal(
        inLanguage({ seq: 4, at: 0, kind: "security", session: 0, title: "Your recovery code was used", text: "…", say: { title: said("Your recovery code was used") } }, translator("zh-CN")).heading,
        "你的恢复码已被使用",
    );
});

test("a session's run ending reaches the phone's poll, with the end of its answer, and only what is new", async () => {
    const start = await app.phoneEvents.after(-1, new AbortController().signal);

    assert.deepEqual(start.events, []);
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    const polled = app.phoneEvents.after(start.seq, new AbortController().signal);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "ping", requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    const { seq, events } = await polled;

    assert.equal(events.length, 1);
    assert.equal(events[0]!.kind, "done");
    assert.equal(events[0]!.session, Number(id));
    assert.equal(events[0]!.text, "echo: ping");

    // Nothing new: the poll waits, and answers with nothing when asked to stop.
    const waiting = new AbortController();
    const next = app.phoneEvents.after(seq, waiting.signal);

    waiting.abort();
    assert.deepEqual((await next).events, []);
});
