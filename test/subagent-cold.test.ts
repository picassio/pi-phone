// A subagent whose prompt cache went cold, compacted before new work (PP-511, src/server/cold-subagent.ts): a send to
// a cold, large subagent compacts it first, waits for it, and says so, and the work's first request is small; a warm
// one, a small one, or one with the setting off is left as it is; a restart in the middle compacts once and delivers
// once; status shows each subagent's context, share of the window, last answer, and cache. The rule counts the work's
// later requests too, as many as the subagent's own runs made: many tip a context the first request alone would leave
// as it is, and few do not.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type ConversationId, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { coldCosts, paysToCompact, requestsOf, requestsPerRun, warmCosts, warmSaving } from "../src/server/cold-subagent.ts";
import { SelfCompactDoc, SubagentsDoc } from "../src/server/docs.ts";
import { SUMMARY_PREFIX, savingOf, writePrice } from "../src/server/self-compact.ts";

/** About 10,000 tokens an answer, as the faux provider counts (4 characters a token). */
const LONG = "word ".repeat(8_000);
/** About 22,000 tokens: a run's last answer in the tests of the requests a run makes. */
const LONGER = "word ".repeat(17_600);
/** The tool calls a "loop" run makes before its answer: 30 requests a run. */
const LOOP_CALLS = 29;
/** Summaries the next compaction waits for, so a test can stop the app in the middle of one. */
let slowSummary = 0;
let summaries = 0;

/**
 * faux-1: a cache write dear against the input and the output (6.25 to 1 and 5), so compacting pays from a context the
 * tests fill quickly. faux-2: Opus 5.5's prices with twice its output price ($4 input, $40 output, $0.20 read, $5
 * write), so at about 120k the first request alone leaves the context as it is by a clear margin, and the requests
 * after it decide. Both with a wide window, so Pi Durable's own compaction stays away. A subagent answers "fill" at
 * length; "loop" with 29 tool calls, then about 20k tokens; "two" with one call, then 20k; "one" with 20k at once; and
 * anything else briefly. The parent calls the subagent tool as it is told.
 */
function model() {
    const faux = fauxProvider({
        tokensPerSecond: 1_000_000,
        models: [
            { id: "faux-1", contextWindow: 1_000_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 6.25 } },
            { id: "faux-2", contextWindow: 1_000_000, cost: { input: 4, output: 40, cacheRead: 0.2, cacheWrite: 5 } },
        ],
    });

    faux.setResponses(
        Array.from({ length: 1000 }, () => async (request: { messages: { role: string; content: unknown }[] }) => {
            const system = request.messages.find((message) => message.role === "system");

            if (typeof system?.content === "string" && system.content.includes("context summarization assistant")) {
                summaries++;

                if (slowSummary > 0) {
                    await new Promise((resolve) => setTimeout(resolve, slowSummary));
                }

                return fauxAssistantMessage([fauxText("## Goal\nFill the context.\n## Progress\nFilled it.")]);
            }

            const all = JSON.stringify(request.messages);
            const { role, text: said } = lastText(request as never);
            const text = said.replace(/^\[from: [^\]]+\] /, "");

            if (/You are the subagent \\"/.test(all)) {
                // What this run was asked: the turn's user message, before its tool rounds.
                const turn = request.messages.filter((message) => message.role !== "system");
                const start = turn.findLastIndex((message) => message.role === "user");
                const asked = lastText({ messages: turn.slice(0, start + 1) }).text.replace(/^\[from: [^\]]+\] /, "");
                const calls = turn.slice(start + 1).filter((message) => message.role === "toolResult").length;
                const callsWanted = asked === "loop" ? LOOP_CALLS : asked === "two" ? 1 : 0;

                if (calls < callsWanted) {
                    return fauxAssistantMessage([fauxToolCall("bash", { command: "true" })], { stopReason: "toolUse" });
                }

                return fauxAssistantMessage([fauxText(asked === "fill" ? LONG : ["loop", "two", "one"].includes(asked) ? LONGER : `did ${asked}`)]);
            }

            const asked = /^(spawn|send|status) (\S+)(?: (.+))?$/.exec(text);

            if (asked !== null && role === "user") {
                const [, action, name, message] = asked;

                return fauxAssistantMessage([fauxToolCall("subagent", { action: action!, name: name!, ...(message === undefined ? {} : { message }) })], { stopReason: "toolUse" });
            }

            return fauxAssistantMessage([fauxText("noted")]);
        }) as never,
    );

    return faux;
}

