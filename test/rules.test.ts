// The rules that make Pi use its tools, each in its module's prompt section: ask with interview, research the web with
// web_search and fetch_content, suggest plan mode before large or risky changes (and plan mode's own text once it is on).
import { type App, cleanUp, context, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

let sections: Record<string, string | null> = {};
const route: FauxResponseStep = (request) => {
    for (const message of (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections) {
            sections = { ...sections, ...message.sections };
        }
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

async function say(id: Parameters<App["commands"]["submit"]>[0], text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
}

test("every prompt says when to interview, how to research the web, and when to suggest plan mode", async () => {
    const id = await newSession(app);

    await say(id, "hello");
    assert.match(sections.asking ?? "", /call interview instead of writing the questions in chat/);
    assert.match(sections.web ?? "", /research with web_search, then read what you need with fetch_content/);
    assert.match(sections.plan_mode ?? "", /suggest that the person turn on plan mode/);

    await app.commands.setPlan(id, owner(app), true);
    await say(id, "plan something");
    assert.match(sections.plan_mode ?? "", /Plan mode is on/);
});
