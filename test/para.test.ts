// The PARA wiki: pi-para's own tools and context on pi-phone's runtime. Pi writes a page, finds it with qmd's search
// (node:sqlite, no native addon), reads it, and the next prompt carries the wiki's context for the session's project.
import { type App, cleanUp, context, home, lastText, modelTexts, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

let told = "";
const page = {
    category: "resources",
    slug: "terminal-reattach",
    title: "Terminal reattach",
    scope: ["work"],
    tags: ["terminal"],
    body: "## Key facts\n\nA shell outlives its socket for fifteen minutes; a page takes it up again by its id.\n",
    mode: "create",
};
const route: FauxResponseStep = (request) => {
    for (const message of (request as { messages: { role: string; sections?: Record<string, string | null> }[] }).messages) {
        if (message.role === "system" && message.sections?.wiki) {
            told = message.sections.wiki;
        }
    }

    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("remember this")) {
        return fauxAssistantMessage([fauxToolCall("wiki_write", { pages: [page], logSummary: "terminal reattach" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("what do we know")) {
        return fauxAssistantMessage([fauxToolCall("wiki_query", { query: "shell socket reattach" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("read it")) {
        return fauxAssistantMessage([fauxToolCall("wiki_read", { path: "resources/terminal-reattach" })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : "ok")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function turn(id: Parameters<App["commands"]["submit"]>[0], text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id)).at(-1)!;
}

test("Pi writes a wiki page, finds it, reads it, and the prompt carries the project's wiki context", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await turn(id, "remember this");
    const file = join(home, ".pi", "wiki", "resources", "terminal-reattach.md");

    assert.ok(existsSync(file), "the page is pi-para's file, in pi-para's wiki folder");
    assert.match(readFileSync(file, "utf8"), /^---\n[^]*title: Terminal reattach[^]*---\n/);
    assert.ok(existsSync(join(home, ".pi", "para", "config.jsonc")), "pi-para's own config");

    const found = await turn(id, "what do we know");

    assert.match(found, /terminal-reattach/, found);

    const read = await turn(id, "read it");

    assert.match(read, /outlives its socket/, read);

    // The session's scope is its folder's name ("work"): the page is in its context now.
    assert.match(told, /wiki_query/, "pi-para's guidance");
    assert.match(told, /terminal-reattach/, told);
});

test("the Wiki page's routes: the tree, a page with its backlinks, search, and saving through pi-para's wiki_write", async () => {
    const tree = await app.para.tree();

    assert.ok(tree.categories.resources!.some((each) => each.path === "resources/terminal-reattach"), JSON.stringify(tree));

    const raw = "---\ntitle: Shell sessions\npara: resources\nscope:\n  - work\ntags:\n  - terminal\n---\n\nSee [[terminal-reattach]] for how a page takes a shell up again.\n";

    await app.para.save("resources/shell-sessions", raw, true);
    await assert.rejects(app.para.save("resources/shell-sessions", raw, true), /already exists/);
    assert.match(readFileSync(join(home, ".pi", "wiki", "resources", "shell-sessions.md"), "utf8"), /title: Shell sessions/);

    const page = await app.para.page("resources/terminal-reattach");

    assert.equal(page?.title, "Terminal reattach");
    assert.deepEqual(page?.backlinks.map((each) => each.path), ["resources/shell-sessions"]);
    assert.match(page!.raw, /^---\n/);
    assert.equal(await app.para.page("resources/nothing-here"), null);
    await assert.rejects(app.para.page("../etc/passwd"), /not a wiki page's path/);

    // The edit is the file now: saving replaces it.
    await app.para.save("resources/shell-sessions", raw.replace("how a page", "how the app"), false);
    assert.match(readFileSync(join(home, ".pi", "wiki", "resources", "shell-sessions.md"), "utf8"), /how the app/);

    for (let tries = 0; tries < 50; tries++) {
        if ((await app.para.search("socket")).some((each) => each.path === "resources/terminal-reattach")) {
            break;
        }

        await new Promise((resolve) => setTimeout(resolve, 200));
    }

    assert.ok((await app.para.search("socket")).some((each) => each.path === "resources/terminal-reattach"));
    const status = await app.para.status();

    assert.equal(status.pages, 2);
    assert.equal(status.embedding, null);
    assert.ok(status.log.length > 0);
});
