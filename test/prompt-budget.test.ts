// The prompt budget (PP-379, from pi-pocket 0.28.0's c3ad1d7a and d623bff5): pi-phone's own part of a new session's
// first request (its prompt sections and the tool schemas it offers, with the app's default of the rarer tools waiting
// for tool_search) stays under a limit, so a change that makes every request bigger fails here instead of costing every
// session quietly. Measured 2026-11-03: 95,269 characters, then 83,695 once the codemode section stopped listing every
// tool again. MCP servers (PP-526): none adds nothing; one of 111 tools serving the folder adds its one-line section,
// at most 300 characters, none of its tools, in On and Only modes alike.
import { cleanUp, newSession, openApp, owner, root, say, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { PSTACK_MODULE } from "../src/server/pstack.ts";

/** About 30,000 tokens (tool schemas and this prose run at about 2.75 characters a token). Raise it only on purpose. */
const LIMIT = 85_000;
/** What one MCP server serving the folder may add, whatever its tools. */
const MCP_LIMIT = 300;
/** Pi's own tools, and the owner's AGENTS.md and skills: not pi-phone's to count. */
const NOT_OURS = new Set(["read", "bash", "edit", "write", "project_context", "skills"]);
const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");

type Tool = { name: string; description: string; parameters: unknown };
type System = { sections?: Record<string, string>; toolsAdded?: Tool[] };

/** pi-phone's part of a new session's first request: each section's and tool's size, biggest first. */
async function firstRequest(data: string, setUp: (app: Awaited<ReturnType<typeof openApp>>) => Promise<void> = async () => {}): Promise<{ items: (readonly [string, number])[]; total: number; texts: Record<string, string> }> {
    let first: { messages: System[] } | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            first ??= request as never;

            return fauxAssistantMessage([fauxText("ok")]);
        }),
        data,
        undefined,
        {},
        { tools: "load" },
    );

    await setUp(app);
    await say(app, await newSession(app), "hello");
    await app.close();

    const texts: Record<string, string> = {};
    const items = first!.messages.flatMap((message) => [
        ...Object.entries(message.sections ?? {}).map(([name, text]) => {
            texts[`${name} (section)`] = String(text);

            return [`${name} (section)`, String(text).length] as const;
        }),
        ...(message.toolsAdded ?? []).map(({ name, description, parameters }) => [name, JSON.stringify({ name, description, parameters }).length] as const),
    ]);
    const ours = items.filter(([name]) => !NOT_OURS.has(name.replace(/ \(section\)$/, ""))).sort((a, b) => b[1] - a[1]);

    return { items: ours, total: ours.reduce((sum, [, size]) => sum + size, 0), texts };
}

/** A server of 111 tools (9 and 102 more, each about 600 characters of schema) serving the session's folder. */
async function bigServer(app: Awaited<ReturnType<typeof openApp>>): Promise<void> {
    app.mcpServers.save("big", { command: process.execPath, args: [STUB], env: { STUB_TOOLS: "102" }, description: "Godot 4 editor: scenes, nodes, scripts, run and screenshot", folders: [work] });
    assert.equal((await app.mcp.tools("big", work)).length, 111);
    await app.mcp.stop("big");
}

test("a new session's sections and tool schemas fit the prompt budget", async (t) => {
    // Measured with the app's default extensions, pstack commands among them (on by default, PP-551).
    const { items, total } = await firstRequest(join(root, "budget-none"), async (app) => {
        assert.equal(app.loader.enabled(PSTACK_MODULE), true, "pstack commands are on by default");
    });
    const names = items.map(([name]) => name);

    // A change in the request's shape must fail here, not pass with nothing counted.
    for (const name of ["preamble (section)", "guidelines (section)", "codemode (section)", "artifact", "tool_search"]) {
        assert.ok(names.includes(name), `the first request has ${name}`);
    }

    const biggest = items.slice(0, 5).map(([name, size]) => `${name} ${size}`);

    t.diagnostic(`pi-phone's part of a new session's first request: ${total} characters`);
    assert.ok(!names.includes("mcp_servers (section)"), "no MCP server, no section");
    assert.ok(
        total <= LIMIT,
        `pi-phone's part of a new session's prompt is ${total} characters, over the budget of ${LIMIT}. Biggest: ${biggest.join(", ")}. Make it smaller, or let a rarer tool wait for tool_search (deferred-tools.ts); raise the limit only on purpose.`,
    );
});

test("an MCP server of 111 tools serving the folder adds its section's line and none of its tools, in On and Only modes", async (t) => {
    const none = await firstRequest(join(root, "budget-mcp-none"));
    const one = await firstRequest(join(root, "budget-mcp-one"), bigServer);

    t.diagnostic(`with one 111-tool server: ${one.total} characters, ${one.total - none.total} more than with none; its section: ${JSON.stringify(one.texts["mcp_servers (section)"])}`);
    assert.ok(!one.items.some(([name]) => name.startsWith("mcp__")), "no MCP tool is offered up front");
    assert.equal(one.items.find(([name]) => name === "tool_search")?.[1], none.items.find(([name]) => name === "tool_search")?.[1], "the same tool_search declaration");
    assert.match(one.texts["mcp_servers (section)"]!, /^<mcp_servers>\nMCP servers for this folder\. Find their tools with tool_search .*\n- big: Godot 4 editor: scenes, nodes, scripts, run and screenshot \(111 tools, where this session works\)\n<\/mcp_servers>$/);
    assert.ok(one.total - none.total <= MCP_LIMIT, `one MCP server adds ${one.total - none.total} characters, over ${MCP_LIMIT}`);

    // codemode Only: the server's tools stay deferred, not listed for scripts; the section says how scripts find them.
    const only = async (app: Awaited<ReturnType<typeof openApp>>) => {
        await app.setCodemodeMode(owner(app), "only");
    };
    const onlyNone = await firstRequest(join(root, "budget-only-none"), only);
    const onlyOne = await firstRequest(join(root, "budget-only-one"), async (app) => {
        await only(app);
        await bigServer(app);
    });
    const codemode = onlyOne.texts["codemode (section)"]!;

    t.diagnostic(`codemode Only: ${onlyNone.total} → ${onlyOne.total} characters with the server`);
    assert.ok(!/mcp__big__/.test(codemode), "the Only listing names no MCP tool");
    assert.equal(codemode.length, onlyNone.texts["codemode (section)"]!.length);
    assert.match(onlyOne.texts["mcp_servers (section)"]!, /Find their tools in a codemode script with searchTools\(query\)/);
    assert.ok(onlyOne.total - onlyNone.total <= MCP_LIMIT, `one MCP server adds ${onlyOne.total - onlyNone.total} characters in Only mode, over ${MCP_LIMIT}`);
});

after(cleanUp);
