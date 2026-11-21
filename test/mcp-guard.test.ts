// Who may use the owner's MCP servers, and the cards that ask first (PP-527): set_mcp_server changes a server only
// after the owner approves a card with the whole entry and its diff (a Deny changes nothing); an entry changed
// outside the app does not run until a card approves it again; a secret set to ask is asked for the session that calls;
// askEachCall asks before each call; plan mode blocks a server's tools unless its entry trusts their read-only hints;
// a guest's message is refused and finds nothing, and a guest cannot approve.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DEFERRED_TOOLS } from "../src/server/deferred-tools.ts";
import type { ApprovalRequest } from "../src/server/host.ts";
import { type McpServerForm, unpinnedPackage } from "../src/server/mcp/admin.ts";
import { parseServer } from "../src/server/mcp/config.ts";

const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");
const entry = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [STUB], folders: [work], ...extra });

const calls: Record<string, [string, Record<string, unknown>]> = {
    add: ["set_mcp_server", { action: "save", name: "stub", entry: entry() }],
    "add trusted": ["set_mcp_server", { action: "save", name: "trusted", entry: entry({ planMode: true }) }],
    change: ["set_mcp_server", { action: "save", name: "stub", entry: entry({ env: { GODOT_PATH: "/opt/godot" } }) }],
    "turn on": ["set_mcp_server", { action: "enable", name: "stub" }],
    "turn off": ["set_mcp_server", { action: "disable", name: "stub" }],
    remove: ["set_mcp_server", { action: "remove", name: "trusted" }],
    list: ["list_mcp_servers", {}],
    echo: ["codemode", { code: 'return await tools.mcp__stub__echo({ message: "hi" });' }],
    "trusted png": ["codemode", { code: "return await tools.mcp__trusted__png({});" }],
    "trusted echo": ["codemode", { code: 'return await tools.mcp__trusted__echo({ message: "hi" });' }],
    search: ["tool_search", { query: "echo a message back", limit: 20 }],
};

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const call = role === "user" ? calls[text.replace(/^\[from: [^\]]+\] /, "")] : undefined;

    return call === undefined ? fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]) : fauxAssistantMessage([fauxToolCall(call[0], call[1] as never)], { stopReason: "toolUse" });
};

let app: App;
let id: ConversationId;

