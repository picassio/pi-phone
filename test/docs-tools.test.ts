// Pi's document tools in a running app (PP-48), on the phone: Pi writes a page into a folder it makes, reads it back,
// edits it, lists and searches its documents, and lists its versions; its saves are named "Pi (person)".
import { type App, cleanUp, newSession, openApp, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxResponseStep } from "@earendil-works/pi-ai";

let app: App;
const results: string[] = [];
const calls: Record<string, [string, Record<string, unknown>]> = {
    "write it": ["doc_write", { title: "Release notes", body: "Shipped documents.", folder: "Notes/2026" }],
    "read it": ["doc_read", { page: "Release notes" }],
    "edit it": ["doc_edit", { page: "Release notes", edits: [{ oldText: "documents", newText: "documents and boards" }] }],
    "list them": ["doc_list", {}],
    "search them": ["doc_search", { query: "boards" }],
    "its history": ["doc_history", { page: "Release notes" }],
};

const route: FauxResponseStep = (ctx) => {
    const messages = (ctx as { messages: { role: string; content: unknown }[] }).messages;
    const last = messages.at(-1)!;

    if (last.role === "toolResult") {
        results.push(JSON.stringify(last.content));

        return fauxAssistantMessage([fauxText("done")]);
    }

    const text = JSON.stringify(last.content);
    const [tool, args] = Object.entries(calls).find(([ask]) => text.includes(ask))![1];

    return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
};

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "docs-tools-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("Pi writes, reads, edits, lists and searches documents, named as Pi", async () => {
    const id = await newSession(app);

    for (const ask of Object.keys(calls)) {
        await say(app, id, ask);
    }

    const [wrote, read, edited, listed, found, history] = results;

    assert.match(wrote!, /Saved Release notes \(Mine › Notes › 2026\)/);
    assert.match(read!, /# Release notes \(Mine › Notes › 2026; last saved by Pi \(/);
    assert.match(read!, /Shipped documents\./);
    assert.match(edited!, /Edited Release notes/);
    assert.match(listed!, /Notes\/[\s\S]*2026\/[\s\S]*- Release notes \(by Pi \(/);
    assert.match(found!, /Release notes \(Mine › Notes › 2026\): .*\*\*boards\*\*/);
    assert.equal(history!.match(/Pi \(/g)?.length, 2, "two versions, both Pi's");
});
