// /better (PP-506, pi-better): a read-only helper, a fork of the session, answers on the session's model with the
// session's own opening (so the provider's cache serves it), refuses tools other than read, grep, find, ls and bash,
// works while Pi does, one at a time, stops on Stop, and leaves the session's context as it was. Its rewrite comes from
// the reply's last <improved-prompt> block; a reply without one says so. A subagent's brief marked /better is checked
// first, and the subagent gets the checked brief.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, say, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, type ConversationId, ProviderDoc } from "@earendil-works/pi-durable";
import { BetterDoc, BetterError, type BetterResult, buildHelperTask, closedCutoff, helperToolBlock, parseMarkedPrompt } from "../src/server/better.ts";
import { HttpError } from "../src/server/errors.ts";

type Request = { messages: { role: string; content: unknown; toolCallId?: string }[] };

/** Every request the session's helpers sent, and every other request, in order. */
const helperRequests: Request["messages"][] = [];
const sessionRequests: Request["messages"][] = [];
const block = (prompt: string) => `(1) A pro would measure.\n(2) The logs.\n(3) A profiler.\n(4) A benchmark.\n\n<improved-prompt>\n${prompt}\n</improved-prompt>`;

/** What the helper was asked to deepen: the text after "## Prompt to deepen". */
const asked = (request: Request) => /## (?:Prompt to deepen|Brief to check)\\n\\n(.*?)\\n\\n## Return/.exec(JSON.stringify(request.messages))?.[1] ?? "";

const route: FauxResponseStep = (request) => {
    const all = JSON.stringify((request as unknown as Request).messages);
    const { role, text } = lastText(request as never);

    if (all.includes("## Prompt to deepen") || all.includes("## Brief to check")) {
        helperRequests.push((request as unknown as Request).messages);
        const prompt = asked(request as unknown as Request);

        if (prompt === "write it" && role !== "toolResult") {
            return fauxAssistantMessage([fauxToolCall("write", { path: join(work, "better-wrote.txt"), content: "no" })], { stopReason: "toolUse" });
        }

        if (prompt.startsWith("slow") && role !== "toolResult") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 30" })], { stopReason: "toolUse" });
        }

        if (prompt === "read first" && role !== "toolResult") {
            return fauxAssistantMessage([fauxToolCall("bash", { command: "echo read-marker" })], { stopReason: "toolUse" });
        }

        if (prompt === "no block") {
            return fauxAssistantMessage([fauxText("(1) Something.\nI forgot the block.")]);
        }

        if (prompt === "empty block") {
            return fauxAssistantMessage([fauxText("(1) Something.\n<improved-prompt>\n\n</improved-prompt>")]);
        }

        if (all.includes("## Brief to check")) {
            return fauxAssistantMessage([fauxText(block(`Checked: ${prompt.replace("option B", "the parser in src/a.ts")}`))]);
        }

        return fauxAssistantMessage([fauxText(block(role === "toolResult" ? `Better ${prompt}; the tool said: ${text}` : `Better ${prompt}`))]);
    }

    // A subagent says what it was given.
    if (/You are the subagent/.test(all)) {
        return fauxAssistantMessage([fauxText(`got: ${text}`)]);
    }

    sessionRequests.push((request as unknown as Request).messages);

    if (role === "user" && text === "work a while") {
        return fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 4" })], { stopReason: "toolUse" });
    }

    if (role === "user" && text === "delegate") {
        return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "briefed", message: "/better Fix option B in the file." })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? "worked" : `echo: ${text}`)]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route, { contextWindow: 1_000_000 }), join(root, "better-data"));
});

after(async () => {
    await app?.close();
    cleanUp();
});

const doc = async (id: ConversationId) => (await app.harness.snapshot(BetterDoc, id, context)) ?? {};

/** Start /better in `id` and wait for its result. */
async function better(id: ConversationId, prompt: string): Promise<BetterResult> {
    const before = (await doc(id)).last?.id;

    await app.better.start(id, owner(app), prompt);
    await until(async () => (await doc(id)).last !== undefined && (await doc(id)).last?.id !== before, "the helper's result", 20_000);

    return (await doc(id)).last!;
}