let app: App;

/**
 * The app on `data`, without compacting a subagent after its work (PP-513, test/subagent-finish.test.ts): these tests
 * hold the compaction before new work, on contexts that one would have made small already.
 */
async function opened(data: string): Promise<App> {
    const made = await openApp(model() as never, data);

    made.config.setSelfCompact("finishedSubagent", false);

    return made;
}

before(async () => {
    app = await opened(join(root, "cold-data"));
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
const subagentOf = async (id: ConversationId, name: string, on = app) => (await on.harness.snapshot(SubagentsDoc, id, context))!.agents[name]!.conversationId;
/** The parent's tool results, newest last. */
const results = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.tool-result").map(textOf);
/** The reports `name` sent the parent. */
const reports = async (id: ConversationId, name: string, on = app) =>
    (await entries(id, on)).filter((entry) => entry.kind === "pi.user" && textOf(entry).includes(`[subagent ${name} answered`)).length;
const compactions = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.compaction");
const usageOf = (entry: EntryRecord) => {
    const usage = (entry.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number } }).usage;

    return usage.input + usage.cacheRead + usage.cacheWrite;
};

/** Tell the parent something, and wait until it, and every subagent it has, are done, with `reported` reports of `name`. */
async function tell(id: ConversationId, text: string, name: string, reported: number, on = app): Promise<void> {
    await on.commands.submit(id, owner(on), { text, requestId: crypto.randomUUID() });
    await until(
        async () => {
            const agent = (await on.harness.snapshot(SubagentsDoc, id, context))?.agents[name];

            return (await reports(id, name, on)) >= reported && !on.isBusy(id) && (agent === undefined || !on.isBusy(agent.conversationId));
        },
        `${name}'s report ${reported}`,
        // The full suite runs many files at once: a long answer takes its time there.
        90_000,
    );
}

/**
 * A parent on faux-2 with a subagent `name` whose runs were `runs` (each "loop", "two" or "one"): its context about
 * 20k tokens a run past Pi's prompt.
 */
async function ran(name: string, runs: readonly string[]): Promise<{ id: ConversationId; sub: ConversationId }> {
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), { model: { provider: "faux", modelId: "faux-2" }, thinkingLevel: "off" });

    for (const [index, run] of runs.entries()) {
        await tell(id, `${index === 0 ? "spawn" : "send"} ${name} ${run}`, name, index + 1);
    }

    return { id, sub: await subagentOf(id, name) };
}

/** A parent with a subagent `name` whose context holds `fills` long answers. */
async function filled(name: string, fills: number, on = app): Promise<{ id: ConversationId; sub: ConversationId }> {
    const id = await newSession(on);

    await tell(id, `spawn ${name} fill`, name, 1, on);

    for (let index = 1; index < fills; index++) {
        await tell(id, `send ${name} fill`, name, index + 1, on);
    }

    return { id, sub: await subagentOf(id, name, on) };
}

test("the cost rule: the context kept, written once and read by each later request, against compacting it first", () => {
    // Opus 5.5's prices (PP-474), a 35k prompt, a 5-minute cache.
    const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const write = writePrice(opus, 300_000);
    const at180 = coldCosts(180_000, 35_000, opus, write, 10);

    // Kept: $0.90 to write, then 9 reads of 180k at $0.20/M. Compacted: $0.50 + $0.06 + 58k written and read 9 times.
    assert.ok(Math.abs(at180.keep - (0.9 + 9 * 0.036)) < 1e-9, `keep ${at180.keep}`);
    assert.ok(Math.abs(at180.compact - (0.5 + 0.06 + 0.29 + 9 * 0.0116)) < 1e-9, `compact ${at180.compact}`);
    assert.ok(Math.abs(at180.saving - (at180.keep - at180.compact)) < 1e-9);
    assert.ok(paysToCompact(180_000, at180));
    // At 120k: the first request alone (the rule before) leaves it; a subagent whose runs make 30 requests compacts.
    assert.equal(paysToCompact(120_000, coldCosts(120_000, 35_000, opus, write, 1)), false);
    assert.ok(paysToCompact(120_000, coldCosts(120_000, 35_000, opus, write, 30)));
    assert.equal(paysToCompact(60_000, coldCosts(60_000, 35_000, opus, write, 10)), false);
    // Under the floor, whatever the prices and the requests: a write ten times the input would pay at 45k.
    const dear = { ...opus, cacheWrite: 40 };

    assert.ok(coldCosts(45_000, 5_000, dear, 40, 40).saving > 0);
    assert.equal(paysToCompact(45_000, coldCosts(45_000, 5_000, dear, 40, 40)), false);
    // The requests a run is taken to make: its own average, else 10, kept in 1–40.
    assert.deepEqual([requestsOf(undefined), requestsOf(0.5), requestsOf(1.6), requestsOf(55)], [10, 1, 1.6, 40]);
});

