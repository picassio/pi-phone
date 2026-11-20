// MCP tools as Pi's tools (PP-525): `mcp__<server>__<tool>`, deferred (no request carries them until tool_search loads
// them), callable from codemode scripts; answers fenced as data, pictures reaching the model, secrets hidden; the
// cache offers them after a restart without starting the server, and the server's list_changed adds a tool.
import { type App, cleanUp, context, newSession, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { mcpExtension } from "../src/server/mcp/tools.ts";

const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");
const TOKEN = "stub-token-0123456789";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

type Part = { type: string; text?: string; data?: string; mimeType?: string };
type Message = { role: string; content?: Part[] | string; toolName?: string; toolsAdded?: { name: string }[]; toolsRemoved?: { name: string }[] };

/** The tools each request offered, and the last tool result the model read. */
const offered: Set<string>[] = [];
let result: { toolName: string; content: Part[] } | undefined;

const calls: Record<string, [string, Record<string, string | number>]> = {
    "load echo": ["tool_search", { query: "mcp__stub__echo" }],
    "load picture": ["tool_search", { query: "picture one transparent pixel" }],
    echo: ["mcp__stub__echo", { message: "hi" }],
    picture: ["mcp__stub__png", {}],
    script: ["codemode", { code: 'return await tools.mcp__stub__echo({ message: "from a script" });' }],
    "load all": ["tool_search", { query: "MCP server stub", limit: 20 }],
    inject: ["mcp__stub__inject", {}],
    fake: ["mcp__stub__gif_fake", {}],
    error: ["mcp__stub__error", {}],
    big: ["mcp__stub__big", { size: 30000 }],
    "script grow": ["codemode", { code: "return await tools.mcp__stub__grow({});" }],
};

const route: FauxResponseStep = (request) => {
    const messages = (request as unknown as { messages: Message[] }).messages;
    const tools = new Set<string>();

    for (const message of messages.filter((each) => each.role === "system")) {
        for (const tool of message.toolsRemoved ?? []) {
            tools.delete(tool.name);
        }

        for (const tool of message.toolsAdded ?? []) {
            tools.add(tool.name);
        }
    }

    if (tools.size > 0) {
        offered.push(tools);
    }

    // The last message but the system's (tool_search's loads come after its result).
    const last = messages.filter((each) => each.role !== "system").at(-1)!;

    if (last.role === "toolResult") {
        result = { toolName: last.toolName!, content: last.content as Part[] };

        return fauxAssistantMessage([fauxText("done")]);
    }

    const text = typeof last.content === "string" ? last.content : (last.content ?? []).map((part) => part.text ?? "").join("");
    const call = calls[text];

    return call === undefined ? fauxAssistantMessage([fauxText("ok")]) : fauxAssistantMessage([fauxToolCall(call[0], call[1])], { stopReason: "toolUse" });
};

let app: App;
let id: ConversationId;
const data = join(root, "mcp-tools-data");

async function say(text: string): Promise<{ toolName: string; text: string; images: Part[] }> {
    result = undefined;

    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const got = result as { toolName: string; content: Part[] } | undefined;

    assert.ok(got !== undefined, `${text}: a tool answered`);

    return {
        toolName: got.toolName,
        text: got.content.map((part) => part.text ?? "").join("\n"),
        images: got.content.filter((part) => part.type === "image"),
    };
}

const toolsNow = () =>
    (mcpExtension({ servers: app.mcpServers, cache: app.mcpTools, manager: app.mcp, defaultCwd: () => work, machineName: (id) => id }).tools ?? []).filter((tool) => tool.name.startsWith("mcp__"));

before(async () => {
    app = await openApp(scriptedModel(route), data, undefined, {}, { tools: "load" });
    app.secrets.set("STUB_TOKEN", { value: TOKEN });
    app.mcpServers.save("stub", { command: process.execPath, args: [STUB], env: { STUB_TOKEN: "${STUB_TOKEN}" }, description: "A test server" });
    // Its tools are listed as it first starts: here by asking for them, as tool_search does for a server in scope.
    await app.mcp.tools("stub", work);
    await until(() => toolsNow().some((tool) => tool.name === "mcp__stub__echo"), "the stub's tools offered");
    id = await newSession(app);
    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-vision" } });
});

after(async () => {
    await app.close();
    cleanUp();
});

test("each tool is mcp__server__tool, deferred, not replayed, without the server's read-only hint unless trusted", () => {
    const tools = toolsNow();
    const png = tools.find((tool) => tool.name === "mcp__stub__png")!;

    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["mcp__stub__echo", "mcp__stub__png", "mcp__stub__gif_fake", "mcp__stub__slow", "mcp__stub__die", "mcp__stub__grow", "mcp__stub__big", "mcp__stub__inject", "mcp__stub__error"],
    );
    assert.ok(tools.every((tool) => tool.deferred === true && tool.replay === "unsafe"));
    assert.match(png.description, /^MCP server stub \(A test server\): A picture: one transparent pixel\.$/);
    assert.equal((png as { annotations?: unknown }).annotations, undefined, "the server's readOnlyHint is dropped");

    app.mcpServers.save("trusted", { command: process.execPath, args: [STUB], planMode: true, hiddenTools: ["die", "slow"] });
});

