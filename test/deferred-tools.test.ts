// The rarer tools load when Pi needs them (PP-276): a new session is not offered them, tool_search loads them for the
// rest of the session, a session whose tools are all is offered every tool, and starting phone control offers its
// screen tools.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { DEFERRED_TOOLS, TOOL_SEARCH_NOTE } from "../src/server/deferred-tools.ts";

type Message = { role: string; sections?: Record<string, string | null>; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };

/** The tools the last request offered, as its transcript's system messages declare them, and their definitions' size. */
let offered = new Set<string>();
let size = 0;
let sections = "";

const route: FauxResponseStep = (request) => {
    const messages = (request as unknown as { messages: Message[] }).messages;
    const tools = new Map<string, number>();
    let declared = "";

    for (const message of messages.filter((each) => each.role === "system")) {
        // A message's removals first: a tool declared again (a change, or a new place in the order) is in both.
        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(tool.name);
        }

        for (const tool of message.toolsAdded ?? []) {
            tools.set(tool.name, JSON.stringify(tool).length);
        }

        declared += Object.values(message.sections ?? {}).join("\n");
    }

    // A session's requests, not the app's own without tools (a session's title).
    if (tools.size > 0) {
        offered = new Set(tools.keys());
        size = [...tools.values()].reduce((sum, each) => sum + each, 0);
        sections = declared;
    }

    const { role, text } = lastText(request as never);

    if (role === "user" && text === "find the documents") {
        return fauxAssistantMessage([fauxToolCall("tool_search", { query: "read a document page" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText("ok")]);
};

let app: App;

/** Some of the deferred tools, each of a family: offered with tools all (so they are there), held back otherwise. */
const HELD = ["doc_read", "session_group_move", "phone_screen", "computer_act", "browser_attach", "wiki_lint", "devices"];

before(async () => {
    app = await openApp(scriptedModel(route), undefined, undefined, {}, { tools: "load" });
});

after(async () => {
    await app.close();
    cleanUp();
});

async function turn(id: Awaited<ReturnType<typeof newSession>>, text: string): Promise<void> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);
}

test("a new session is not offered the rarer tools, and is told how to load them", async () => {
    const id = await newSession(app);

    assert.equal(app.contextPolicy(id as never).tools, "load");
    await turn(id, "hello");
    assert.ok(offered.has("tool_search"));
    assert.ok(offered.has("read") && offered.has("browser_open") && offered.has("phone_control"), "the everyday tools");

    for (const name of HELD) {
        assert.ok(DEFERRED_TOOLS.includes(name));
        assert.ok(!offered.has(name), `${name} waits for tool_search`);
    }

    assert.ok(sections.includes(TOOL_SEARCH_NOTE));
});

test("tool_search loads what matches: offered from the next call, for the rest of the session", async () => {
    const id = await newSession(app);

    await turn(id, "find the documents");
    assert.ok(offered.has("doc_read"), "loaded");
    await turn(id, "and again");
    assert.ok(offered.has("doc_read"), "still offered");
    assert.ok(!offered.has("session_group_move"), "only what matched");
});

test("a session whose tools are all is offered every tool, and the setting for every session leaves it be", async () => {
    const id = await newSession(app);

    await turn(id, "hello");
    const lean = size;


    await app.setContextPart(owner(app), "tools", "all", id as never);
    await turn(id, "hello again");
    assert.ok(!offered.has("tool_search"));

    for (const name of HELD) {
        assert.ok(offered.has(name), `${name} offered`);
    }

    console.log(`tools offered: load ${lean} characters, all ${size} (${offered.size} tools)`);
    assert.ok(lean < size * 0.7, `load ${lean} is well under all ${size}`);

    await app.setContextPart(owner(app), "tools", "inherit", id as never);
    await turn(id, "and back");
    assert.ok(offered.has("tool_search"), [...offered].join(" "));
    assert.ok(!offered.has("phone_screen"), [...offered].join(" "));
});
