// A subagent that finishes its work compacts right away, while its prompt cache is warm (PP-513,
// src/server/cold-subagent.ts, the reporter's "finish" and "summarize" phases): once its report is on its way, a large
// one writes its own summary in a request with its last request's prefix (system, tools and messages: it reads the
// cache), and is compacted with it; Spend records the saving. A small one, or one whose runs make one request, stays as
// it is. Work sent meanwhile waits and goes once, after the compaction; a restart in the middle compacts once.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStream } from "@earendil-works/pi-ai/api/anthropic-messages";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { SelfCompactDoc, SubagentsDoc } from "../src/server/docs.ts";
import { SUMMARY_PREFIX, writePrice } from "../src/server/self-compact.ts";

/** About 22,000 tokens, as the faux provider counts (4 characters a token): a "work" or "one" run's answer. */
const LONG = "word ".repeat(17_600);
/** The tool calls a "work" run makes before its answer: 10 requests a run. */
const WORK_CALLS = 9;
/**
 * faux-w's prices: a cache read as dear as the input, so compacting after the work pays from a context the tests fill
 * quickly (about 55k, with a 10-request run); a write a quarter dearer, as Anthropic's 5-minute one.
 */
const PRICES = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1.25 };
/** The summary a subagent writes when asked. */
const SUMMARY = "## Task\nWork, three times.\n## Report\nDid the work.\n## Open points\nNone.";

/** What each subagent's requests carried, newest last (the last three), by its name. */
const seen = new Map<string, { request: { messages: unknown[]; tools?: unknown }; options: SimpleStreamOptions | undefined }[]>();
/** Called when a summary request comes, before it is answered: a test holds it there, or looks at the app. */
let onSummary: ((name: string) => Promise<void>) | undefined;
let summaries = 0;

/**
 * A subagent answers "work" with 9 tool calls, then about 22k tokens; "one" with 22k at once; a summary request with
 * `SUMMARY`; anything else briefly. The parent calls the subagent tool as it is told.
 */
function model() {
    const faux = fauxProvider({
        tokensPerSecond: 1_000_000,
        // faux-1: what a new session starts on (it prices nothing); the parents move to faux-w.
        models: [
            { id: "faux-1", contextWindow: 1_000_000 },
            { id: "faux-w", contextWindow: 1_000_000, cost: PRICES },
        ],
    });

    faux.setResponses(
        Array.from({ length: 1000 }, () => async (request: { messages: { role: string; content: unknown }[]; tools?: unknown }, options: SimpleStreamOptions | undefined) => {
            const all = JSON.stringify(request.messages);
            const { role, text: said } = lastText(request as never);
            const text = said.replace(/^\[from: [^\]]+\] /, "");
            const name = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

            if (name !== undefined) {
                seen.set(name, [...(seen.get(name) ?? []), { request: JSON.parse(JSON.stringify(request)) as never, options }].slice(-3));

                if (role === "user" && text.startsWith(SUMMARY_PREFIX)) {
                    summaries++;
                    await onSummary?.(name);

                    return fauxAssistantMessage([fauxText(SUMMARY)]);
                }

                // What this run was asked: the turn's user message, before its tool rounds.
                const turn = request.messages.filter((message) => message.role !== "system");
                const start = turn.findLastIndex((message) => message.role === "user");
                const asked = lastText({ messages: turn.slice(0, start + 1) }).text.replace(/^\[from: [^\]]+\] /, "");
                const calls = turn.slice(start + 1).filter((message) => message.role === "toolResult").length;

                if (asked === "work" && calls < WORK_CALLS) {
                    return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" });
                }

                return fauxAssistantMessage([fauxText(asked === "work" || asked === "one" ? LONG : `did ${asked}`)]);
            }

            const asked = /^(spawn|send|status) (\S+)(?: (.+))?$/.exec(text);

            if (asked !== null && role === "user") {
                const [, action, agent, message] = asked;

                return fauxAssistantMessage([fauxToolCall("subagent", { action: action!, name: agent!, ...(message === undefined ? {} : { message }) })], { stopReason: "toolUse" });
            }

            return fauxAssistantMessage([fauxText("noted")]);
        }) as never,
    );

    return faux;
}

