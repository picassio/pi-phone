// The hook "Remind to check UI before finishing" (PP-422, src/server/ui-reminder.ts): a turn that ends with a UI file
// changed after Pi's last look gets one follow-up naming it, sent by the hook (as the transcript shows); a look after the
// edit, a change to no UI file, or the hook off gets none; and a turn gets it once at most, however Pi ends again.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ClientEntry } from "../src/server/projection.ts";
import { isUiFile, REMINDER_PREFIX, uncheckedUi } from "../src/server/ui-reminder.ts";
import { Screenshots } from "../src/server/screenshots.ts";

const CSS = join(work, "site", "style.css");
const write = (path: string) => fauxToolCall("write", { path, content: "a { color: #111 }\n" });
/** What Pi does for each request, a call at a time; then it answers. */
const SCRIPTS: [RegExp, ReturnType<typeof fauxToolCall>[]][] = [
    [/edit the css$/, [write(CSS)]],
    [/edit and look$/, [write(CSS), fauxToolCall("screenshot", { path: join(work, "site", "page.html"), widths: [390] })]],
    [/edit the code$/, [write(join(work, "src", "app.ts"))]],
    // Told by the hook, Pi edits again and ends without a look: no second reminder.
    [/^\[via hook ui-reminder\] /, [write(CSS)]],
];
const route: FauxResponseStep = (request) => {
    const messages = (request as { messages: { role: string; content: unknown }[] }).messages.filter((message) => message.role !== "system");
    const start = messages.findLastIndex((message) => message.role === "user");
    const asked = lastText({ messages: messages.slice(0, start + 1) }).text;
    const done = messages.slice(start + 1).filter((message) => message.role === "toolResult").length;
    const script = SCRIPTS.find(([pattern]) => pattern.test(asked))?.[1] ?? [];

    return done < script.length ? fauxAssistantMessage([script[done]!], { stopReason: "toolUse" }) : fauxAssistantMessage([fauxText(`done: ${asked.slice(0, 40)}`)]);
};
let app: App;
const stop = new AbortController();

/** Stands in for the phone's renderer: every page renders, with nothing out of place. */
async function phone(screenshots: Screenshots): Promise<void> {
    let at = -1;

    while (!stop.signal.aborted) {
        const { seq, requests } = await screenshots.after(at, stop.signal);

        for (const request of requests) {
            screenshots.answer(request.id, {
                shots: request.widths.map((width) => ({
                    width,
                    height: 800,
                    parts: [Buffer.from("x").toString("base64")],
                    check: JSON.stringify({ width, height: 800, checked: 3, issues: [], more: 0, found: [], totals: {}, summary: { fontSizes: [], colors: [], families: [], icons: [], strokes: [] } }),
                })),
            });
        }

        at = seq;
    }
}

before(async () => {
    app = await openApp(scriptedModel(route));
    app.serverPort = 8799;
    await app.screenshots.after(-1, new AbortController().signal);
    void phone(app.screenshots);
});

after(async () => {
    stop.abort();
    await app?.close();
    cleanUp();
});

async function ask(text: string): Promise<{ texts: string[]; reminders: string[] }> {
    const id = await newSession(app);
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const texts = await modelTexts(app, id);

    // The messages that are the reminder (Pi's own answers quote it here).
    return { texts, reminders: texts.filter((each) => each.startsWith(`"${REMINDER_PREFIX}`) || each.startsWith(`[{"type":"text","text":"${REMINDER_PREFIX}`)) };
}

test("a turn that ends with a CSS file changed and not looked at gets one reminder, from the hook, naming it", async () => {
    const { texts, reminders } = await ask("edit the css");

    assert.equal(reminders.length, 1, texts.join("\n"));
    assert.ok(reminders[0]!.includes(`${REMINDER_PREFIX}You changed UI after your last look at it: ${CSS}.`), reminders[0]!);
    assert.match(reminders[0]!, /Check it with screenshot at 390, 1280 and 1920 px/);
    // Pi went on after it: edited again and ended without a look, and the turn got no second reminder.
    assert.match(texts.at(-1)!, /done: \[via hook ui-reminder\]/);
});

