// No tool Pi is offered is named mcp_ and one underscore (PP-533): Anthropic bills a subscription request that offers
// such a tool as extra usage, and with none left every request of the session failed with 400 "You're out of extra
// usage" (the MCP admin tools were mcp_servers and mcp_server_set). Every tool the app registers keeps to it: the
// built-in modules' (each turned on), the deferred ones, the MCP extension's and an MCP server's mcp__<server>__<tool>.
// A drop-in with such a tool is refused whole, saying why.
import { type App, cleanUp, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { DEFERRED_TOOLS } from "../src/server/deferred-tools.ts";
import { HttpError } from "../src/server/errors.ts";
import { BUILT_IN_TOOLS } from "../src/server/reload.ts";

/** The rule, written here on its own: the test holds the app to it, not to the app's copy. */
const BILLED = /^mcp_(?!_)/;
const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");
const dataDir = join(root, "tool-names-data");
const dropIns = join(dataDir, "extensions");

let app: App;

before(async () => {
    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "mcp-notes.ts"),
        `/** A drop-in whose tool is named mcp_ and one underscore. */
import { obj } from "@earendil-works/pi-schema";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

export const pocketApi = 2;

export default () =>
    defineExtension({
        name: "mcp-notes",
        tools: [defineTool({ name: "mcp_notes", description: "Notes.", parameters: obj({}), execute: async () => ({ output: [] }) })],
    });
`,
    );
    app = await openApp(scriptedModel(() => fauxAssistantMessage([fauxText("ok")])), dataDir, undefined, {}, { tools: "load" });
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("no tool the app registers is named mcp_ and one underscore: built-in, deferred, MCP", async () => {
    for (const each of app.loader.list().filter((one) => one.source === "built-in" && !one.enabled)) {
        await app.setExtensionEnabled(owner(app), each.file, true);
    }

    app.mcpServers.save("stub", { command: process.execPath, args: [STUB], folders: [work] });
    await app.mcp.tools("stub", work);
    await until(async () => app.loader.builtInToolNames().has("mcp__stub__echo"), "the stub server's tools installed");

    const registered = app.loader.builtInToolNames();
    const names = [...new Set([...registered, ...BUILT_IN_TOOLS, ...DEFERRED_TOOLS])];

    assert.ok(names.length > 100, names.join(", "));
    assert.deepEqual(
        names.filter((name) => BILLED.test(name)),
        [],
        "Anthropic bills a request offering such a tool as extra usage",
    );
    assert.ok(registered.has("list_mcp_servers") && registered.has("set_mcp_server"), "the MCP admin tools are counted");
});

test("a drop-in with a tool named mcp_ and one underscore is refused whole, saying Anthropic bills it as extra usage", async () => {
    await assert.rejects(
        app.setExtensionEnabled(owner(app), "mcp-notes.ts", true),
        (error) =>
            error instanceof HttpError &&
            error.status === 409 &&
            error.message.includes("refused: its tools mcp_notes are named mcp_ and one underscore: Anthropic bills a request offering such a tool as extra usage"),
    );

    const module = app.loader.list().find((each) => each.file === "mcp-notes.ts");

    assert.deepEqual(module?.refused, { kind: "extra-usage", names: ["mcp_notes"] });
    assert.deepEqual(module?.extensions, [], "nothing of it is installed");
    assert.ok(!app.loader.extensionNames().includes("mcp-notes"));
});