let app: App;

/** The app on `data`, with compacting after the work off: each test turns it on for the work it looks at. */
async function opened(data: string): Promise<App> {
    const made = await openApp(model() as never, data);

    made.config.setSelfCompact("finishedSubagent", false);

    return made;
}

before(async () => {
    app = await opened(join(root, "finish-data"));
});

after(async () => {
    await app.close();
    cleanUp();
});

const entries = async (id: ConversationId, on = app): Promise<readonly EntryRecord[]> =>
    (await (await on.harness.conversation(id, context))!.entries({ order: "ascending" }, 1000, undefined, context)).items;
const textOf = (entry: EntryRecord): string => {
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;

    return typeof content === "string" ? content : Array.isArray(content) ? (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("") : "";
};
const agentOf = async (id: ConversationId, name: string, on = app) => (await on.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!;
/** The parent's tool results, newest last. */
const results = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.tool-result").map(textOf);
/** The reports of `name` the parent has. */
const reportTexts = async (id: ConversationId, name: string, on = app) =>
    (await entries(id, on)).filter((entry) => entry.kind === "pi.user" && textOf(entry).includes(`[subagent ${name} answered`)).map(textOf);
const reports = async (id: ConversationId, name: string, on = app) => (await reportTexts(id, name, on)).length;
const compactions = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.compaction");
const summaryRequests = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.user" && textOf(entry).startsWith(SUMMARY_PREFIX));
const usageOf = (entry: EntryRecord) => {
    const usage = (entry.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number } }).usage;

    return { prompt: usage.input + usage.cacheRead + usage.cacheWrite, read: usage.cacheRead };
};
/** Settled: neither the parent nor the subagent works, and the subagent compacts no more. */
const settled = async (id: ConversationId, name: string, on = app) => {
    const agent = (await on.harness.snapshot(SubagentsDoc, id, context))?.agents[name];

    return !on.isBusy(id) && (agent === undefined || (!on.isBusy(agent.conversationId) && agent.finishing === undefined));
};

/** Tell the parent something, and wait until `name` reported `reported` times and all is settled. */
async function tell(id: ConversationId, text: string, name: string, reported: number, on = app): Promise<void> {
    await on.commands.submit(id, owner(on), { text, requestId: crypto.randomUUID() });
    await until(async () => (await reports(id, name, on)) >= reported && (await settled(id, name, on)), `${name}'s report ${reported}`, 90_000);
}

/** A parent on faux-w with a subagent `name` given `runs` (each "work", "one" or another word), compacting after work off. */
async function ran(name: string, runs: readonly string[], on = app): Promise<{ id: ConversationId; sub: ConversationId }> {
    const id = await newSession(on);

    await on.commands.configure(id, owner(on), { model: { provider: "faux", modelId: "faux-w" }, thinkingLevel: "off" });

    for (const [index, run] of runs.entries()) {
        await tell(id, `${index === 0 ? "spawn" : "send"} ${name} ${run}`, name, index + 1, on);
    }

    return { id, sub: (await agentOf(id, name, on)).conversationId };
}

/** An Anthropic request's payload for a request as Pi Durable sent it, caught before anything goes out. */
async function payloadOf(request: unknown): Promise<{ system?: unknown; tools?: unknown; messages: unknown[] }> {
    const model = {
        ...{ id: "claude-opus-5-5", name: "Claude Opus 5.5", api: "anthropic-messages", provider: "anthropic", baseUrl: "http://127.0.0.1:9" },
        ...{ reasoning: false, input: ["text"], cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, contextWindow: 1_000_000, maxTokens: 8_000 },
    } as Model<"anthropic-messages">;
    const abort = new AbortController();
    let payload: unknown;
    const stream = anthropicStream(model, request as never, {
        apiKey: "test-key",
        signal: abort.signal,
        onPayload: (body) => {
            payload = body;
            abort.abort();

            return body;
        },
        fetch: () => Promise.reject(new Error("no network in tests")),
    });

    await stream.result();

    return payload as { system?: unknown; tools?: unknown; messages: unknown[] };
}

