// The prompt budget (PP-379, from pi-pocket 0.28.0's c3ad1d7a and d623bff5): pi-phone's own part of a new session's
// first request (its prompt sections and the tool schemas it offers, with the app's default of the rarer tools waiting
// for tool_search) stays under a limit, so a change that makes every request bigger fails here instead of costing every
// session quietly. Measured 2026-11-03: 95,269 characters, then 83,695 once the codemode section stopped listing every
// tool again.
import { cleanUp, newSession, openApp, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";

/** About 30,000 tokens (tool schemas and this prose run at about 2.75 characters a token). Raise it only on purpose. */
const LIMIT = 85_000;
/** Pi's own tools, and the owner's AGENTS.md and skills: not pi-phone's to count. */
const NOT_OURS = new Set(["read", "bash", "edit", "write", "project_context", "skills"]);

type Tool = { name: string; description: string; parameters: unknown };
type System = { sections?: Record<string, string>; toolsAdded?: Tool[] };

test("a new session's sections and tool schemas fit the prompt budget", async () => {
    let first: { messages: System[] } | undefined;
    const app = await openApp(
        scriptedModel((request) => {
            first ??= request as never;

            return fauxAssistantMessage([fauxText("ok")]);
        }),
        undefined,
        undefined,
        {},
        { tools: "load" },
    );

    await say(app, await newSession(app), "hello");
    await app.close();
    cleanUp();
    const items = first!.messages.flatMap((message) => [
        ...Object.entries(message.sections ?? {}).map(([name, text]) => [`${name} (section)`, String(text).length] as const),
        ...(message.toolsAdded ?? []).map(({ name, description, parameters }) => [name, JSON.stringify({ name, description, parameters }).length] as const),
    ]);
    const ours = items.filter(([name]) => !NOT_OURS.has(name.replace(/ \(section\)$/, ""))).sort((a, b) => b[1] - a[1]);
    const total = ours.reduce((sum, [, size]) => sum + size, 0);
    const names = ours.map(([name]) => name);

    // A change in the request's shape must fail here, not pass with nothing counted.
    for (const name of ["preamble (section)", "guidelines (section)", "codemode (section)", "artifact", "tool_search"]) {
        assert.ok(names.includes(name), `the first request has ${name}`);
    }

    const biggest = ours.slice(0, 5).map(([name, size]) => `${name} ${size}`);

    assert.ok(
        total <= LIMIT,
        `pi-phone's part of a new session's prompt is ${total} characters, over the budget of ${LIMIT}. Biggest: ${biggest.join(", ")}. Make it smaller, or let a rarer tool wait for tool_search (deferred-tools.ts); raise the limit only on purpose.`,
    );
});