before(async () => {
    app = await openApp(scriptedModel(route), join(root, "mcp-guard-data"), undefined, {}, { tools: "all" });
    id = await newSession(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

type Card = ApprovalRequest & { form?: McpServerForm };

/** One turn as `user`; each card it raises is read and answered in order with `answers`. */
async function turn(text: string, answers: boolean[] = [], user = owner(app)): Promise<{ said: string; cards: Card[] }> {
    const { submissionId } = await app.commands.submit(id, user, { text, requestId: crypto.randomUUID() });
    const cards: Card[] = [];

    for (const answer of answers) {
        await until(() => app.approvals.forConversation(id).length > 0, `card ${cards.length + 1} of ${text}`);
        const card = app.approvals.forConversation(id)[0] as Card;

        cards.push(card);
        await app.answerApproval(card.id, answer, owner(app));
        await until(() => !app.approvals.forConversation(id).some((each) => each.id === card.id), "the card answered");
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const view = await (await app.harness.conversation(id, context))!.context(context);
    const said = view.messages.filter((message) => message.role === "toolResult").at(-1);

    return { said: JSON.stringify(said?.content ?? ""), cards };
}

test("list_mcp_servers and set_mcp_server wait for tool_search", () => {
    assert.ok(DEFERRED_TOOLS.includes("list_mcp_servers"));
    assert.ok(DEFERRED_TOOLS.includes("set_mcp_server"));
});

test("set_mcp_server: a card with the whole entry; a Deny changes nothing, an Approve saves it approved", async () => {
    const denied = await turn("add", [false]);
    const card = denied.cards[0]!;

    assert.equal(card.tool, "set_mcp_server");
    assert.equal(card.form?.type, "mcp-server");
    assert.equal(card.form?.action, "save");
    assert.equal(card.form?.diff, undefined, "a new server has no diff");
    assert.deepEqual(JSON.parse(card.form!.entry), { stub: { command: process.execPath, args: [STUB], folders: [work] } });
    assert.equal(card.form?.runs, "where the session works");
    assert.match(denied.said, /did not approve: the MCP server stub is as it was/);
    assert.deepEqual(app.mcpServers.list(), []);

    const added = await turn("add", [true]);

    assert.match(added.said, /Added the MCP server stub \(stdio, runs where the session works/);
    assert.ok(app.mcpServers.runnable("stub"));

    const listed = await turn("list");

    assert.match(listed.said, /- stub: on/);
    assert.match(listed.said, /tools not listed yet/);
});

test("a guest cannot approve a server's card, and a guest's message is refused and finds no MCP tool", async () => {
    const guest = app.config.addUser("Gina", "guest");

    await app.mcp.tools("stub", work);
    const { submissionId } = await app.commands.submit(id, owner(app), { text: "change", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(id).length > 0, "the card");
    const card = app.approvals.forConversation(id)[0]!;

    await assert.rejects(app.answerApproval(card.id, true, guest.user), /The MCP servers are the owner's/);
    await app.answerApproval(card.id, false, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);

    assert.match((await turn("list", [], guest.user)).said, /Not for a guest's or a teammate's message/);
    assert.match((await turn("echo", [], guest.user)).said, /Not for a guest's or a teammate's message/);
    assert.match((await turn("add", [], guest.user)).said, /Not for a guest's or a teammate's message/);
    assert.doesNotMatch((await turn("search", [], guest.user)).said, /mcp__stub__/);
});

test("a change shows its diff and stops the running server; an entry changed outside the app runs again only once a card approves it", async () => {
    await app.mcp.tools("stub", work);
    assert.match((await turn("echo")).said, /echo: hi pid=\d+/);

    const pid = app.mcp.status()[0]!.pid!;
    const changed = await turn("change", [true]);

    assert.match(changed.cards[0]!.form!.diff!, /\+\s+"env": \{/);
    assert.match(changed.cards[0]!.form!.diff!, /\+\s+"GODOT_PATH": "\/opt\/godot"/);
    await until(() => !app.mcp.status().some((each) => each.pid === pid && each.state === "ready"), "the old instance stopped");
    // A changed entry's tools are listed again (tool_search does it for a session).
    await app.mcp.tools("stub", work);
    assert.match((await turn("echo")).said, /godot=\/opt\/godot/);

    // Someone edits the file: the entry reads, but does not run.
    const file = JSON.parse(readFileSync(app.mcpServers.file, "utf8")) as { mcpServers: Record<string, { args: string[] }> };

    file.mcpServers.stub!.args = [STUB, "--edited"];
    writeFileSync(app.mcpServers.file, JSON.stringify(file));
    await app.close();
    app = await openApp(scriptedModel(route), join(root, "mcp-guard-data"), undefined, {}, { tools: "all" });
    assert.equal(app.mcpServers.get("stub")?.approved, false);
    await assert.rejects(app.mcp.tools("stub", work), /changed since the owner approved it/);
    assert.match((await turn("list")).said, /changed since the owner approved it \(does not run\)/);

    const enabled = await turn("turn on", [true]);

    assert.match(enabled.cards[0]!.form!.entry, /--edited/);
    assert.ok(app.mcpServers.runnable("stub"));
    await app.mcp.tools("stub", work);
    assert.match((await turn("echo")).said, /echo: hi/);

    await turn("turn off", [true]);
    assert.ok(!app.mcpServers.runnable("stub"));
    await turn("turn on", [true]);
});

test("a secret set to ask is asked for the session that calls, once while the server runs; askEachCall asks before each call", async () => {
    app.secrets.set("STUB_TOKEN", { value: "stub-token-0123456789", ask: true });
    app.mcpServers.save("stub", entry({ env: { STUB_TOKEN: "${STUB_TOKEN}" } }));

    // tool_search starts it to list its tools: the card comes then.
    const refused = await turn("search", [false]);

    assert.equal(refused.cards[0]!.reason, "Starts the MCP server stub with $STUB_TOKEN");
    assert.match(refused.said, /could not list its tools: The MCP server stub was not used: its use of \$STUB_TOKEN was not allowed/);

    const allowed = await turn("search", [true]);

    assert.match(allowed.said, /mcp__stub__echo/);
    assert.match((await turn("echo")).said, /token=\[secret STUB_TOKEN\]/, "asked once for this session, not again while it runs");

    app.secrets.set("STUB_TOKEN", { ask: false });
    app.mcpServers.save("stub", entry({ askEachCall: true }));
    await app.mcp.tools("stub", work);

    const each = await turn("echo", [false]);

    assert.equal(each.cards[0]!.tool, "mcp__stub__echo");
    assert.equal(each.cards[0]!.subject, '{\n  "message": "hi"\n}');
    assert.match(each.said, /This call of mcp__stub__echo was not allowed/);
    assert.match((await turn("echo", [true])).said, /echo: hi/);
    app.mcpServers.save("stub", entry());
});

test("plan mode blocks a server's tools, but those the server marks read-only when its entry trusts them", async () => {
    await turn("add trusted", [true]);
    await app.mcp.tools("stub", work);
    await app.mcp.tools("trusted", work);
    await until(() => app.mcpTools.tools("trusted") !== undefined, "the trusted server's tools");
    await app.commands.setPlan(id, owner(app), true);

    assert.match((await turn("echo")).said, /Plan mode is on: The mcp__stub__echo tool can change things, so it is blocked/);
    assert.match((await turn("trusted echo")).said, /Plan mode is on: The mcp__trusted__echo tool can change things/);
    assert.match((await turn("trusted png")).said, /a pixel/);
    await app.commands.setPlan(id, owner(app), false);

    const removed = await turn("remove", [true]);

    assert.equal(removed.cards[0]!.form?.action, "remove");
    assert.equal(app.mcpServers.get("trusted"), undefined);
});

test("a package run without a pinned version is named on the card", () => {
    assert.equal(unpinnedPackage(parseServer("a", { command: "npx", args: ["-y", "gopeak"] })), "gopeak");
    assert.equal(unpinnedPackage(parseServer("a", { command: "npx", args: ["-y", "gopeak@latest"] })), "gopeak@latest");
    assert.equal(unpinnedPackage(parseServer("a", { command: "npx", args: ["-y", "gopeak@2.3.8"] })), undefined);
    assert.equal(unpinnedPackage(parseServer("a", { command: "npx", args: ["-y", "@scope/server"] })), "@scope/server");
    assert.equal(unpinnedPackage(parseServer("a", { command: "npx", args: ["-y", "@scope/server@1.0.0"] })), undefined);
    assert.equal(unpinnedPackage(parseServer("a", { command: "xvfb-run", args: ["-a", "-s", "-screen 0 1280x800x24", "npx", "-y", "gopeak"] })), "gopeak");
    assert.equal(unpinnedPackage(parseServer("a", { command: "uvx", args: ["mcp-server-git==0.6.2"] })), undefined);
    assert.equal(unpinnedPackage(parseServer("a", { command: "node", args: ["server.js"] })), undefined);
});