/** A payload's part without its cache breakpoints, which move to the newest message of each request. */
const unmarked = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, each: unknown) => (key === "cache_control" ? undefined : each)));

test("a large subagent compacts once its report is on its way, with a summary request on its last request's prefix; Spend records it", async (t) => {
    const { id, sub } = await ran("big", ["work", "work"]);
    /** The reports of big's on their way (with the parent, or waiting for the courier) when its summary request came. */
    const onTheirWay: number[] = [];

    onSummary = async () => {
        const state = (await app.harness.snapshot(SubagentsDoc, id, context))!;
        const waiting = [...(state.outbox ?? []), ...(state.sending?.reports ?? [])].filter((report) => report.name === "big").length;

        onTheirWay.push((await reports(id, "big")) + waiting);
    };
    app.config.setSelfCompact("finishedSubagent", true);

    try {
        await tell(id, "send big work", "big", 3);
        await until(async () => (await compactions(sub)).length === 1 && (await settled(id, "big")), "big's compaction", 90_000);
    } finally {
        onSummary = undefined;
        app.config.setSelfCompact("finishedSubagent", false);
    }

    const all = await entries(sub);
    const work = all.findLastIndex((entry) => entry.kind === "pi.user" && textOf(entry) === "work");
    const request = all.findIndex((entry) => entry.kind === "pi.user" && textOf(entry).startsWith(SUMMARY_PREFIX));
    const answer = all.findLastIndex((entry, index) => index < request && entry.kind === "pi.assistant");
    const summary = all.findIndex((entry, index) => index > request && entry.kind === "pi.assistant");
    const compaction = all.findIndex((entry) => entry.kind === "pi.compaction");

    // After its report: the work, its answer, then the summary request, the summary, and the compaction.
    assert.equal((await compactions(sub)).length, 1, "compacted once");
    assert.equal((await summaryRequests(sub)).length, 1, "one summary request");
    assert.ok(work < answer && answer < request && request < summary && summary < compaction, `order: ${work}, ${answer}, ${request}, ${summary}, ${compaction}`);
    assert.match(textOf(all[request]!), /Your work is done, and your report went to the agent you work for/);
    assert.equal(textOf(all[summary]!), SUMMARY);
    // The report is the work's answer, unchanged, and it was on its way before the summary was asked for.
    const report = (await reportTexts(id, "big")).at(-1)!;

    assert.equal(await reports(id, "big"), 3);
    assert.ok(report.endsWith(textOf(all[answer]!)) && !report.includes("## Task"), "the report is the work's answer");
    assert.deepEqual(onTheirWay, [3], "the report was on its way when the summary was asked for");

    // The summary request has the prefix of the request before it: the same messages, then the answer and the request.
    const [previous, asked] = seen.get("big")!.slice(-2);

    assert.ok(lastText(asked!.request as never).text.startsWith(SUMMARY_PREFIX), "the summary request is the one after the work's last");
    assert.equal(asked!.options?.sessionId, previous!.options?.sessionId, "the same provider session");
    assert.ok(asked!.options?.cacheRetention !== "none", "it may read the cache");
    assert.deepEqual(asked!.request.messages.slice(0, previous!.request.messages.length), previous!.request.messages, "its messages start with the previous request's");
    assert.deepEqual(asked!.request.tools, previous!.request.tools, "the same tools");
    // As Anthropic gets them: the same system and tools, and the previous request's messages first, byte for byte.
    const before = await payloadOf(previous!.request);
    const then = await payloadOf(asked!.request);

    assert.ok(before.messages.length > 10, `${before.messages.length} messages`);
    assert.deepEqual(then.system, before.system, "the same system prompt");
    assert.deepEqual(then.tools, before.tools, "the same tools");
    assert.deepEqual(unmarked(then.messages.slice(0, before.messages.length)), unmarked(before.messages), "the previous request's messages first");
    // The provider read the whole previous request from the cache, and wrote only what came after it: the work's answer
    // (new to any prompt) and the summary request.
    const used = usageOf(all[summary]!);
    const last = usageOf(all[answer]!);
    const answered = (all[answer]!.model![0] as { usage: { output: number } }).usage.output;

    assert.ok(used.read >= last.prompt, `read ${used.read}, the previous prompt ${last.prompt}`);
    assert.ok(used.prompt - used.read < answered + 2_000, `wrote ${used.prompt - used.read}, the answer ${answered}`);

    // Recorded as the subagent's compaction, with what it saved over a run of 10 requests, in its transcript and in Spend.
    const done = (await app.harness.snapshot(SelfCompactDoc, sub, context))!.done;

    assert.equal(done.length, 1);
    assert.equal(done[0]!.reason, "finish");
    assert.equal(done[0]!.entry, Number(all[compaction]!.id));
    assert.equal(done[0]!.read, used.read);
    assert.equal(done[0]!.before, used.prompt);
    assert.ok(done[0]!.after < 0.7 * done[0]!.before, `${done[0]!.before} → ${done[0]!.after}`);
    const write = writePrice(PRICES, 300_000);
    const saving = (10 * done[0]!.before * PRICES.cacheRead - (done[0]!.after * write + 9 * done[0]!.after * PRICES.cacheRead)) / 1_000_000 - done[0]!.cost;

    assert.ok(Math.abs(done[0]!.saving - saving) < 1e-9, `saving ${done[0]!.saving}, not ${saving}`);
    assert.ok(done[0]!.saving > 0);
    t.diagnostic(
        `payload: ${before.messages.length} → ${then.messages.length} messages, system and tools equal; summary request read ${used.read} of ${used.prompt} (previous prompt ${last.prompt}); ${done[0]!.before} → ${done[0]!.after} tokens, saving $${done[0]!.saving.toFixed(4)} at faux-w's prices`,
    );
    assert.ok(app.spend.summary(owner(app)).selfCompactions!.recent.some((each) => each.reason === "finish" && each.entry === done[0]!.entry && each.saving === done[0]!.saving));

    // The next work starts on the small context.
    await tell(id, "send big next", "big", 4);
    const next = (await entries(sub)).findLast((entry) => entry.kind === "pi.assistant")!;

    assert.equal(textOf(next), "did next");
    assert.ok(usageOf(next).prompt < 0.7 * done[0]!.before, `next ${usageOf(next).prompt}, before ${done[0]!.before}`);
});