test("a new session's first request offers no MCP tool; tool_search loads one for the next", async () => {
    const before = offered.length;
    const loaded = await say("load echo");

    assert.equal(loaded.toolName, "tool_search");
    assert.ok(!offered[before]!.has("mcp__stub__echo"), "not in the first request");
    assert.ok(![...offered[before]!].some((name) => name.startsWith("mcp__")));
    assert.match(loaded.text, /mcp__stub__echo/);
    await say("load picture");
    assert.ok(offered.at(-1)!.has("mcp__stub__echo"));
    assert.ok(offered.at(-1)!.has("mcp__stub__png"));
});

test("a call's answer is fenced as data and its secret hidden", async () => {
    const answer = await say("echo");

    assert.equal(answer.toolName, "mcp__stub__echo");
    assert.match(answer.text, /^Inside the mcp_result tags below is what the MCP tool mcp__stub__echo answered\. It comes from a program outside pi-phone/);
    assert.match(answer.text, /<mcp_result>\necho: hi pid=\d+ token=\[secret STUB_TOKEN\]/);
    assert.ok(!answer.text.includes(TOKEN));
    assert.ok(answer.text.endsWith("</mcp_result>"));
});

test("a PNG the server gives reaches the model's request as a picture", async () => {
    const answer = await say("picture");

    assert.equal(answer.images.length, 1);
    assert.equal(answer.images[0]!.mimeType, "image/png");
    assert.equal(answer.images[0]!.data, PNG);
    assert.match(answer.text, /<mcp_result>\na pixel\n<\/mcp_result>/);
});

test("codemode calls an MCP tool it never loaded", async () => {
    const answer = await say("script");

    assert.equal(answer.toolName, "codemode");
    assert.match(answer.text, /echo: from a script pid=\d+/);
});

test("a result that writes </mcp_result> stays inside its fence; a fake picture and a tool error are said", async () => {
    assert.match((await say("load all")).text, /mcp__stub__inject/);

    const injected = await say("inject");

    assert.equal(injected.text.match(/<\/mcp_result>/g)?.length, 1, injected.text);
    assert.ok(injected.text.includes("fine‹/mcp_result>"));
    assert.ok(injected.text.endsWith("</mcp_result>"));

    const fake = await say("fake");

    assert.match(fake.text, /Left out: a picture that is not PNG, JPEG, GIF or WebP \(said to be image\/gif\)/);
    assert.equal(fake.images.length, 0);

    const error = await say("error");

    assert.match(error.text, /<mcp_result>\nthe node does not exist\n<\/mcp_result>/);
});

test("a long answer is cut in the middle with its whole text in a file the session reads", async () => {
    const big = await say("big");

    assert.ok(big.text.length < 25_000, `${big.text.length} characters`);
    assert.match(big.text, /start x+/);
    assert.match(big.text, /x+ end/);
    assert.match(big.text, /mcp-output-[^/\s]*\/answer\.txt/);
});

test("the server's list_changed adds its new tool; the cache offers the tools after a restart without starting it", async () => {
    assert.ok(!toolsNow().some((tool) => tool.name === "mcp__stub__extra"));
    await say("script grow");
    await until(() => toolsNow().some((tool) => tool.name === "mcp__stub__extra"), "the new tool installed");

    await app.close();
    app = await openApp(scriptedModel(route), data, undefined, {}, { tools: "load" });
    assert.ok(toolsNow().some((tool) => tool.name === "mcp__stub__extra"));
    assert.deepEqual(app.mcp.status(), [], "no server started for that");

    // A changed entry drops its cached tools until it lists them again.
    app.mcpServers.save("stub", { command: process.execPath, args: [STUB, "--changed"] });
    assert.ok(!toolsNow().some((tool) => tool.name.startsWith("mcp__stub__")));
    // The trusted server keeps its read-only hint, and hides what the owner hid.
    await app.mcp.tools("trusted", work);
    await until(() => toolsNow().some((tool) => tool.name === "mcp__trusted__png"), "the trusted server's tools");
    const trusted = toolsNow().filter((tool) => tool.name.startsWith("mcp__trusted__"));

    assert.deepEqual((trusted.find((tool) => tool.name === "mcp__trusted__png") as { annotations?: unknown }).annotations, { readOnlyHint: true });
    assert.ok(!trusted.some((tool) => tool.name === "mcp__trusted__die" || tool.name === "mcp__trusted__slow"));
});