test("the requests a run makes: the average over the newest five finished runs, each from its message to the next", async () => {
    // Each request its own generation task (Pi Durable hands the run over at each tool round): the task is no run.
    const assistant = (id: number) => ({ id, kind: "pi.assistant", byTaskId: id }) as unknown as EntryRecord;
    const user = (id: number) => ({ id, kind: "pi.user" }) as unknown as EntryRecord;
    const result = (id: number) => ({ id, kind: "pi.tool-result" }) as unknown as EntryRecord;
    // Newest first, in pages of 3: runs of 2, 4 (two messages placed together, the older with no answer of its own),
    // 1, 1 and 1 answers; then an older run of 9, left out.
    const newestFirst = [
        assistant(40), result(39), assistant(38), user(37),
        assistant(36), result(35), assistant(34), result(33), assistant(32), result(31), assistant(30), user(29), user(28),
        assistant(27), user(26), assistant(25), user(24), assistant(23), user(22),
        ...[21, 20, 19, 18, 17, 16, 15, 14, 13].map(assistant), user(12),
    ];
    const pages = (items: readonly EntryRecord[]) => async (cursor: unknown) => {
        const from = typeof cursor === "number" ? cursor : 0;

        return { items: items.slice(from, from + 3), ...(from + 3 < items.length ? { next: from + 3 } : {}) };
    };

    assert.equal(await requestsPerRun(pages(newestFirst)), (2 + 4 + 1 + 1 + 1) / 5);
    assert.equal(await requestsPerRun(pages([user(1)])), undefined);

    // A summary turn after the work (PP-513) is no run: its answer is not counted, and the run before it is.
    const asked = (id: number, text: string) => ({ id, kind: "pi.user", model: [{ role: "user", content: [{ type: "text", text }] }] }) as unknown as EntryRecord;
    const summarized = [assistant(9), asked(8, `${SUMMARY_PREFIX}Your work is done`), assistant(7), result(6), assistant(5), result(4), assistant(3), user(2)];

    assert.equal(await requestsPerRun(pages(summarized)), 3);
});