test("a small subagent, or one whose runs make one request, stays as it is", async () => {
    const tiny = await ran("tiny", ["hello"]);
    const few = await ran("few", ["one", "one"]);

    app.config.setSelfCompact("finishedSubagent", true);

    try {
        summaries = 0;
        await tell(tiny.id, "send tiny again", "tiny", 2);
        await tell(few.id, "send few one", "few", 3);
        // The reporters' look after the work is quick; give it a moment to do anything at all.
        await new Promise((resolve) => setTimeout(resolve, 1_500));

        const tokens = async (sub: ConversationId) => {
            const answer = (await entries(sub)).findLast((entry) => entry.kind === "pi.assistant")!;
            const usage = (answer.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number; output: number } }).usage;

            return usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
        };

        // Under the 50k floor; and past it, but a run of one request never pays: the summary turn reads it all once already.
        assert.ok((await tokens(tiny.sub)) < 50_000, `tiny ${await tokens(tiny.sub)}`);
        assert.ok((await tokens(few.sub)) > 60_000, `few ${await tokens(few.sub)}`);

        for (const { id, sub } of [tiny, few]) {
            assert.equal((await compactions(sub)).length, 0);
            assert.equal((await summaryRequests(sub)).length, 0);
            assert.equal((await app.harness.snapshot(SelfCompactDoc, sub, context))?.asked, undefined);
            assert.equal((await results(id)).at(-1), `Sent to ${id === tiny.id ? "tiny" : "few"}.`);
        }

        assert.equal(summaries, 0);
        assert.equal(await app.coldSubagents.finished(few.sub), undefined);
    } finally {
        app.config.setSelfCompact("finishedSubagent", false);
    }
});