/** The session's context as the model gets it, as text. */
const contextText = async (id: ConversationId) => JSON.stringify((await (await app.harness.conversation(id, context))!.context(context)).messages);

test("the <improved-prompt> block: the last one whose tag opens a line; none, or an empty one, says so", () => {
    assert.equal(parseMarkedPrompt(block("Do the deep thing.")), "Do the deep thing.");
    assert.equal(parseMarkedPrompt("Say <improved-prompt> inline.\n<improved-prompt>\nfirst\n</improved-prompt>\n<improved-prompt>\nsecond\n</improved-prompt>"), "second");

    for (const [reply, code, message] of [
        ["No block here.", "no-block", "The reply has no <improved-prompt> … </improved-prompt> block."],
        ["Inline <improved-prompt>only</improved-prompt>", "no-block", "The reply has no <improved-prompt> … </improved-prompt> block."],
        ["<improved-prompt>\n   \n</improved-prompt>", "empty-block", "The reply's <improved-prompt> block is empty."],
    ] as const) {
        assert.throws(() => parseMarkedPrompt(reply), (error) => error instanceof BetterError && error.code === code && error.message === message, reply);
    }

    assert.match(buildHelperTask("make it faster", "HELPER"), /^HELPER\n\n## Prompt to deepen\n\nmake it faster\n\n## Return\n[\s\S]*\n<improved-prompt>\nthe rewritten prompt\n<\/improved-prompt>$/);
    assert.match(buildHelperTask("", "HELPER"), /None given: deepen the task in progress/);
    assert.equal(helperToolBlock("bash", ["read", "bash"]), undefined);
    assert.equal(helperToolBlock("edit", ["read", "edit", "bash"]), "/better's helper only reads and rewrites, so edit is off. Use read, bash.");
});

test("the helper's copy ends before an answer whose tool calls have no results yet", () => {
    const entry = (id: number) => ({ id, conversationId: 1, kind: "x" }) as never;
    const call = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: {} }] } as never;
    const result = { role: "toolResult", toolCallId: "c1", content: [], isError: false } as never;
    const user = { role: "user", content: "hi" } as never;

    assert.equal(closedCutoff({ entries: [entry(1), entry(2)], contributions: [[user], [call]] }), 1);
    assert.equal(closedCutoff({ entries: [entry(1), entry(2), entry(3)], contributions: [[user], [call], [result]] }), 3);
    assert.equal(closedCutoff({ entries: [], contributions: [] }), undefined);
});

test("/better starts a helper on the session's model with the session's own opening, and the rewrite is its result", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    const opening = sessionRequests.at(-1)!;
    const before = await contextText(id);
    const helpersBefore = helperRequests.length;
    const last = await better(id, "make it faster");

    assert.equal(last.ok, true);
    assert.equal(last.ok && last.improved, "Better make it faster");
    assert.equal(last.by, owner(app).id);
    assert.equal((await doc(id)).run, undefined, "no run left");

    // The helper: the session's model and thinking level, its provider identity, its folder.
    const helper = last.helper as unknown as ConversationId;
    const ran = await app.harness.snapshot(AgentDoc, helper, context);
    const own = await app.harness.snapshot(AgentDoc, id, context);

    assert.deepEqual(ran?.model, { provider: "faux", modelId: "faux-1" });
    assert.equal(ran?.thinkingLevel, own?.thinkingLevel);
    assert.equal(ran?.cwd, own?.cwd);
    assert.equal((await app.harness.snapshot(ProviderDoc, helper, context))?.sessionId, (await app.harness.snapshot(ProviderDoc, id, context))?.sessionId);

    // Its request starts with the session's: the same system prompt and tools, the same messages, then the answer the
    // session had and the helper's task. Nothing in between: no section or tool differs.
    const sent = helperRequests[helpersBefore]!;

    assert.deepEqual(JSON.parse(JSON.stringify(sent.slice(0, opening.length))), JSON.parse(JSON.stringify(opening)));
    assert.equal(sent.length, opening.length + 2, JSON.stringify(sent.slice(opening.length).map((message) => [message.role, JSON.stringify(message).slice(0, 300)])));
    assert.match(JSON.stringify(sent.at(-1)), /First, without asking me anything, find and read the code/);

    // The session's context is as it was: no entry of the helper's.
    assert.equal(await contextText(id), before);
    assert.equal(app.better.sessionOf(helper), id);
    assert.equal(app.rootOf(helper), id, "the helper is the session's, for spend and secrets");
});

