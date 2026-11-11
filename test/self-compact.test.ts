// Self-compaction (PP-473, src/server/self-compact.ts): compact_self queues a compaction that starts once the turn ends,
// with the summary Pi writes in the same run (warm cache) and the app's own sections read from its state; the hook
// "Remind to compact while waiting" goes once a wait, only while the session waits and its context is past the share;
// compacting before the cache expires is off by default, and on it compacts at the time, unless a report came first;
// Spend shows each compaction's cost and saving.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CiWatchesDoc, SelfCompactDoc, SubagentsDoc } from "../src/server/docs.ts";
import { COMPACT_REMINDER_PREFIX, savingOf, SUMMARY_PREFIX } from "../src/server/self-compact.ts";

/**
 * A window of 200,000 tokens and Opus-like prices. A few long answers take the context past 10% of it and past the 20k
 * tokens a compaction keeps, and stay under Pi Durable's own background compaction (the window less 48k).
 */
const faux = fauxProvider({
    tokensPerSecond: 1_000_000,
    models: [{ id: "faux-1", contextWindow: 200_000, cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }],
});
const LONG = "word ".repeat(9_000);

faux.setResponses(
    Array.from({ length: 400 }, () => async (request: { messages: { role: string; content: unknown }[] }) => {
        const messages = request.messages.filter((message) => message.role !== "system");
        const start = messages.findLastIndex((message) => message.role === "user");
        const asked = lastText({ messages: messages.slice(0, start + 1) }).text;
        const results = messages.slice(start + 1).filter((message) => message.role === "toolResult").length;

        if (asked.startsWith(SUMMARY_PREFIX)) {
            return fauxAssistantMessage([fauxText("## Goal\nShip the release.\n## Waiting on\nThe build.")]);
        }

        if (asked.startsWith(COMPACT_REMINDER_PREFIX)) {
            return fauxAssistantMessage([fauxText("Noted.")]);
        }

        if (asked === "fill") {
            return fauxAssistantMessage([fauxText(LONG)]);
        }

        if (asked === "wait for it" && results === 0) {
            return fauxAssistantMessage([fauxToolCall("compact_self", { focus: "the release checklist" })], { stopReason: "toolUse" });
        }

        if (asked === "start a helper" && results === 0) {
            return fauxAssistantMessage([fauxToolCall("subagent", { action: "spawn", name: "helper", message: "look around" })], { stopReason: "toolUse" });
        }

        if (asked === "slow report") {
            await new Promise((resolve) => setTimeout(resolve, 1_500));
        }

        return fauxAssistantMessage([fauxText(asked === "wait for it" ? "Waiting." : "ok")]);
    }) as never,
);

let app: App;

before(async () => {
    app = await openApp(faux as never);
});

after(async () => {
    await app.close();
    cleanUp();
});

const say = async (id: ConversationId, text: string) => {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
};
const entries = async (id: ConversationId): Promise<readonly EntryRecord[]> =>
    (await (await app.harness.conversation(id, context))!.entries({ order: "ascending" }, 1000, undefined, context)).items;