test("after its work, at warm prices (PP-513): the next run reading the context kept, against the summary turn and the smaller context", () => {
    // Opus 5.5's catalogue prices, a 35k prompt, a 5-minute cache: C' = 35k + 20k + 3k = 58k.
    const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const write = writePrice(opus, 300_000);
    const near = (actual: number, expected: number, what: string) => assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: ${actual}, not ${expected}`);
    const at600 = warmCosts(600_000, 35_000, opus, write, 10);

    // Kept: 10 reads of 600k. Compacted: the summary turn reads 600k and writes 3k; then 58k written once and read 9 times.
    near(at600.keep, 1.2, "600k kept");
    near(at600.compact, 0.12 + 0.06 + 0.29 + 9 * 0.0116, "600k compacted");
    near(at600.after, 58_000, "what is left");
    assert.ok(paysToCompact(600_000, at600));
    // 150k: ten requests leave it ($0.30 against $0.48); thirty compact it ($0.90 against $0.72).
    assert.equal(paysToCompact(150_000, warmCosts(150_000, 35_000, opus, write, 10)), false);
    assert.ok(paysToCompact(150_000, warmCosts(150_000, 35_000, opus, write, 30)));
    // One request never pays: the summary turn reads the whole context once already.
    assert.equal(paysToCompact(600_000, warmCosts(600_000, 35_000, opus, write, 1)), false);
    // Under the floor, whatever the requests.
    assert.equal(paysToCompact(45_000, warmCosts(45_000, 5_000, { ...opus, cacheRead: 4 }, write, 40)), false);
    // The saving recorded from real figures is the rule's when they are the rule's: the summary turn cost its read and output.
    near(warmSaving(600_000, 58_000, 0.12 + 0.06, opus, write, 10), at600.saving, "saving");
});

test("a subagent whose runs make about 30 requests compacts at 120k, where the first request alone would not; one whose runs make 1 or 2 does not", async () => {
    const many = await ran("many", ["loop", "loop", "loop", "loop"]);
    const few = await ran("few", ["two", "one", "two", "one"]);
    const prices = { input: 4, output: 40, cacheRead: 0.2, cacheWrite: 5 };

    app.selfCompact.timing = { ttlMs: 300, leadMs: 100 };

    try {
        await new Promise((resolve) => setTimeout(resolve, 400));

        for (const [name, { sub }, requests] of [["many", many, 30], ["few", few, 1.5]] as const) {
            const figures = await app.coldSubagents.figures(sub);
            const tokens = figures.tokens!;

            // Both near the threshold, about 120k: the rule before (the first request alone) leaves both as they are.
            assert.ok(tokens > 100_000 && tokens < 140_000, `${name}: ${tokens} tokens`);
            assert.equal(paysToCompact(tokens, coldCosts(tokens, figures.promptTokens, prices, 5, 1)), false, `${name}: the rule before`);
            assert.equal(
                paysToCompact(tokens, coldCosts(tokens, figures.promptTokens, prices, 5, requests)),
                name === "many",
                `${name}: the rule with ${requests} requests a run`,
            );
        }

        // 30 requests a run: compacted first, with the saving over them.
        await tell(many.id, "send many work", "many", 5);
        assert.equal((await compactions(many.sub)).length, 1, "many: compacted");
        assert.match((await results(many.id)).at(-1)!, /^Compacted many first: \d+k → \d+k tokens; its cache had gone cold \(\d+ s since its last answer\); about \$\d+\.\d+ saved over ~30 requests\. Sent to many\.$/);

        // 1 or 2 a run: sent as it is.
        await tell(few.id, "send few work", "few", 5);
        assert.equal((await compactions(few.sub)).length, 0, "few: not compacted");
        assert.equal((await results(few.id)).at(-1), "Sent to few.");
    } finally {
        app.selfCompact.timing = undefined;
    }
});

test("a cold, large subagent compacts before the message, and says so; a warm one, or with the setting off, is left as it is", async () => {
    const { id, sub } = await filled("big", 4);

    // Warm (its cache lasts 5 minutes): sent as it is.
    await tell(id, "send big warm", "big", 5);
    assert.equal((await compactions(sub)).length, 0, "warm: not compacted");
    assert.equal((await results(id)).at(-1), "Sent to big.");

    app.selfCompact.timing = { ttlMs: 300, leadMs: 100 };

    try {
        // Cold, with the setting off: sent as it is.
        await app.setSelfCompact(owner(app), "coldSubagent", false);
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tell(id, "send big off", "big", 6);
        assert.equal((await compactions(sub)).length, 0, "off: not compacted");
        await app.setSelfCompact(owner(app), "coldSubagent", true);

        // Cold and large: compacted first, then the message.
        const before = (await entries(sub)).filter((entry) => entry.kind === "pi.assistant").at(-1)!;

        await new Promise((resolve) => setTimeout(resolve, 400));
        await tell(id, "send big work", "big", 7);
        const all = await entries(sub);
        const compaction = all.findIndex((entry) => entry.kind === "pi.compaction");
        const message = all.findIndex((entry) => entry.kind === "pi.user" && textOf(entry).endsWith("work"));
        const answer = all.findIndex((entry, index) => index > message && entry.kind === "pi.assistant");

        assert.equal((await compactions(sub)).length, 1);
        assert.ok(compaction >= 0 && compaction < message && message < answer, `order: ${compaction}, ${message}, ${answer}`);
        // The work's first request writes the smaller context (Pi's prompt, the 20k kept, the summary), not the whole one.
        assert.ok(usageOf(all[answer]!) < 0.8 * usageOf(before), `after ${usageOf(all[answer]!)}, before ${usageOf(before)}`);

        const said = (await results(id)).at(-1)!;

        // Its runs made one request each: the saving is the first request's.
        assert.match(said, /^Compacted big first: \d+k → \d+k tokens; its cache had gone cold \(\d+ s since its last answer\); about \$\d+\.\d+ saved over ~1 request\. Sent to big\.$/);

        // Recorded as the subagent's compaction, with its cost and saving, in its transcript and in Spend.
        const done = (await app.harness.snapshot(SelfCompactDoc, sub, context))!.done;

        assert.equal(done.length, 1);
        assert.equal(done[0]!.reason, "cold");
        assert.equal(done[0]!.entry, Number(all[compaction]!.id));
        // The summarizer's request is its cost (the faux provider prices nothing: 0 here) and what it wrote.
        assert.ok(done[0]!.written > 5_000, `written ${done[0]!.written}`);
        assert.ok(Math.abs(done[0]!.saving - savingOf(done[0]!.before, done[0]!.after, done[0]!.cost, 6.25)) < 1e-9);
        assert.ok(done[0]!.after < 0.8 * done[0]!.before, `${done[0]!.before} → ${done[0]!.after}`);
        assert.ok(app.spend.summary(owner(app)).selfCompactions!.recent.some((each) => each.reason === "cold" && each.entry === done[0]!.entry));
    } finally {
        app.selfCompact.timing = undefined;
        await app.setSelfCompact(owner(app), "coldSubagent", true);
    }
});

test("a cold, small subagent is left as it is", async () => {
    const { id, sub } = await filled("small", 1);

    // One long answer: its context is under the 50k floor.
    app.selfCompact.timing = { ttlMs: 300, leadMs: 100 };

    try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tell(id, "send small work", "small", 2);
        assert.equal((await compactions(sub)).length, 0);
        assert.equal((await results(id)).at(-1), "Sent to small.");
    } finally {
        app.selfCompact.timing = undefined;
    }
});

test("status shows each subagent's context, share of the window, last answer, and cache", async () => {
    const { id } = await filled("shown", 1);

    await tell(id, "status shown", "shown", 1);
    assert.match(
        (await results(id)).at(-1)!,
        /^shown: idle · context \d+k tokens, \d+% of faux\/faux-1's window · last answer \d+ (s|min) ago · cache warm \(it lasts 5 min\)$/,
    );

    app.selfCompact.timing = { ttlMs: 300, leadMs: 100 };

    try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        await tell(id, "status shown", "shown", 1);
        assert.match((await results(id)).at(-1)!, /· cache cold \(it lasts 0 s\)$/);
    } finally {
        app.selfCompact.timing = undefined;
    }
});

test("a restart in the middle of the compaction compacts once and delivers once", async () => {
    const data = join(root, "cold-restart");
    let first: App | undefined = await opened(data);

    try {
        const { id, sub } = await filled("again", 4, first);

        first.selfCompact.timing = { ttlMs: 300, leadMs: 100 };
        await new Promise((resolve) => setTimeout(resolve, 400));
        slowSummary = 8_000;
        summaries = 0;
        await first.commands.submit(id, owner(first), { text: "send again work", requestId: "cold-restart" });
        await until(async () => summaries > 0 && ((await first!.harness.snapshot(LiveDoc, sub, context))?.compactions ?? []).length > 0, "the compaction under way", 60_000);
        await first.close();
        first = undefined;
        // The compaction cut off runs again, slowly: the reporter, run again too, finds it under way and waits for it.
        summaries = 0;
        slowSummary = 1_500;
        // One app per data folder in the process: the shared one steps aside meanwhile.
        await app.close();
        app = await opened(data);
        await until(async () => (await reports(id, "again")) === 5 && !app.isBusy(id) && !app.isBusy(sub), "the report after the restart", 90_000);

        assert.equal(summaries, 1, "one summary after the restart: the compaction cut off, not another");
        assert.equal((await compactions(sub)).length, 1, "compacted once");
        assert.equal((await entries(sub)).filter((entry) => entry.kind === "pi.user" && textOf(entry).endsWith("work")).length, 1, "delivered once");
        assert.equal((await app.harness.snapshot(SelfCompactDoc, sub, context))!.done.length, 1, "recorded once");
        await new Promise((resolve) => setTimeout(resolve, 500));
        assert.equal(await reports(id, "again"), 5, "reported once");
    } finally {
        slowSummary = 0;
        await first?.close();
        await app.close().catch(() => {});
        app = await opened(join(root, "cold-data"));
    }
});
