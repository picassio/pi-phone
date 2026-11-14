// Idle subagents retired from their session (PP-515, src/server/subagent-retire.ts): one idle longer than the setting
// leaves the session's subagents at its next subagent call, its conversation kept; a send to it says it was retired and
// does not wake it, and a spawn with its name makes a new one. status lists those at work or idle under a day and
// counts the rest; status all lists every one. One working, or with its report on its way, stays. A restart retires
// them at the server's start, and Spend still counts them with their session. The setting turns it off; the app action
// and the subagents bar's button retire the idle ones now.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, recordCost, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId, EntryRecord } from "@earendil-works/pi-durable";
import { SubagentsDoc } from "../src/server/docs.ts";
import { appSettings } from "../src/server/settings-registry.ts";

const DAY = 86_400_000;
/** The clock moves on by days: everything that reads the time (the app, the records, the messages) reads this one. */
const real = Date.now.bind(Date);
let offset = 0;

Date.now = () => real() + offset;

/** A subagent named hold… answers once this opens. */
let gate: Promise<void> | undefined;

const route: FauxResponseStep = async (request) => {
    const all = JSON.stringify((request as { messages: unknown[] }).messages);
    const { role, text: said } = lastText(request as never);
    const text = said.replace(/^\[from: [^\]]+\] /, "");
    const subagent = /You are the subagent \\"([^\\]+)\\"/.exec(all)?.[1];

    if (subagent !== undefined) {
        if (subagent.startsWith("hold") && gate !== undefined) {
            await gate;
        }

        return fauxAssistantMessage([fauxText(`done ${subagent}`)]);
    }

    const asked = /^(spawn|send|status)(?: (\S+))?(?: (.+))?$/.exec(text);

    if (asked !== null && role === "user") {
        const [, action, name, message] = asked;

        return fauxAssistantMessage(
            [fauxToolCall("subagent", { action: action!, ...(name === undefined ? {} : { name }), ...(message === undefined ? {} : { message }) })],
            { stopReason: "toolUse" },
        );
    }

    return fauxAssistantMessage([fauxText("noted")]);
};

const model = () => scriptedModel(route, { contextWindow: 1_000_000 });

let app: App;

before(async () => {
    app = await openApp(model(), join(root, "retire-data"));
});

after(async () => {
    Date.now = real;
    await app.close();
    cleanUp();
});

const entries = async (id: ConversationId, on = app): Promise<readonly EntryRecord[]> =>
    (await (await on.harness.conversation(id, context))!.entries({ order: "ascending" }, 1000, undefined, context)).items;