const textOf = (entry: EntryRecord): string => {
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;

    return typeof content === "string" ? content : Array.isArray(content) ? (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("") : "";
};
const users = async (id: ConversationId) => (await entries(id)).filter((entry) => entry.kind === "pi.user").map(textOf);
const compactions = async (id: ConversationId) => (await entries(id)).filter((entry) => entry.kind === "pi.compaction");
/** A session with a long context: past 40% of the window, and more than the 20k tokens a compaction keeps. */
const filled = async () => {
    const id = await newSession(app);

    for (let index = 0; index < 3; index++) {
        await say(id, "fill");
    }

    return id;
};
/** What the session waits on: a CI run it watches. */
const watchCi = (id: ConversationId, run: number) =>
    app.harness.commit(async (tx) => {
        (await tx.doc(CiWatchesDoc, id)).items[`o/r#${run}`] = { taskId: 0, repo: "o/r", runId: run, label: `Build #${run} on main`, workflow: "Build", number: run, branch: "main", url: `https://github.com/o/r/actions/runs/${run}`, startedAt: Date.now() };
    }, context);

test("compact_self queues a compaction that starts once the turn ends, with the summary Pi writes and the pending work read from the app", async () => {
    const id = await filled();

    await watchCi(id, 41);
    await say(id, "wait for it");
    await until(async () => (await compactions(id)).length === 1, "the compaction", 15_000);

    const all = await entries(id);
    const at = (test: (entry: EntryRecord) => boolean) => all.findIndex(test);
    const result = at((entry) => entry.kind === "pi.tool-result" && textOf(entry).startsWith("Queued."));
    const waiting = at((entry) => entry.kind === "pi.assistant" && textOf(entry) === "Waiting.");
    const request = at((entry) => entry.kind === "pi.user" && textOf(entry).startsWith(SUMMARY_PREFIX));
    const summary = at((entry) => entry.kind === "pi.assistant" && textOf(entry).startsWith("## Goal"));
    const compaction = at((entry) => entry.kind === "pi.compaction");

    // Not mid-turn: the turn ends ("Waiting."), then the summary is asked for, then the context compacts.
    assert.ok(
        result >= 0 && result < waiting && waiting < request && request < summary && summary < compaction,
        `order: ${[result, waiting, request, summary, compaction].join(", ")} of ${all.map((entry) => `${entry.kind} ${textOf(entry).slice(0, 30)}`).join(" | ")}`,
    );
    assert.match(textOf(all[request]!), /Keep in particular: the release checklist/);
    assert.match(textOf(all[request]!), /CI run Build #41 on main/, "the request names what the session waits on");

    // The summary entry holds what the app read: the wait, and the last message a person wrote, word for word.
    const placed = textOf(all[compaction]!);

    assert.match(placed, /## Waiting on\n- CI run Build #41 on main/);
    assert.match(placed, /word for word\n<message>\nwait for it\n<\/message>/);

    const done = (await app.harness.snapshot(SelfCompactDoc, id, context))!.done;

    assert.equal(done.length, 1);
    assert.equal(done[0]!.reason, "pi");
    assert.equal(done[0]!.entry, Number(all[compaction]!.id));
    assert.ok(done[0]!.before > done[0]!.after, `before ${done[0]!.before}, after ${done[0]!.after}`);

    // The summary request extends the session's warm prefix (PP-474: Pi Durable's own summarizer sends the history
    // uncached, which costs more than a cold wake-up): the provider reads almost all of it from the cache, and writes only
    // the answer before it and the request itself.
    const usage = (all[summary]!.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number } }).usage;
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite;

    assert.equal(done[0]!.read, usage.cacheRead);
    assert.equal(done[0]!.written, usage.input + usage.cacheWrite);
    assert.ok(usage.cacheRead >= 0.97 * prompt, `read ${usage.cacheRead} of ${prompt}`);
    assert.ok(usage.input + usage.cacheWrite < 2_000, `written ${usage.input + usage.cacheWrite}`);
    assert.equal(done[0]!.before, prompt);

    // Spend: the compaction's cost and its saving, as `savingOf` reckons it at the model's cache-write price.
    const spend = app.spend.summary(owner(app)).selfCompactions!;

    assert.equal(spend.count, 1);
    assert.ok(Math.abs(spend.saved - savingOf(done[0]!.before, done[0]!.after, done[0]!.cost, 6.25)) < 1e-9);
    assert.ok(spend.saved > 0, `saved ${spend.saved}`);
    assert.equal(spend.recent[0]!.session, Number(id));

    // "After" is the next request's whole prompt, Pi's sections and tool schemas with it, as the wake-up writes it
    // (PP-480: the messages alone said 22k where the wake-up wrote 91k). The faux provider counts 4 characters a token,
    // the estimate 3.5.
    await say(id, "back");
    const wake = (await entries(id)).filter((entry) => entry.kind === "pi.assistant").at(-1)!;
    const woke = (wake.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number } }).usage;
    const wrote = woke.input + woke.cacheRead + woke.cacheWrite;

    assert.ok(Math.abs(done[0]!.after - wrote) < 0.2 * wrote, `after ${done[0]!.after}, the wake-up's prompt ${wrote}`);
});

test("compact_self is refused in a subagent and while the owner turned it off", async () => {
    const id = await newSession(app);

    assert.equal(app.selfCompact.refused(id), undefined);
    await say(id, "start a helper");
    await until(async () => (await app.harness.snapshot(SubagentsDoc, id, context))?.agents.helper !== undefined, "the subagent");
    const helper = (await app.harness.snapshot(SubagentsDoc, id, context))!.agents.helper!.conversationId;

    assert.match(app.selfCompact.refused(helper)!, /A subagent does not compact itself: its final answer is its report/);
    await assert.rejects(app.selfCompact.queue(helper, undefined), /A subagent does not compact itself/);
    await app.setSelfCompact(owner(app), "tool", false);

    try {
        assert.match(app.selfCompact.refused(id)!, /turned off/);
        await assert.rejects(app.selfCompact.queue(id, undefined), /turned off/);
    } finally {
        await app.setSelfCompact(owner(app), "tool", true);
    }
});

