// MCP tools by folder (PP-526): tool_search finds only the tools of the servers serving the session's folder (and
// lists a server's tools first when it never did), a direct call of another folder's tool says it does not serve
// this one, the section names the servers in scope, and a call to an MCP tool not loaded says how to load it.
import { type App, cleanUp, context, newSession, openApp, owner, root, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";

const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");
const other = join(root, "other-project");

type Message = { role: string; content?: { type: string; text?: string }[] | string; sections?: Record<string, string | null> };

const calls: Record<string, [string, Record<string, string | number>]> = {
    search: ["tool_search", { query: "echo a message back", limit: 20 }],
    "search late": ["tool_search", { query: "MCP server late", limit: 20 }],
    "call there": ["codemode", { code: 'return await tools.mcp__there__echo({ message: "x" });' }],
    "call unloaded": ["mcp__here__echo", { message: "x" }],
};
let said = "";
let sections = "";

const route: FauxResponseStep = (request) => {
    const messages = (request as unknown as { messages: Message[] }).messages;

    sections = messages
        .filter((each) => each.role === "system")
        .map((each) => Object.entries(each.sections ?? {}).map(([key, text]) => `<${key}>${text ?? ""}`).join("\n"))
        .join("\n");

    const last = messages.filter((each) => each.role !== "system").at(-1)!;
    const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((part) => part.text ?? "").join("\n");

    if (last.role === "toolResult") {
        said = text;

        return fauxAssistantMessage([fauxText("done")]);
    }

    const call = calls[text];

    return call === undefined ? fauxAssistantMessage([fauxText("ok")]) : fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: "toolUse" });
};

let app: App;

async function turn(id: ConversationId, text: string): Promise<string> {
    said = "";

    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return said;
}

before(async () => {
    mkdirSync(other, { recursive: true });
    app = await openApp(scriptedModel(route), join(root, "mcp-scope-data"), undefined, {}, { tools: "load" });
    app.mcpServers.save("here", { command: process.execPath, args: [STUB], folders: [work], description: "Here's server" });
    app.mcpServers.save("there", { command: process.execPath, args: [STUB], folders: [other] });
    await app.mcp.tools("here", work);
    await app.mcp.tools("there", other);
});

after(async () => {
    await app.close();
    cleanUp();
});

test("tool_search finds the tools of the servers serving the folder, not another folder's", async () => {
    const id = await newSession(app);
    const found = await turn(id, "search");

    assert.match(found, /mcp__here__echo/);
    assert.doesNotMatch(found, /mcp__there__/);
    assert.match(sections, /<mcp_servers>\nMCP servers for this folder\. Find their tools with tool_search[^\n]*\n- here: Here's server \(9 tools, where this session works\)\n<\/mcp_servers>/);
    assert.doesNotMatch(sections, /- there/);

    const elsewhere = await newSession(app, other);
    const there = await turn(elsewhere, "search");

    assert.match(there, /mcp__there__echo/);
    assert.doesNotMatch(there, /mcp__here__/);
});

test("a direct call of another folder's MCP tool says the server does not serve this folder", async () => {
    const id = await newSession(app);
    const answer = await turn(id, "call there");

    assert.match(answer, /The MCP server there does not serve this session's folder/);
});

test("a call to an MCP tool not loaded yet says to load it with tool_search", async () => {
    const id = await newSession(app);
    const answer = await turn(id, "call unloaded");

    assert.match(answer, /Tool mcp__here__echo is not available\. mcp__here__echo is one of the rarer tools, offered once loaded: call tool_search with its name/);
});

test("a server in scope that never listed its tools starts for tool_search, which finds them at once", async () => {
    app.mcpServers.save("late", { command: process.execPath, args: [STUB], folders: [work] });
    assert.equal(app.mcpTools.tools("late"), undefined);

    const id = await newSession(app);

    await turn(id, "hello");
    assert.match(sections, /<mcp_servers>\nMCP servers for this folder[^\n]*\n- here[^\n]*\n- late \(tools listed on first use, where this session works\)\n<\/mcp_servers>/);

    const found = await turn(id, "search late");

    assert.match(found, /mcp__late__echo/);
    assert.equal(app.mcpTools.tools("late")?.length, 9);
});

test("a folder no server serves has no section and no MCP tool to find", async () => {
    const lone = join(root, "lone");

    mkdirSync(lone, { recursive: true });

    const id = await newSession(app, lone);
    const found = await turn(id, "search");

    assert.doesNotMatch(sections, /mcp_servers/);
    assert.doesNotMatch(found, /mcp__/);
});