test("the helper's tools: write is refused, saying which it may use; bash runs", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    const refused = await better(id, "write it");

    assert.equal(refused.ok, true);
    assert.match(refused.ok ? refused.improved : "", /the tool said: [\s\S]*Tool call blocked: \/better's helper only reads and rewrites, so write is off\. Use read, bash\./);
    assert.equal(existsSync(join(work, "better-wrote.txt")), false, "nothing written");

    const read = await better(id, "read first");

    assert.match(read.ok ? read.improved : "", /the tool said: read-marker/);
});

test("a reply without the block, or with an empty one, is a result that says so, with the helper to read", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");

    for (const [prompt, error] of [["no block", "no-block"], ["empty block", "empty-block"]] as const) {
        const last = await better(id, prompt);

        assert.equal(last.ok, false);
        assert.equal(!last.ok && last.error, error);
        assert.notEqual(last.helper, undefined, "its reply can be read in the helper");
    }
});

test("one at a time: a second /better is refused while one runs; Stop stops it, and its helper's run", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    await app.better.start(id, owner(app), "slow one");
    await until(async () => (await doc(id)).run?.helper !== undefined && app.isBusy((await doc(id)).run!.helper as unknown as ConversationId), "the helper at work");
    const helper = (await doc(id)).run!.helper as unknown as ConversationId;

    await assert.rejects(
        app.better.start(id, owner(app), "another"),
        (error) => error instanceof HttpError && error.status === 409 && /already running/.test(error.message),
    );

    await app.better.stop(id, owner(app));
    await until(async () => (await doc(id)).last?.ok === false, "the stopped result");
    const last = (await doc(id)).last!;

    assert.equal(!last.ok && last.error, "cancelled");
    assert.equal(last.helper, Number(helper));
    assert.equal((await doc(id)).run, undefined);
    await until(async () => !app.isBusy(helper), "the helper stopped");
    await assert.rejects(app.better.stop(id, owner(app)), (error) => error instanceof HttpError && error.status === 409);

    // With nothing to deepen yet, it asks for a prompt.
    const fresh = await newSession(app);

    await assert.rejects(app.better.start(fresh, owner(app), ""), (error) => error instanceof HttpError && error.status === 400 && /no task to deepen yet/.test(error.message));
});

test("it works while Pi works: the copy ends before the call under way, and the session's run goes on", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    await app.commands.submit(id, owner(app), { text: "work a while", requestId: `busy-${id}` });
    await until(() => app.isBusy(id), "Pi at work");
    await until(async () => (await contextText(id)).includes("sleep 4"), "the call under way");
    const helpersBefore = helperRequests.length;
    const last = await better(id, "");

    assert.equal(last.ok, true);
    assert.equal(app.isBusy(id), true, "Pi still works");
    const sent = JSON.stringify(helperRequests[helpersBefore]);

    assert.doesNotMatch(sent, /sleep 4/, "no call without its result");
    assert.match(sent, /None given: deepen the task in progress/);
    await until(() => !app.isBusy(id), "Pi done", 20_000);
    assert.doesNotMatch(await contextText(id), /Prompt to deepen/);
    assert.match(await contextText(id), /worked/);
});

test("a subagent's message marked /better is checked first: the subagent gets the checked brief", async () => {
    const id = await newSession(app);

    await say(app, id, "hello");
    await app.commands.submit(id, owner(app), { text: "delegate", requestId: `delegate-${id}` });
    await until(async () => (await contextText(id)).includes("got: Checked: Fix the parser in src/a.ts in the file."), "the subagent's report", 20_000);
    assert.match(JSON.stringify(helperRequests.at(-1)), /The brief below is for a subagent that starts with none of this conversation/);
});
