// Claude Code's sessions continued here (PP-496): converted into a Pi session file (text, thinking, tool calls and
// results, images, a compaction's summary), from its last compaction or its last turns when it is long, listed with
// Pi's sessions, and continued as one; the original file is only read. Continued, it starts with this app's default
// model (or one the card picks), with the owner's secrets' values masked in it, and a session without a request is
// titled by its folder and start (PP-498).
import { cleanUp, context, home, lastText, newSession, openApp, owner, root, say, scriptedModel, work, type App } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep, Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { buildSessionContext, convertToLlm, parseSessionEntries, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ConversationId } from "@earendil-works/pi-durable";
import { claudeHead, convertClaude, KEEP_CHARACTERS, projectFolder } from "../src/server/claude-sessions.ts";
import { readPiSession } from "../src/server/pi-sessions.ts";
import { localSource } from "../src/server/session-lines.ts";

const fixtures = join(import.meta.dirname, "fixtures", "claude");
/** Nothing to mask: the converter's tests without the owner's secrets. */
const keep = (text: string) => text;

/** Convert a Claude Code file as the app does; the Pi session file's text, and what continues. */
async function convert(path: string, slug: string) {
    const source = await localSource(path);
    const lines: string[] = [];

    try {
        const converted = await convertClaude(
            source,
            slug,
            async (line) => {
                lines.push(line);
            },
            keep,
        );

        return { ...converted, text: `${lines.join("\n")}\n` };
    } finally {
        await source.close();
    }
}

/** What Pi in the terminal would send the model for a Pi session file's text. */
function piContext(text: string): Message[] {
    const entries = parseSessionEntries(text).slice(1) as SessionEntry[];

    return convertToLlm(buildSessionContext(entries).messages).filter((message) => message.role !== "system");
}