const textOf = (entry: EntryRecord): string => {
    const content = (entry.model?.[0] as { content?: unknown } | undefined)?.content;

    return typeof content === "string" ? content : Array.isArray(content) ? (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("") : "";
};
/** The parent's newest tool result. */
const result = async (id: ConversationId, on = app) => (await entries(id, on)).filter((entry) => entry.kind === "pi.tool-result").map(textOf).at(-1);
const doc = async (id: ConversationId, on = app) => (await on.harness.snapshot(SubagentsDoc, id, context))!;

/** Wait until the parent, its subagents, and their reports are all done. */
async function settled(id: ConversationId, on = app): Promise<void> {
    await until(async () => {
        const state = await doc(id, on);

        return (
            Object.values(state.agents).every((agent) => (agent.answeredAt ?? 0) >= (agent.askedAt ?? 0) && agent.finishing === undefined && !on.isBusy(agent.conversationId)) &&
            (state.outbox ?? []).length === 0 &&
            state.sending === undefined &&
            state.courier === undefined &&
            !on.isBusy(id)
        );
    }, "the parent and its subagents idle", 20_000);
}

/** Tell the parent something, and wait until it and its subagents are done. */
async function tell(id: ConversationId, text: string, on = app): Promise<void> {
    await on.commands.submit(id, owner(on), { text, requestId: crypto.randomUUID() });
    await until(async () => on.isBusy(id) || (await entries(id, on)).some((entry) => entry.kind === "pi.user" && textOf(entry).endsWith(text)), "the message placed");
    await settled(id, on);
}

test("a subagent idle longer than the setting is retired at the next subagent call: kept, not woken by a send, its name free", async () => {
    const id = await newSession(app);

    await tell(id, "spawn old Look into it.");
    const first = (await doc(id)).agents.old!.conversationId;
    const before = (await entries(first)).length;

    offset += 4 * DAY;
    await tell(id, "send old One more thing.");

    assert.equal(await result(id), "old was retired (idle 4 days); spawn a new one.");
    assert.equal((await doc(id)).agents.old, undefined, "it left the session's subagents");
    assert.deepEqual(
        (await doc(id)).retired?.map((each) => [each.name, each.conversationId, each.asked]),
        [["old", first, "Look into it."]],
    );
    // Not woken: nothing went to it, and its conversation is still there, this session's.
    assert.equal((await entries(first)).length, before);
    assert.equal(app.isBusy(first), false);
    assert.equal(app.rootOf(first), id);
    assert.deepEqual(app.retiredSubagents(owner(app), id).map((each) => each.name), ["old"]);

    // Its name is free: a spawn makes a new one.
    await tell(id, "spawn old Start again.");
    const second = (await doc(id)).agents.old!.conversationId;

    assert.notEqual(second, first);
    assert.match((await entries(second)).map(textOf).join("\n"), /done old/);
});

test("status lists those at work or idle under a day and counts the older ones; status all lists every one", async () => {
    const id = await newSession(app);

    await tell(id, "spawn early Look.");
    offset += 2 * DAY;
    await tell(id, "spawn late Look.");

    await tell(id, "status");
    const short = (await result(id))!.split("\n");

    assert.equal(short.length, 2, short.join("\n"));
    assert.match(short[0]!, /^late: idle · /);
    assert.equal(short[1], "and 1 older idle one (status all lists them).");

    await tell(id, "status all");
    const all = (await result(id))!;

    assert.match(all, /^early: idle · /m);
    assert.match(all, /^late: idle · /m);

    // Two days on: early, idle 4 days, is retired; late, idle 2, is one of the older ones.
    offset += 2 * DAY;
    await tell(id, "status");
    assert.equal(await result(id), "None at work or idle under a day, and 1 older idle one (status all lists them).");
    assert.deepEqual(Object.keys((await doc(id)).agents), ["late"]);

    await tell(id, "status early");
    assert.equal(await result(id), "early was retired (idle 4 days); spawn a new one.");
});

test("a working subagent, or one with its report on its way, is never retired; once idle, the action retires it now", async () => {
    const id = await newSession(app);
    let open = () => {};

    gate = new Promise<void>((resolve) => {
        open = resolve;
    });

    await app.commands.submit(id, owner(app), { text: "spawn hold Wait for it.", requestId: crypto.randomUUID() });
    await until(async () => (await doc(id)).agents.hold !== undefined && app.isBusy((await doc(id)).agents.hold!.conversationId), "hold at work");

    offset += 10 * DAY;
    assert.deepEqual(await app.subagentRetire.auto(id), [], "working: not retired after the setting");
    assert.deepEqual(await app.subagentRetire.retire(id, 0), [], "working: not retired now either");
    assert.notEqual((await doc(id)).agents.hold, undefined);

    open();
    gate = undefined;
    await settled(id);

    // A report waiting to go to Pi holds it.
    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, id)).outbox = [{ name: "hold", text: "[subagent hold answered, no reply needed] done hold" }];
    }, context);
    assert.deepEqual(await app.subagentRetire.retire(id, 0), [], "a report on its way: not retired");
    await app.harness.commit(async (tx) => {
        (await tx.doc(SubagentsDoc, id)).outbox = [];
    }, context);

    // Idle now, minutes after its answer: the setting leaves it, the action (the bar's button) retires it.
    assert.deepEqual(await app.subagentRetire.auto(id), []);
    const action = appSettings(app).actions.find((each) => each.id === "subagents.retire")!;

    assert.equal(await action.run(owner(app), { session: String(id) }), "Retired 1: hold.");
    assert.equal((await doc(id)).agents.hold, undefined);
    assert.equal(await action.run(owner(app), { session: String(id) }), "No subagent there was idle.");
});

test("the setting: off keeps idle subagents; days are its choices", async () => {
    const setting = appSettings(app).settings.find((each) => each.id === "subagents.retireAfter")!;
    const id = await newSession(app);

    assert.equal(await setting.read(undefined), "3 days");
    await setting.apply(owner(app), "off", undefined);
    assert.equal(await setting.read(undefined), "off");

    await tell(id, "spawn kept Look.");
    offset += 40 * DAY;
    await tell(id, "status");
    assert.equal(await result(id), "None at work or idle under a day, and 1 older idle one (status all lists them).");
    assert.notEqual((await doc(id)).agents.kept, undefined, "off: never retired");

    await assert.rejects(Promise.resolve(setting.apply(owner(app), "5", undefined)), /must be one of 0, 1, 2, 3, 7, 14, 30/);
    await setting.apply(owner(app), "7 days", undefined);
    assert.equal(app.config.subagentRetireDays, 7);
    await setting.apply(owner(app), "3", undefined);
    assert.equal(app.config.subagentRetireDays, 3);
});

test("a restart retires them at the server's start; Spend still counts them with their session", async () => {
    const data = join(root, "retire-restart");
    let on = await openApp(model(), data);
    const id = await newSession(on);

    await tell(id, "spawn helper Look.", on);
    const helper = (await doc(id, on)).agents.helper!.conversationId;

    await recordCost(on, helper, 1.5);
    await until(() => on.spend.sessionSpent(id) >= 1.5, "the subagent's cost in its session's");
    const spent = on.spend.sessionSpent(id);

    await on.close();
    offset += 4 * DAY;
    on = await openApp(model(), data);

    try {
        // No subagent call since: the start retired it.
        assert.deepEqual(Object.keys((await doc(id, on)).agents), []);
        assert.deepEqual((await doc(id, on)).retired?.map((each) => [each.name, each.conversationId]), [["helper", helper]]);
        assert.equal(on.rootOf(helper), id, "still this session's");
        assert.equal(on.spend.sessionSpent(id), spent, "its cost still counts in its session's");
        assert.match((await entries(helper, on)).map(textOf).join("\n"), /done helper/, "its conversation is kept");
    } finally {
        await on.close();
    }
});
