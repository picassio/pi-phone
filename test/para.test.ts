// The PARA wiki: pi-para's own tools and context on pi-phone's runtime. Pi writes a page, finds it with qmd's search
// (node:sqlite, no native addon), reads it, and the next prompt carries the wiki's context for the session's project.
import { type App, cleanUp, context, home, lastText, modelTexts, openApp, owner, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { projectEntry } from "../src/server/projection.ts";

let told = "";
/** How many system messages of the last request carry the wiki section: one, unless it was sent again. */
let wikiCopies = 0;
/** The text parts of the last request's last person's message. */
let userParts: string[] = [];
/** What the capture session was sent, the last time. */
let captureText = "";
/** The tools the capture session was offered, the last time it asked. */
let captureTools: string[] = [];
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
    const messages = (request as { messages: { role: string; content?: unknown; sections?: Record<string, string | null> }[] }).messages;

    wikiCopies = 0;

    for (const message of messages) {
        if (message.role === "system" && message.sections?.wiki) {
            told = message.sections.wiki;
            wikiCopies++;
        }
    }

    const person = messages.filter((message) => message.role === "user").at(-1)?.content;

    userParts = Array.isArray(person) ? (person as { type: string; text?: string }[]).flatMap((part) => (part.type === "text" ? [part.text ?? ""] : [])) : [String(person ?? "")];

    const { role, text } = lastText(request as never);

    if (role === "user" && text.includes("<session-conversation>") && text.includes("rewrite the reattach page")) {
        // A capture model that "updates" a page by replacing it with its new section alone.
        return fauxAssistantMessage(
            [fauxToolCall("wiki_write", { pages: [{ ...page, mode: "replace", body: "## Only the new section\n" }] })],
            { stopReason: "toolUse" },
        );
    }

    if (role === "user" && text.includes("<session-conversation>")) {
        captureText = text;
        // Tools come with the transcript's system messages.
        captureTools = (request as { messages: { role: string; toolsAdded?: { name: string }[] }[] }).messages.flatMap((message) =>
            message.role === "system" ? (message.toolsAdded ?? []).map((each) => each.name) : [],
        );

        return fauxAssistantMessage(
            [
                fauxToolCall("wiki_write", {
                    pages: [{ ...page, slug: "captured-fact", title: "Captured fact", body: `## Key facts\n\n${text.includes("the deploy key") ? "The deploy key is at ~/.ssh/deploy." : "?"}\n` }],
                }),
            ],
            { stopReason: "toolUse" },
        );
    }

    // Calls the wiki rule refuses, or lets through.
    const direct: Record<string, [string, Record<string, unknown>]> = {
        "ask in the wiki": [
            "wiki_write",
            {
                pages: [
                    {
                        category: "resources",
                        slug: "door-codes",
                        title: "Door codes",
                        scope: ["work"],
                        tags: ["office"],
                        body: "## Key Facts\n- The office door has a keypad.\n\n## Open Questions\n- [ ] (2026-10-01, #1) Which keypad code opens the office door at night?\n",
                        mode: "create",
                    },
                ],
            },
        ],
        "answer in the wiki": [
            "wiki_write",
            {
                pages: [
                    {
                        category: "resources",
                        slug: "night-access",
                        title: "Night access",
                        scope: ["work"],
                        tags: ["office"],
                        body: "## Key Facts\n- At night the office door keypad code is 4711.\n",
                        mode: "create",
                    },
                ],
            },
        ],
        // Full paths: `~` is the process's own home in the tools, which in tests is not the test app's.
        "write the wiki file": ["write", { path: join(home, ".pi", "wiki", "resources", "sneaky.md"), content: "---\ntitle: x\n---\n" }],
        "edit the wiki file": ["edit", { path: join(home, ".pi", "wiki", "index.md"), edits: [{ oldText: "Wiki", newText: "Wikkki" }] }],
        "append with bash": ["bash", { command: `echo hi >> ${join(home, ".pi", "wiki", "log.md")}` }],
        "read with bash": ["bash", { command: `cat ${join(home, ".pi", "wiki", "index.md")}` }],
        "write elsewhere": ["write", { path: join(work, "notes.txt"), content: "fine\n" }],
    };

    for (const [ask, [tool, args]] of Object.entries(direct)) {
        if (role === "user" && text.endsWith(ask)) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    // An edit and an append of one page in one message: Pi runs them side by side.
    if (role === "user" && text.endsWith("edit and append at once")) {
        return fauxAssistantMessage(
            [
                fauxToolCall("wiki_edit", { path: "resources/terminal-reattach", edits: [{ oldText: "fifteen minutes", newText: "twenty minutes" }] }),
                fauxToolCall("wiki_write", { pages: [{ ...page, mode: "append", body: "## Appended\n\nA second fact.\n" }] }),
            ],
            { stopReason: "toolUse" },
        );
    }

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

    // With the wiki's index in the prompt (PP-276's live; the default brings matching pages with each message instead).
    await app.setContextPart(owner(app), "wiki", "live", id);
    await turn(id, "hello");
    // The session's scope is its folder's name ("work"): the page is in its context now.
    assert.match(told, /wiki_query/, "pi-para's guidance");
    // pi-para's own skill leads the section; its short guidance list is left out.
    assert.match(told.trimStart(), /^(<wiki>\s*)?# PARA Active Knowledge/);
    assert.match(told, /Before You Start — Consult/);
    assert.doesNotMatch(told, /## pi-para Wiki Tool Guidance/);
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
    // At once, by keyword alone: what the Wiki page shows before meaning is added.
    const keywords = await app.para.searchKeywords("socket");
    const hit = keywords.find((each) => each.path === "resources/terminal-reattach");

    assert.equal(hit?.title, "Terminal reattach");
    assert.match(hit!.snippet, /socket/);
    const status = await app.para.status();

    assert.equal(status.pages, 2);
    assert.equal(status.embedding, null);
    assert.ok(status.log.length > 0);
});

test("an idle session is captured into the wiki by the capture session, once, with the wiki tools alone", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await turn(id, "the deploy key is at ~/.ssh/deploy");

    // pi-para's capture model is "auto": the app's default model, which is none yet.
    assert.match((await app.paraCapture.capture(id)).why ?? "", /pick a capture model/);
    await app.setDefaultModel(owner(app), { provider: "faux", modelId: "faux-1" });

    const sent = await app.paraCapture.capture(id);

    assert.equal(sent.sent, true);
    const capture = sent.conversation! as never;

    await app.harness.waitForIdle(context);
    assert.ok(existsSync(join(home, ".pi", "wiki", "resources", "captured-fact.md")));
    assert.match(readFileSync(join(home, ".pi", "wiki", "resources", "captured-fact.md"), "utf8"), /deploy key is at/);
    assert.deepEqual(captureTools.filter((name) => !name.startsWith("wiki_")), [], captureTools.join(", "));
    assert.ok(captureTools.includes("wiki_query"));

    const meta = app.sessionMeta(capture)!;

    assert.equal(meta.wikiCapture, true);
    assert.equal(meta.archived, true);
    assert.deepEqual(await app.paraCapture.capture(id), { sent: false, why: "nothing new since the last capture" });
    assert.match(JSON.stringify(await app.paraCapture.status()), /"model":"faux\/faux-1"/);
    assert.deepEqual(await app.paraCapture.capture(capture), { sent: false, why: "only sessions are captured" });
});

test("open questions: the prompt lists them and names the session, a write that may answer one says so, and a capture sees them all", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    // The index with its open questions in the prompt (PP-276's live).
    await app.setContextPart(owner(app), "wiki", "live", id);
    await turn(id, "ask in the wiki");
    await turn(id, "hello");

    assert.match(told, new RegExp(`This is pi-phone session #${String(id)}: write it in the wiki's open questions`));
    assert.match(told, /## Open Questions in the Wiki \(1\)/);
    assert.match(told, /Which keypad code opens the office door at night\? — on \[\[door-codes\]\]/);

    // Written on another page, an answer is pointed out, with how to resolve it.
    const answered = await turn(id, "answer in the wiki");

    assert.match(answered, /This may answer an open question in the wiki/, answered);
    assert.match(answered, /«Which keypad code opens the office door at night\?» on resources\/door-codes/);

    // A capture is shown every open question, to resolve the ones its session answered.
    await app.setDefaultModel(owner(app), { provider: "faux", modelId: "faux-1" });
    await turn(id, "the night code changed today");
    assert.equal((await app.paraCapture.capture(id)).sent, true);
    await app.harness.waitForIdle(context);
    assert.match(captureText, /## Open questions in the wiki/);
    assert.match(captureText, new RegExp(`as session #${String(id)}, dated today`));
    assert.match(captureText, /Which keypad code opens the office door at night\?/);

    // The setting for when they are stale.
    assert.equal((await app.para.settings()).lintQuestionDays, 7);
    assert.equal((await app.para.updateSettings({ lintQuestionDays: 14 })).lintQuestionDays, 14);
    await assert.rejects(app.para.updateSettings({ lintQuestionDays: 0 }), /from 1 to 365/);
    await app.para.updateSettings({ lintQuestionDays: 7 });
});

test("Wiki settings change pi-para's config, which people never edit; wrong values and a missing sign-in are refused", async () => {
    const before = await app.para.settings();

    assert.equal(before.captureModel, "auto");
    assert.equal(before.embeddingModel, null);

    const after = await app.para.updateSettings({ captureModel: "faux/faux-1", contextTokens: 3000, lintStaleDays: 30 });

    assert.equal(after.captureModel, "faux/faux-1");
    assert.equal(after.contextTokens, 3000);
    const file = readFileSync(join(home, ".pi", "para", "config.jsonc"), "utf8");

    assert.match(file, /"faux-1"/);
    assert.match(file, /"maxTokens": 3000/);
    assert.match(JSON.stringify(await app.paraCapture.status()), /faux\/faux-1/);

    await assert.rejects(app.para.updateSettings({ captureModel: "nowhere/none" }), /not a signed-in model/);
    await assert.rejects(app.para.updateSettings({ contextTokens: 10 }), /from 500 to 32000/);
    await assert.rejects(app.para.updateSettings({ embeddingModel: "openai/text-embedding-3-small" }), /Sign in to OpenRouter first/);

    app.paraCapture.setMinutes(null);
    assert.equal(app.config.wikiCaptureMinutes, null);
    assert.throws(() => app.paraCapture.setMinutes(0), /from 1 to 1440/);
    app.paraCapture.setMinutes(20);
    await app.para.updateSettings({ captureModel: "auto", contextTokens: 4000 });
});

test("search by meaning: qmd embeds the pages through an OpenAI-style embeddings API and keeps the vectors in sqlite-vec", async () => {
    const { createServer } = await import("node:http");
    const { loadParaConfig, saveParaConfig } = await import("pi-para/config");
    let asked = 0;
    // Letters as a vector: enough for qmd to store and compare, without a model.
    const embed = (text: string) => {
        const vector = Array.from({ length: 32 }, () => 0);

        for (const char of text.toLowerCase()) {
            vector[char.charCodeAt(0) % 32]! += 1;
        }

        const norm = Math.hypot(...vector) || 1;

        return vector.map((value) => value / norm);
    };
    const server = createServer((request, response) => {
        let body = "";

        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
            asked++;
            const given = (JSON.parse(body) as { input: string | string[] }).input;
            const input = Array.isArray(given) ? given : [given];

            response.setHeader("content-type", "application/json");
            response.end(JSON.stringify({ data: input.map((text, index) => ({ index, embedding: embed(text) })) }));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const loaded = await loadParaConfig({ homeDir: home });

    try {
        loaded.config.qmd = {
            ...loaded.config.qmd,
            embedEnabled: true,
            providerConfig: "pi-para-profiles",
            embedding: { provider: "openrouter", baseUrl: url, model: "letters-32", credentialRef: "none" },
        };
        await saveParaConfig(loaded.config, { homeDir: home });
        await app.para.reopen();
        await app.para.embed();

        const status = await app.para.status();

        assert.ok(asked > 0, "the embeddings API was asked");
        assert.equal(status.search.vectors, true);
        assert.equal(status.search.needsEmbedding, 0);
        assert.equal(status.embedding, "openrouter/letters-32");
        assert.ok((await app.para.search("socket")).length > 0);
    } finally {
        loaded.config.qmd.embedEnabled = false;
        await saveParaConfig(loaded.config, { homeDir: home });
        await app.para.reopen();
        server.close();
    }
});

test("never a local model: qmd is told so before it loads, and node-llama-cpp is nowhere in node_modules", async () => {
    const { execFileSync } = await import("node:child_process");

    assert.equal(process.env.QMD_NO_LOCAL_MODELS, "1");
    assert.equal(process.env.QMD_SQLITE_DRIVER, "node");
    const found = execFileSync("find", ["node_modules", "-type", "d", "-name", "node-llama-cpp"], { encoding: "utf8" }).trim();

    assert.equal(found, "", found);
});

test("Pi changes the wiki only through its tools: writes, edits, and changing commands on its files are refused", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });

    for (const ask of ["write the wiki file", "edit the wiki file", "append with bash"]) {
        assert.match(await turn(id, ask), /changes only through its tools/, ask);
    }

    assert.ok(!existsSync(join(home, ".pi", "wiki", "resources", "sneaky.md")));
    assert.doesNotMatch(readFileSync(join(home, ".pi", "wiki", "index.md"), "utf8"), /Wikkki/);
    assert.doesNotMatch(readFileSync(join(home, ".pi", "wiki", "log.md"), "utf8"), /^hi$/m);
    assert.doesNotMatch(await turn(id, "read with bash"), /changes only through its tools/);
    assert.doesNotMatch(await turn(id, "write elsewhere"), /changes only through its tools/);
    assert.equal(readFileSync(join(work, "notes.txt"), "utf8"), "fine\n");
    assert.match(told, /never write, edit, move, or delete files under ~\/\.pi\/wiki/);
});

const reattach = () => readFileSync(join(home, ".pi", "wiki", "resources", "terminal-reattach.md"), "utf8");

test("an edit and an append of one page side by side both land: wiki calls take turns, and the page stays whole", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await turn(id, "remember this");
    assert.match(reattach(), /fifteen minutes/);
    await turn(id, "edit and append at once");

    const now = reattach();

    assert.match(now, /^title: Terminal reattach$/m, now);
    assert.match(now, /twenty minutes/, "the edit");
    assert.match(now, /## Appended\n\nA second fact\./, "the append");
    assert.match(now, /a page takes it up again by its id/, "the page before them");
});

test("a capture never replaces a page that is there: it is told to append or edit, and the page stays", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await turn(id, "please rewrite the reattach page");
    const before = reattach();
    const sent = await app.paraCapture.capture(id);

    assert.equal(sent.sent, true);
    await app.harness.waitForIdle(context);
    assert.equal(reattach(), before, "the page as it was");
    assert.match((await modelTexts(app, sent.conversation! as never)).join("\n"), /A capture never replaces a page that is there \(resources\/terminal-reattach\)/);
});

