// Codemode's Only mode (PP-379, from pi-pocket 0.28.0): the other tools leave the request, the codemode section lists
// them for scripts, and scripts still call them; On mode keeps every tool and a one-line section.
import { cleanUp, context, lastText, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PlanDoc } from "../src/server/docs.ts";
import { DECLARED, ON_GUIDE } from "../src/server/extensions/codemode.ts";

type System = { role: string; sections?: Record<string, string>; toolsAdded?: { name: string }[] };

let app: Awaited<ReturnType<typeof openApp>>;
/** The newest request: its declared tools, its sections by name, and the last tool result. */
let declared: string[] = [];
let sections: Record<string, string> = {};
let result = "";
/** The declared tools of the subagent's first request. */
let child: string[] | undefined;

const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, args as never)], { stopReason: "toolUse" });

const model = scriptedModel(
    (request) => {
        const { role, text } = lastText(request as never);
        const system = (request.messages as System[]).filter((message) => message.role === "system");

        declared = system.flatMap((message) => (message.toolsAdded ?? []).map((tool) => tool.name));
        sections = Object.assign({}, ...system.map((message) => message.sections));
        result = role === "toolResult" ? text : result;
        child ??= text.includes("Brief") ? declared : undefined;

        if (role === "user" && text.includes("run a script")) {
            return call("codemode", { code: 'return await tools.late_tool({ text: "hi" })' });
        }

        if (role === "user" && text.includes("spawn a helper")) {
            return call("subagent", { action: "spawn", name: "kid", message: "Brief", tools: ["read"] });
        }

        return fauxAssistantMessage([fauxText("done")]);
    },
    { contextWindow: 1_000_000 },
);

const mode = (value: string) => app.setCodemodeMode(owner(app), value);

before(async () => {
    mkdirSync(join(root, "data", "extensions"), { recursive: true });
    // The app's default: the rarer tools wait for tool_search.
    app = await openApp(model, undefined, undefined, {}, { tools: "load" });
    // A drop-in the owner turns on later, too long for the listing's budget: it follows the mode too.
    writeFileSync(
        join(root, "data", "extensions", "late.ts"),
        `/** Late: for tests. */
export default () => ({ name: "late", tools: [{
    name: "late_tool",
    description: "Late echo. " + "Long. ".repeat(2000),
    parameters: { type: "object", properties: { text: { type: "string" } } },
    annotations: { readOnlyHint: true },
    execute: async (args) => ({ output: [{ type: "text", text: "late:" + args.text }] }),
}] });
`,
    );
});

after(async () => {
    await app?.close();
    cleanUp();
});

test("On mode declares every tool, and the codemode section is one line", async () => {
    await mode("on");
    await say(app, await newSession(app), "hello");

    assert.ok(["codemode", "read", "bash", "tool_search"].every((name) => declared.includes(name)), declared.join(", "));
    assert.equal(sections.codemode, `<codemode>\n${ON_GUIDE}\n</codemode>`);
    assert.match(sections.tool_search ?? "", /load it with tool_search/);
});

test("Only mode declares codemode and the tools with cards, and lists the others for scripts", async () => {
    await mode("only");
    await app.setExtensionEnabled(owner(app), "late.ts", true);
    await say(app, await newSession(app), "hello");

    assert.deepEqual(declared.sort(), [...DECLARED].sort());
    assert.match(sections.codemode!, /^<codemode>\nYour other tools are not declared/);
    assert.match(sections.codemode!, /\n## bash\n.*\nParameters \(JSON Schema\): \{/);
    // Past the budget, a drop-in turned on later is listed by name.
    assert.match(sections.codemode!, /\nAlso callable, not listed \(describeTool for their parameters\): [^\n]*\blate_tool\b/);
    // A rarer tool is found with searchTools(), not listed; tool_search's note is gone with it.
    assert.doesNotMatch(sections.codemode!, /## session_archive\n/);
    assert.equal(sections.tool_search, undefined);
});

test("in Only mode a script calls a hidden tool, read-only ones in plan mode too", async () => {
    await mode("only");
    const id = await newSession(app);

    await app.harness.commit(async (tx) => void ((await tx.doc(PlanDoc, id)).on = true), context);
    await say(app, id, "run a script");
    assert.match(result, /late:hi/);
});

test("in Only mode, a subagent given a tool that only scripts call also gets codemode", async () => {
    await mode("only");
    await say(app, await newSession(app), "spawn a helper");
    await until(() => child !== undefined, "the subagent's first request");

    assert.deepEqual(child, ["codemode"]);
});