test("work sent while a subagent compacts after its work waits, then goes once, after the compaction", async () => {
    const { id, sub } = await ran("mid", ["work", "work"]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    let asked = false;

    onSummary = async () => {
        asked = true;
        await held;
    };
    app.config.setSelfCompact("finishedSubagent", true);

    try {
        await app.commands.submit(id, owner(app), { text: "send mid work", requestId: crypto.randomUUID() });
        await until(async () => asked && (await reports(id, "mid")) === 3 && !app.isBusy(id), "mid's summary request, and its report", 90_000);

        // The summary turn is held: the subagent compacts, and work sent now waits.
        await app.commands.submit(id, owner(app), { text: "send mid next", requestId: crypto.randomUUID() });
        await until(async () => (await results(id)).at(-1)?.startsWith("Sent to mid.") === true && !app.isBusy(id), "the send", 30_000);
        assert.equal((await results(id)).at(-1), "Sent to mid. It gets the message once it has compacted its context after its last work.");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal((await entries(sub)).filter((entry) => entry.kind === "pi.user" && textOf(entry) === "next").length, 0, "not delivered during the compaction");
        assert.notEqual((await agentOf(id, "mid")).finishing, undefined);

        release();
        await until(async () => (await reports(id, "mid")) === 4 && (await settled(id, "mid")), "mid's report on the work sent meanwhile", 90_000);
    } finally {
        release();
        onSummary = undefined;
        app.config.setSelfCompact("finishedSubagent", false);
    }

    const all = await entries(sub);
    const compaction = all.findIndex((entry) => entry.kind === "pi.compaction");
    const next = all.flatMap((entry, index) => (entry.kind === "pi.user" && textOf(entry) === "next" ? [index] : []));

    assert.equal((await compactions(sub)).length, 1);
    assert.equal(next.length, 1, "delivered once");
    assert.ok(compaction >= 0 && compaction < next[0]!, `after the compaction: ${compaction}, ${next[0]}`);
    assert.equal(textOf(all.findLast((entry) => entry.kind === "pi.assistant")!), "did next");
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(await reports(id, "mid"), 4, "reported once");
});

test("a restart in the middle of the summary turn compacts once, and work sent meanwhile goes once", async () => {
    const data = join(root, "finish-restart");
    let first: App | undefined = await opened(data);

    try {
        const { id, sub } = await ran("again", ["work", "work"], first);
        let asked = false;

        onSummary = async () => {
            asked = true;
            await new Promise((resolve) => setTimeout(resolve, 8_000));
        };
        first.config.setSelfCompact("finishedSubagent", true);
        await first.commands.submit(id, owner(first), { text: "send again work", requestId: "finish-restart-work" });
        await until(async () => asked && (await reports(id, "again", first)) === 3 && !first!.isBusy(id), "the summary request, and the report", 90_000);
        await first.commands.submit(id, owner(first), { text: "send again next", requestId: "finish-restart-next" });
        await until(async () => (await results(id, first)).at(-1)?.startsWith("Sent to again.") === true, "the send", 30_000);
        // Stopped while the summary turn is under way, and the work sent meanwhile waits.
        await first.close();
        first = undefined;
        onSummary = undefined;
        // One app per data folder in the process: the shared one steps aside meanwhile.
        await app.close();
        app = await openApp(model() as never, data);
        await until(async () => (await reports(id, "again")) === 4 && (await compactions(sub)).length > 0 && (await settled(id, "again")), "the report after the restart", 120_000);

        const all = await entries(sub);
        const compaction = all.findIndex((entry) => entry.kind === "pi.compaction");
        const next = all.flatMap((entry, index) => (entry.kind === "pi.user" && textOf(entry) === "next" ? [index] : []));

        assert.equal((await compactions(sub)).length, 1, "compacted once");
        assert.equal((await summaryRequests(sub)).length, 1, "asked for the summary once");
        assert.equal((await app.harness.snapshot(SelfCompactDoc, sub, context))!.done.length, 1, "recorded once");
        assert.equal(next.length, 1, "delivered once");
        assert.ok(compaction < next[0]!, "after the compaction");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await reports(id, "again"), 4, "reported once");
    } finally {
        onSummary = undefined;
        await first?.close();
        await app.close().catch(() => {});
        app = await opened(join(root, "finish-data"));
    }
});