test("the wiki tool (PP-276, the default): a fixed section, Pi searches itself; nothing comes with messages, nor with writes elsewhere", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    assert.equal(app.contextPolicy(id).wiki, "tool");
    await turn(id, "why does the shell outlive its socket");
    assert.match(told, /The wiki's index is not in this prompt: search it with wiki_query before non-trivial work/);
    assert.match(told, /wiki scope: work/);
    assert.doesNotMatch(told, /terminal-reattach|Open Questions in the Wiki/, "no index, no list of questions");
    assert.deepEqual(userParts, ["why does the shell outlive its socket"], "no pages with a message about one");

    await app.para.save(
        "resources/desk-lamp",
        "---\ntitle: Desk lamp\npara: resources\nscope:\n  - work\ntags:\n  - office\n---\n\nThe desk lamp is by the window.\n",
        true,
    );
    await turn(id, "good morning");
    assert.deepEqual(userParts, ["good morning"], "no word of another session's write");
    assert.equal(wikiCopies, 1, "the section once, as it was");
});

test("the wiki relevant (PP-276, the owner's pick): the pages that match a message come with it; not for a message without a telling word, nor for writes elsewhere", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await app.setContextPart(owner(app), "wiki", "relevant", id);
    await turn(id, "hello there");
    assert.match(told, /The wiki's index is not in this prompt/);
    assert.doesNotMatch(told, /terminal-reattach|Open Questions in the Wiki/, "no index, no list of questions");
    assert.equal(wikiCopies, 1);

    // A message about a page: the page comes with it, in a part of its own, with how fresh it is.
    await turn(id, "why does the shell outlive its socket");
    const block = userParts.find((part) => part.startsWith('<wiki-pages paths="'));

    assert.ok(block !== undefined, userParts.join("\n---\n"));
    assert.match(block, /resources\/terminal-reattach: Terminal reattach \(/);
    assert.match(block, /outlives its socket/);
    assert.equal(userParts[0], "why does the shell outlive its socket", "the person's words as they wrote them");

    // Another session writes to the wiki: not this session's business, and the section is not sent again.
    await app.para.save(
        "resources/office-printer",
        "---\ntitle: Office printer\npara: resources\nscope:\n  - work\ntags:\n  - office\n---\n\nThe printer is on the third floor.\n",
        true,
    );
    await turn(id, "good morning");
    assert.doesNotMatch(userParts.join("\n"), /office-printer/);
    assert.equal(wikiCopies, 1, "the wiki section once, as it was");

    // A message without a telling word is about the conversation: no pages come with it.
    await turn(id, "Làm đi");
    assert.ok(!userParts.some((part) => part.startsWith("<wiki-pages")), userParts.join("\n---\n"));

    // People see their words, and the pages by name.
    const view = await (await app.conversation(id)).viewState(context);

    try {
        const shown = view.value.entries.map((entry) => projectEntry(entry)).filter((entry) => entry?.kind === "user");
        const asked = shown.find((entry) => entry?.kind === "user" && entry.text === "why does the shell outlive its socket");

        assert.ok(asked !== undefined, JSON.stringify(shown));
        assert.deepEqual(asked.kind === "user" ? asked.wiki : undefined, ["resources/terminal-reattach"]);
    } finally {
        view.dispose();
    }
});

test("the wiki frozen and tool (PP-276): the index the session first had, or the rules only, and nothing with messages", async () => {
    const { id } = await app.commands.createSession(owner(app), { cwd: work });

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-1" }, thinkingLevel: "off" });
    await app.setContextPart(owner(app), "wiki", "frozen", id);
    await turn(id, "hello");
    assert.match(told, /terminal-reattach/, "the index");
    assert.doesNotMatch(told, /garden-hose/);

    await app.para.save(
        "resources/garden-hose",
        "---\ntitle: Garden hose\npara: resources\nscope:\n  - work\ntags:\n  - garden\n---\n\nThe garden hose is in the shed.\n",
        true,
    );
    await turn(id, "where is the garden hose kept in the shed");
    assert.doesNotMatch(told, /garden-hose/, "frozen: the index as it was");
    assert.equal(wikiCopies, 1);
    assert.equal(userParts.length, 1, "no pages with the message");

    await app.setContextPart(owner(app), "wiki", "tool", id);
    await turn(id, "hello again");
    assert.match(told, /search it with wiki_query before non-trivial work/);
    assert.doesNotMatch(told, /terminal-reattach/);
    assert.equal(userParts.length, 1);

    // Every session's setting, and a session's own over it.
    await app.setContextPart(owner(app), "wiki", "live");
    assert.equal(app.contextPolicy(id).wiki, "tool");
    await app.setContextPart(owner(app), "wiki", "inherit", id);
    assert.equal(app.contextPolicy(id).wiki, "live");
    await app.setContextPart(owner(app), "wiki", "tool");
    assert.equal(app.config.contextPolicy.wiki, undefined, "the default is not written down");
    await assert.rejects(app.setContextPart(owner(app), "wiki", "everything"), /tool, relevant, frozen, live/);
});
