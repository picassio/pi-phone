// Agents write to each other in their person's language (PP-354, from pi-pocket 0.28.0's d01a97b): a session writes to
// the sessions it starts or messages, and to its subagents, in the language of the person it works for, and asks for
// answers in it; a session answers a message from another session's agent in that message's language. So a session
// the person opens later reads in their language.
import { cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

type System = { role: string; sections?: Record<string, string> };

test("the prompt tells Pi to write to other agents in its person's language, and to answer them in theirs", async () => {
    let sections: Record<string, string> = {};
    const app = await openApp(
        scriptedModel((request) => {
            sections = Object.assign({}, ...(request.messages as System[]).filter((message) => message.role === "system").map((message) => message.sections));

            return fauxAssistantMessage([fauxText("ok")]);
        }),
    );

    try {
        await say(app, await newSession(app), "hello");
    } finally {
        await app.close();
        cleanUp();
    }

    assert.match(sections.subagents ?? "", /Write it in the language of the person you work for, and ask for the report in that language\./);
    assert.match(sections.sessions ?? "", /Write what you send \(session_start, session_send\) in the language of the person you work for, and ask for answers in it/);
    assert.match(sections.guidelines ?? "", /A message starting with "\[via session …\]" comes from another session's agent: answer it in the language of that message\./);
});