test("an edit then a screenshot, or an edit of no UI file, ends the turn without a reminder", async () => {
    const looked = await ask("edit and look");

    assert.deepEqual(looked.reminders, []);
    assert.match(looked.texts.join("\n"), /as the phone renders it: 390×800/, "the screenshot ran");
    assert.match(looked.texts.at(-1)!, /done: edit and look/);

    const code = await ask("edit the code");

    assert.deepEqual(code.reminders, []);
    assert.match(code.texts.at(-1)!, /done: edit the code/);
});

test("with the hook off, nothing is sent", async () => {
    app.setHook(owner(app), "uiReminder", false);

    try {
        assert.deepEqual((await ask("edit the css")).reminders, []);
    } finally {
        app.setHook(owner(app), "uiReminder", true);
    }
});

/** A tool call in an assistant entry, and its result. */
const call = (id: number, name: string, args: Record<string, unknown>, isError = false): ClientEntry[] => [
    { id, kind: "assistant", blocks: [{ type: "toolCall", id: `c${id}`, name, args }] },
    { id: id + 0.5, kind: "toolResult", callId: `c${id}`, name, text: "", isError },
];

test("what counts: UI files by kind, a codemode script's calls, failed calls not, the last look, artifacts with the check off", () => {
    for (const path of ["page.html", "a/b.htm", "style.css", "icon.svg", "App.tsx", "x.jsx", "C.vue", "S.svelte", "web/ui.js", "pkg/web/sheets/hooks.js"]) {
        assert.ok(isUiFile(path), path);
    }

    for (const path of ["src/server/app.ts", "scripts/build.js", "README.md", "website.js"]) {
        assert.ok(!isUiFile(path), path);
    }

    const start: ClientEntry = { id: 0, kind: "user", text: "go", images: 0 };

    assert.deepEqual(uncheckedUi([start, ...call(1, "edit", { path: "web/a.css" }), ...call(2, "write", { path: "src/x.ts" })], false), ["web/a.css"]);
    assert.deepEqual(uncheckedUi([start, ...call(1, "edit", { path: "web/a.css" }), ...call(2, "redline", { url: "x" })], false), []);
    assert.deepEqual(uncheckedUi([start, ...call(1, "screenshot", {}), ...call(2, "edit", { path: "web/a.css" }), ...call(3, "edit", { path: "web/a.css" })], false), ["web/a.css"]);
    assert.deepEqual(uncheckedUi([start, ...call(1, "edit", { path: "web/a.css" }, true)], false), [], "an edit that failed changed nothing");
    assert.deepEqual(uncheckedUi([start, ...call(1, "edit", { path: "web/a.css" }), ...call(2, "screenshot", {}, true)], false), ["web/a.css"], "a look that failed saw nothing");
    assert.deepEqual(uncheckedUi([start, ...call(1, "artifact", { id: "demo" })], true), ["artifact demo"]);
    assert.deepEqual(uncheckedUi([start, ...call(1, "artifact", { id: "demo" })], false), [], "the artifact check looked at it");
    // Once a turn: after the reminder, nothing more.
    assert.deepEqual(uncheckedUi([start, ...call(1, "edit", { path: "a.css" }), { id: 2, kind: "user", text: `${REMINDER_PREFIX}You changed UI`, images: 0 }, ...call(3, "edit", { path: "b.css" })], false), []);

    // A codemode script's calls, as its result lists them: a cut write's path is still read.
    const script: ClientEntry[] = [
        { id: 1, kind: "assistant", blocks: [{ type: "toolCall", id: "s1", name: "codemode", args: { code: "…" } }] },
        {
            id: 2,
            kind: "toolResult",
            callId: "s1",
            name: "codemode",
            text: "",
            isError: false,
            details: { calls: [{ name: "browser_screenshot", status: "ok", args: "{}" }, { name: "write", status: "ok", args: '{"path":"web/sheets/x.js","content":"cut…' }, { name: "edit", status: "error", args: '{"path":"web/y.css"}' }] },
        },
    ];

    assert.deepEqual(uncheckedUi([start, ...script], false), ["web/sheets/x.js"]);
});