test("the compact reminder goes once a wait, only while the session waits and its context is past the share", async () => {
    const id = await filled();
    const reminders = async () => (await users(id)).filter((text) => text.startsWith(COMPACT_REMINDER_PREFIX));

    // Nothing pending: none.
    await say(id, "hello");
    assert.equal((await reminders()).length, 0, "nothing pending");

    // Waiting on a CI run, but under the share (95%): none.
    await app.setSelfCompact(owner(app), "remindAt", 95);
    await watchCi(id, 1);
    await say(id, "hello");
    assert.equal((await reminders()).length, 0, "under the share");

    // Past the share (10%): one, which names the wait and the costs.
    await app.setSelfCompact(owner(app), "remindAt", 10);
    await say(id, "hello");
    const sent = await reminders();

    assert.equal(sent.length, 1, "waiting and past the share");
    assert.match(sent[0]!, /CI run Build #1 on main/);
    assert.match(sent[0]!, /a wake-up after that writes the whole context again, about \$/);
    assert.match(sent[0]!, /call compact_self/);

    // The same wait: no second one.
    await say(id, "hello");
    assert.equal((await reminders()).length, 1, "once a wait");

    // A new wait gets one again; with the hook off, none.
    await watchCi(id, 2);
    await say(id, "hello");
    assert.equal((await reminders()).length, 2, "a new wait");
    app.setHook(owner(app), "compactReminder", false);
    await watchCi(id, 3);
    await say(id, "hello");
    assert.equal((await reminders()).length, 2, "the hook off");
    app.setHook(owner(app), "compactReminder", true);
    await app.setSelfCompact(owner(app), "remindAt", 40);
});

test("with the 1-hour cache (PP-475), self-compaction reckons with 1 hour, its lead of 5 minutes, and the 1-hour write price", async () => {
    const id = await filled();
    const other = await newSession(app);

    await app.setSessionCacheRetention(id, owner(app), "long");
    assert.deepEqual(app.selfCompact.timingOf(id), { ttlMs: 3_600_000, leadMs: 300_000 });
    assert.deepEqual(app.selfCompact.timingOf(other), { ttlMs: 300_000, leadMs: 30_000 });
    await app.setSelfCompact(owner(app), "remindAt", 10);

    try {
        // The reminder: the cache lasts 60 minutes, and a cold wake-up writes the context at twice the input price ($10/M).
        await watchCi(id, 51);
        await say(id, "hello");
        const all = await entries(id);
        const at = all.findIndex((entry) => entry.kind === "pi.user" && textOf(entry).startsWith(COMPACT_REMINDER_PREFIX));
        const answer = all.slice(0, at).findLast((entry) => entry.kind === "pi.assistant")!;
        const usage = (answer.model![0] as { usage: { input: number; cacheRead: number; cacheWrite: number; output: number } }).usage;
        const cold = ((usage.input + usage.cacheRead + usage.cacheWrite + usage.output) * 10) / 1_000_000;
        const reminder = textOf(all[at]!);

        assert.match(reminder, /The prompt cache lasts 60 minutes/);
        assert.ok(reminder.includes(`writes the whole context again, about $${cold.toFixed(cold < 0.1 ? 3 : 2)}.`), reminder);

        // compact_self: Spend's saving reckons the wake-up at the 1-hour write price too.
        await say(id, "wait for it");
        await until(async () => (await compactions(id)).length === 1, "the compaction", 15_000);
        const done = (await app.harness.snapshot(SelfCompactDoc, id, context))!.done[0]!;
        // The newest first; reading it after a second compaction also proves Spend keeps plain records, not the document's.
        const recent = app.spend.summary(owner(app)).selfCompactions!.recent[0]!;

        assert.equal(recent.entry, done.entry);
        assert.ok(Math.abs(recent.saving - savingOf(done.before, done.after, done.cost, 10)) < 1e-9, `saved ${recent.saving}`);
    } finally {
        await app.setSelfCompact(owner(app), "remindAt", 40);
    }
});

test("compacting before the cache expires is off by default; on, it compacts at the time, unless a report comes first", async () => {
    assert.equal(app.config.selfCompact.beforeExpiry, false);
    app.selfCompact.timing = { ttlMs: 1_400, leadMs: 400 };
    // The hook would answer first in these turns: this test is about the timer.
    app.setHook(owner(app), "compactReminder", false);
    const id = await filled();

    await watchCi(id, 7);
    await say(id, "hello");
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(app.selfCompact.planned(id), false, "off: nothing planned");

    await app.setSelfCompact(owner(app), "beforeExpiry", true);
    await app.setSelfCompact(owner(app), "remindAt", 10);

    try {
        // A report comes before the time: the session is working then, and nothing is asked.
        await say(id, "hello");
        await until(() => app.selfCompact.planned(id), "the look planned");
        await say(id, "slow report");
        assert.equal((await users(id)).filter((text) => text.startsWith(SUMMARY_PREFIX)).length, 0, "a report first: not compacted");
        await app.setSelfCompact(owner(app), "beforeExpiry", false);
        assert.equal(app.selfCompact.planned(id), false);

        // Idle at the time, waiting, past the share: it asks for the summary, and compacts.
        await app.setSelfCompact(owner(app), "beforeExpiry", true);
        await say(id, "hello");
        await until(async () => (await compactions(id)).length === 1, "the compaction before expiry", 15_000);
        assert.match((await users(id)).find((text) => text.startsWith(SUMMARY_PREFIX))!, /prompt cache is about to expire/);
        assert.equal((await app.harness.snapshot(SelfCompactDoc, id, context))!.done[0]!.reason, "expiry");
    } finally {
        await app.setSelfCompact(owner(app), "beforeExpiry", false);
        await app.setSelfCompact(owner(app), "remindAt", 40);
        app.setHook(owner(app), "compactReminder", true);
    }
});
