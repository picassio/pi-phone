// A subagent whose prompt cache went cold, compacted before new work (PP-511, src/server/cold-subagent.ts): a send to
// a cold, large subagent compacts it first, waits for it, and says so, and the work's first request is small; a warm
// one, a small one, or one with the setting off is left as it is; a restart in the middle compacts once and delivers
// once; status shows each subagent's context, share of the window, last answer, and cache.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, root, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type ConversationId, type EntryRecord, LiveDoc } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { coldCosts, paysToCompact } from "../src/server/cold-subagent.ts";
import { SelfCompactDoc, SubagentsDoc } from "../src/server/docs.ts";
import { savingOf, writePrice } from "../src/server/self-compact.ts";

/** About 10,000 tokens an answer, as the faux provider counts (4 characters a token). */
const LONG = "word ".repeat(8_000);
/** Summaries the next compaction waits for, so a test can stop the app in the middle of one. */
let slowSummary = 0;
let summaries = 0;

/**
 * A cache write dear against the input and the output (6.25 to 1 and 5), so compacting pays from a context the tests
 * fill quickly (Opus's own prices are the cost rule's test); and a wide window, so Pi Durable's own compaction stays
 * away. A subagent answers "fill" at length and anything else briefly; the parent calls the subagent tool as it is told.
 */
function model() {
    const faux = fauxProvider({
        tokensPerSecond: 1_000_000,
        models: [{ id: "faux-1", contextWindow: 1_000_000, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 6.25 } }],
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
                return fauxAssistantMessage([fauxText(text === "fill" ? LONG : `did ${text}`)]);
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

before(async () => {
    app = await openApp(model() as never, join(root, "cold-data"));
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

/** A parent with a subagent `name` whose context holds `fills` long answers. */
async function filled(name: string, fills: number, on = app): Promise<{ id: ConversationId; sub: ConversationId }> {
    const id = await newSession(on);

    await tell(id, `spawn ${name} fill`, name, 1, on);

    for (let index = 1; index < fills; index++) {
        await tell(id, `send ${name} fill`, name, index + 1, on);
    }

    return { id, sub: await subagentOf(id, name, on) };
}

test("the cost rule: a cold rewrite of the context against the summarizer, the summary, and what is left to write", () => {
    // Opus 5.5's prices (PP-474), a 35k prompt: at 180k a cold rewrite costs more than compacting; at 60k it does not.
    const opus = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };
    const at180 = coldCosts(180_000, 35_000, opus, writePrice(opus, 300_000));

    assert.ok(Math.abs(at180.cold - 0.9) < 1e-9, `cold ${at180.cold}`);
    assert.ok(paysToCompact(180_000, at180), `compact ${at180.compact}`);
    assert.equal(paysToCompact(60_000, coldCosts(60_000, 35_000, opus, 5)), false);
    // Under the floor, whatever the prices: a write ten times the input would pay at 45k.
    const dear = { ...opus, cacheWrite: 40 };

    assert.ok(coldCosts(45_000, 5_000, dear, 40).cold > coldCosts(45_000, 5_000, dear, 40).compact);
    assert.equal(paysToCompact(45_000, coldCosts(45_000, 5_000, dear, 40)), false);
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

        assert.match(said, /^Compacted big first: \d+k → \d+k tokens; its cache had gone cold \(\d+ s since its last answer\)\. Sent to big\.$/);

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
    let first: App | undefined = await openApp(model() as never, data);

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
        app = await openApp(model() as never, data);
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
        app = await openApp(model() as never, join(root, "cold-data"));
    }
});