test("a Claude Code session becomes a Pi session: text, thinking, parallel tool calls and their results, images", async () => {
    const { id, cwd, title, kept, text } = await convert(join(fixtures, "tools.jsonl"), "-srv-shop");
    const session = readPiSession(text);
    const messages = session.entries.map((entry) => entry.message);

    assert.equal(id, "5e55e5e5-0000-4000-8000-000000000001");
    assert.equal(cwd, "/srv/shop", "the project's folder, above the folder the shell was in");
    assert.equal(title, "Why does the cart total drift by a cent?");
    assert.equal(session.title, title);
    assert.deepEqual(session.model, { provider: "anthropic", modelId: "claude-fable-5-1" });
    assert.equal(session.thinkingLevel, "medium");
    assert.deepEqual(
        messages.map((message) => message.role),
        ["user", "assistant", "toolResult", "toolResult", "assistant", "user", "assistant"],
    );

    // One answer from its four parts: thinking with its signature, text, and two tool calls made at once.
    const answer = messages[1]!;

    assert.equal(answer.role, "assistant");
    assert.deepEqual(answer.role === "assistant" ? answer.content : [], [
        { type: "thinking", thinking: "Floats, probably.", thinkingSignature: "sig-A" },
        { type: "text", text: "Let me read the cart and its test." },
        { type: "toolCall", id: "toolu_1", name: "Read", arguments: { file_path: "/srv/shop/apps/web/cart.ts" } },
        { type: "toolCall", id: "toolu_2", name: "Bash", arguments: { command: "npm test -- cart" } },
    ]);
    assert.equal(answer.role === "assistant" && answer.stopReason, "toolUse");
    assert.deepEqual(answer.role === "assistant" && answer.usage.cacheWrite, 100);
    assert.deepEqual(
        messages.slice(2, 4).map((message) => message.role === "toolResult" && [message.toolCallId, message.toolName, message.isError]),
        [
            ["toolu_1", "Read", false],
            ["toolu_2", "Bash", true],
        ],
    );
    assert.deepEqual(messages[5]!.content, [
        { type: "text", text: "Here is the receipt." },
        { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ]);
    assert.deepEqual(messages[6]!.role === "assistant" && messages[6]!.content[0], { type: "thinking", thinking: "", thinkingSignature: "opaque", redacted: true });

    // Claude Code's records and its own commands' caveat, a subagent's work, a synthetic reply, and the line cut off
    // while written stay behind.
    const all = JSON.stringify(messages);

    assert.doesNotMatch(all, /local-command-caveat|subagent's own work|API Error|And the ta|file-history|permission/);
    assert.deepEqual(kept, {
        from: "all",
        messages: 7,
        left: 0,
        compactions: 0,
        toolCalls: 2,
        thinking: 2,
        images: 1,
        masked: 0,
        model: "anthropic/claude-fable-5-1",
    });
    // Pi itself reads it the same way.
    assert.deepEqual(piContext(text).map((message) => message.role), messages.map((message) => message.role));
});

test("a compacted session continues from its last compaction: its summary, the messages it keeps, and all after", async () => {
    const { kept, text } = await convert(join(fixtures, "compacted.jsonl"), "-srv-shop");
    const context = piContext(text);
    const said = context.map((message) => JSON.stringify(message.content));

    assert.equal(kept.from, "compaction");
    assert.equal(kept.since, "2026-10-02T09:00:00.200Z");
    assert.equal(kept.messages, 6);
    assert.equal(kept.left, 2, "the first question and answer stay in the file");
    assert.equal(kept.compactions, 1);
    assert.match(said[0]!, /The export plan is agreed/);
    assert.match(said[1]!, /Old question two, kept/);
    assert.match(said[2]!, /Old answer two, kept/);
    assert.match(said[3]!, /Now write the CSV export/);
    assert.equal(context[4]!.role, "assistant");
    assert.equal(context[5]!.role, "toolResult");
    assert.match(said[6]!, /export.csv is written/);
    assert.doesNotMatch(said.join("\n"), /Plan the export|Old answer one/);
    assert.equal(context.length, 7);
});

test("a session too long for the context continues from its last turns that fit, after a summary of what was asked before", async () => {
    const path = join(root, "long.jsonl");
    const lines = [JSON.stringify({ type: "permission-mode", permissionMode: "default", sessionId: "long-1" })];
    let parent: string | null = null;

    for (let turn = 0; turn < 60; turn += 1) {
        const ask = `u${turn}`;
        const reply = `a${turn}`;

        lines.push(
            JSON.stringify({ parentUuid: parent, isSidechain: false, type: "user", message: { role: "user", content: `Request ${turn}: tidy module ${turn}` }, uuid: ask, timestamp: new Date(1_790_000_000_000 + turn * 1000).toISOString(), cwd: "/srv/long", sessionId: "long-1" }),
            JSON.stringify({ parentUuid: ask, isSidechain: false, type: "assistant", message: { id: `msg_${turn}`, role: "assistant", model: "claude-opus-5", content: [{ type: "text", text: `Tidied ${turn}. ${"x".repeat(10_000)}` }], stop_reason: "end_turn" }, uuid: reply, timestamp: new Date(1_790_000_000_500 + turn * 1000).toISOString(), sessionId: "long-1" }),
        );
        parent = reply;
    }

    writeFileSync(path, `${lines.join("\n")}\n`);
    const { kept, text } = await convert(path, "-srv-long");
    const context = piContext(text);
    const summary = JSON.stringify(context[0]!.content);
    const keptText = JSON.stringify(context.slice(1)).length;

    assert.equal(kept.from, "turns");
    assert.ok(kept.messages < 120 && kept.messages >= 2, String(kept.messages));
    assert.equal(kept.left, 120 - kept.messages);
    assert.ok(keptText < KEEP_CHARACTERS * 1.1, `kept ${keptText} characters`);
    assert.match(summary, /left out when it continued in pi-phone/);
    assert.match(summary, /Request 0: tidy module 0/);
    assert.match(JSON.stringify(context.at(-1)), /Tidied 59/);
    assert.match(JSON.stringify(context[1]), /Request \d+: tidy module/, "kept from a request on");
});

test("the list reads a file's first lines: its id, the project's folder, its first request", () => {
    const lines = readFileSync(join(fixtures, "tools.jsonl"), "utf8").split("\n").slice(0, 8);

    assert.deepEqual(claudeHead(lines, "-srv-shop", keep), {
        id: "5e55e5e5-0000-4000-8000-000000000001",
        cwd: "/srv/shop",
        title: "Why does the cart total drift by a cent?",
    });
    assert.equal(projectFolder("/data/projects/agent-crew/apps/web", "-data-projects-agent-crew"), "/data/projects/agent-crew");
    assert.equal(projectFolder("/elsewhere", "-data-projects-agent-crew"), "/elsewhere");
});

test("a session without a request (Claude Code opened and closed: hooks, a notice, its cost) is titled by its folder and start", () => {
    const lines = readFileSync(join(fixtures, "no-request.jsonl"), "utf8").split("\n");

    assert.deepEqual(claudeHead(lines, "-data-projects-agent-crew", keep), {
        id: "5e55e5e5-0000-4000-8000-000000000003",
        cwd: "/data/projects/agent-crew",
        title: "agent-crew · 2026-09-30 01:29 UTC",
        noRequest: true,
    });
});

/** The messages of the newest request to the model. */
let requested: Message[] = [];
const route: FauxResponseStep = (request) => {
    requested = (request as { messages: Message[] }).messages;
    const said = lastText(request as never);

    if (said.role === "user" && said.text.startsWith("tool:")) {
        const [name, ...json] = said.text.slice(5).split(" ");

        return fauxAssistantMessage([fauxToolCall(name!, JSON.parse(json.join(" ")))], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(said.role === "toolResult" ? "done" : `echo: ${said.text}`)]);
};

let app: App;

before(async () => {
    const scripted = scriptedModel(route, { contextWindow: 1_000_000 });
    // Claude Code's model, signed in here as the owner's "anthropic" account was (PP-498): it must not be the one used.
    const claudeHere = fauxProvider({ provider: "anthropic", models: [{ id: "claude-fable-5-1" }] });

    app = await openApp(scripted, join(root, "claude-data"), undefined, {
        configureModels: (models) => {
            models.registerNativeProvider(scripted.provider);
            models.registerNativeProvider(claudeHere.provider);
        },
    });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("Claude Code's sessions are listed with Pi's, and one continues here as a session; its file stays as it was", async () => {
    const folder = join(home, ".claude", "projects", "-srv-shop");
    const path = join(folder, "5e55e5e5-0000-4000-8000-000000000001.jsonl");

    mkdirSync(folder, { recursive: true });
    copyFileSync(join(fixtures, "tools.jsonl"), path);
    const hash = () => createHash("sha256").update(readFileSync(path)).digest("hex");
    const before = hash();
    const listed = (await app.piSessions.list(owner(app))).sessions.find((each) => each.path === path);

    assert.ok(listed, "listed");
    assert.equal(listed.title, "Why does the cart total drift by a cent?");
    assert.equal(listed.cwd, "/srv/shop");
    assert.equal(listed.claudeCode?.size, readFileSync(path).length);

    const { path: converted } = await app.piSessions.importClaude(owner(app), path);
    const preview = await app.piSessions.preview(owner(app), converted);

    assert.equal(preview.claudeCode?.from, "all");
    assert.equal(preview.claudeCode?.messages, 7);
    assert.equal(preview.title, "Why does the cart total drift by a cent?");
    assert.equal(preview.cwdExists, false, "/srv/shop is not on this machine");
    assert.match(preview.last.at(-1)!.text, /cents it is/);

    const { id } = await app.commands.continuePiSession(owner(app), converted, work);
    const view = await (await app.harness.conversation(id, context))!.context(context);
    const roles = (view.messages as Message[]).filter((message) => message.role !== "system").map((message) => message.role);

    assert.deepEqual(roles, ["user", "assistant", "toolResult", "toolResult", "assistant", "user", "assistant"]);
    assert.equal(app.sessionMeta(id)?.fromPi?.session, "5e55e5e5-0000-4000-8000-000000000001");
    assert.equal(hash(), before, "the original is never changed");

    // The list now says a session here continues it.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const again = (await app.piSessions.list(owner(app))).sessions.filter((each) => each.pocket?.id === Number(id));

    assert.ok(again.some((each) => each.path === path));
    assert.ok(again.some((each) => each.path === converted && each.fromClaudeCode === true));
    await assert.rejects(app.piSessions.importClaude(owner(app), join(root, "long.jsonl")), /Claude Code's sessions in ~\/.claude\/projects/);
});

test("Pi's tools list Claude Code's sessions and continue one, saying what continued", async () => {
    const path = join(home, ".claude", "projects", "-srv-shop", "5e55e5e5-0000-4000-8000-000000000002.jsonl");

    copyFileSync(join(fixtures, "compacted.jsonl"), path);
    const id = await newSession(app);
    const toolOutput = () => JSON.stringify(requested.filter((message) => message.role === "toolResult"));

    await new Promise((resolve) => setTimeout(resolve, 5_100));
    await say(app, id, 'tool:pi_sessions {"query":"export"}');
    assert.match(toolOutput(), /Plan the export/);
    assert.match(toolOutput(), /Claude Code session/);

    await say(app, id, `tool:pi_session_import ${JSON.stringify({ path, folder: work })}`);
    const made = /Continued as session #(\d+)/.exec(toolOutput());

    assert.ok(made, toolOutput());
    assert.match(toolOutput(), /From Claude Code: the summary of its last compaction \(2026-10-02\) and the 6 messages after it continue; 2 earlier entries stay in its file/);
    assert.equal(app.cwdOf(Number(made![1]) as unknown as ConversationId), work);
});

/** A copy of a fixture as another Claude Code session (its own id) in ~/.claude/projects/-srv-shop. */
function claudeCopy(fixture: string, id: string): string {
    const path = join(home, ".claude", "projects", "-srv-shop", `${id}.jsonl`);

    writeFileSync(path, readFileSync(join(fixtures, fixture), "utf8").replaceAll("5e55e5e5-0000-4000-8000-000000000001", id));

    return path;
}

test("a converted session starts with this app's default model, not Claude Code's even when it is signed in; the card may pick another", async () => {
    const path = claudeCopy("tools.jsonl", "5e55e5e5-0000-4000-8000-000000000004");
    const signedIn = (provider: string, id: string) =>
        app.models.getAvailableSnapshot().some((each) => each.provider === provider && each.id === id);

    assert.ok(signedIn("anthropic", "claude-fable-5-1"), "Claude Code's model is signed in here");
    await app.setDefaultModel(owner(app), { provider: "faux", modelId: "faux-2", thinkingLevel: "off" });

    const { path: converted } = await app.piSessions.importClaude(owner(app), path);
    const preview = await app.piSessions.preview(owner(app), converted);

    assert.equal(preview.model, "faux/faux-2", "the card says the model it starts with: the default");
    assert.equal(preview.modelHere, true);
    assert.equal(preview.claudeCode?.model, "anthropic/claude-fable-5-1", "and names Claude Code's");

    const startsWith = async (model?: string) => {
        const { id } = await app.commands.continuePiSession(owner(app), converted, work, model);
        const agent = await app.agentState(id);

        return agent?.model === undefined ? undefined : `${agent.model.provider}/${agent.model.modelId}`;
    };

    assert.equal(await startsWith(), "faux/faux-2");
    assert.equal(await startsWith("faux/faux-vision"), "faux/faux-vision", "the card's pick");
    await assert.rejects(startsWith("anthropic/claude-gone"), /anthropic\/claude-gone is not a model signed in here/);
});

test("the conversion masks the owner's saved secrets' values wherever the history has them; a password not saved stays", async () => {
    const value = "acs-admin-Pa55word-2026";
    const id = "5e55e5e5-0000-4000-8000-000000000005";
    const at = (second: number) => `2026-10-03T10:00:0${second}.000Z`;
    const base = { isSidechain: false, sessionId: id, cwd: "/srv/shop", version: "2.1.277" };
    const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const entries = [
        { ...base, type: "user", parentUuid: null, uuid: "s1", timestamp: at(1), message: { role: "user", content: `Log in as admin with ${value} and check the ledger` } },
        {
            ...base,
            type: "assistant",
            parentUuid: "s1",
            uuid: "s2",
            timestamp: at(2),
            message: {
                id: "msg_S",
                role: "assistant",
                model: "claude-fable-5-1",
                content: [
                    { type: "thinking", thinking: `The password is ${value}.`, signature: "sig-S" },
                    { type: "thinking", thinking: "Then the ledger.", signature: "sig-T" },
                    { type: "tool_use", id: "toolu_S", name: "Bash", input: { command: `curl -u admin:${value} https://acs.local/ledger` } },
                ],
                stop_reason: "tool_use",
                usage,
            },
        },
        {
            ...base,
            type: "user",
            parentUuid: "s2",
            uuid: "s3",
            timestamp: at(3),
            message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_S", content: `logged in; demo user demo-pass-2026; admin ${value}` }] },
        },
        {
            ...base,
            type: "assistant",
            parentUuid: "s3",
            uuid: "s4",
            timestamp: at(4),
            message: { id: "msg_T", role: "assistant", model: "claude-fable-5-1", content: [{ type: "text", text: `Done: ${value} works.` }], stop_reason: "end_turn", usage },
        },
    ];
    const path = join(home, ".claude", "projects", "-srv-shop", `${id}.jsonl`);

    writeFileSync(path, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    app.secrets.set("ACS_ADMIN_PW", { value, description: "The ACS demo's admin password" });

    // Listed after the 5-second list of the tests before.
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const listed = (await app.piSessions.list(owner(app))).sessions.find((each) => each.path === path);

    assert.equal(listed?.title, "Log in as admin with [secret ACS_ADMIN_PW] and check the ledger");

    const { path: converted } = await app.piSessions.importClaude(owner(app), path);
    const text = readFileSync(converted, "utf8");
    const preview = await app.piSessions.preview(owner(app), converted);

    assert.ok(!text.includes(value), "no value in the Pi session");
    assert.equal(text.split("[secret ACS_ADMIN_PW]").length - 1, 6, "its title, the request, a thinking, the call, its result, the answer");
    assert.match(text, /demo-pass-2026/, "what is not a saved secret goes as it is: the card says so");
    assert.equal(preview.claudeCode?.masked, 5, "texts masked, the title aside");
    assert.equal(preview.title, "Log in as admin with [secret ACS_ADMIN_PW] and check the ledger");

    const answer = readPiSession(text).entries.map((entry) => entry.message).find((message) => message.role === "assistant");

    assert.deepEqual(answer?.role === "assistant" ? answer.content.slice(0, 2) : [], [
        { type: "thinking", thinking: "The password is [secret ACS_ADMIN_PW]." },
        { type: "thinking", thinking: "Then the ledger.", thinkingSignature: "sig-T" },
    ], "a masked thinking loses its signature, which signed what it was");
    assert.equal(readFileSync(path, "utf8").split(value).length - 1, 5, "the original keeps its text");
});

test("a session without a request is listed by its folder and start, saying so", async () => {
    const path = join(home, ".claude", "projects", "-data-projects-agent-crew", "5e55e5e5-0000-4000-8000-000000000003.jsonl");

    mkdirSync(join(home, ".claude", "projects", "-data-projects-agent-crew"), { recursive: true });
    copyFileSync(join(fixtures, "no-request.jsonl"), path);
    await new Promise((resolve) => setTimeout(resolve, 5_100));
    const listed = (await app.piSessions.list(owner(app))).sessions.find((each) => each.path === path);

    assert.equal(listed?.title, "agent-crew · 2026-09-30 01:29 UTC");
    assert.deepEqual(listed?.claudeCode, { size: readFileSync(path).length, noRequest: true });
});
