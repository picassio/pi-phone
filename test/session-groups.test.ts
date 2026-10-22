// Folder groups in the session list (PP-76): each person's own, kept on the server and sent only to them; a session in
// one group at most; pinned, folded and ordered; deleting one sends its sessions back to Active; guests can't.
import { type App, cleanUp, context, fakeTab, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";

/** "tool <name> <json>" calls that tool (after "[from: …]" once there are several people); its result comes back. */
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);
    const asked = role === "user" ? /^(?:\[from: [^\]]+\] )?tool (\S+) (.*)$/s.exec(text) : null;

    return asked === null ? fauxAssistantMessage([fauxText(`said: ${text}`)]) : fauxAssistantMessage([fauxToolCall(asked[1]!, JSON.parse(asked[2]!))], { stopReason: "toolUse" });
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app.close();
    cleanUp();
});

test("a person makes groups, moves sessions in and out, pins, folds, orders and deletes them; only they hear of it", async () => {
    const me = owner(app);
    const member = app.config.addUser("Member", "guest").user;
    const mine = fakeTab(undefined, me);
    const theirs = fakeTab(undefined, member);
    const [a, b, c] = [await newSession(app), await newSession(app), await newSession(app)];

    await app.attach(mine.client);
    await app.attach(theirs.client);

    try {
        const made = await app.sessionGroups.change(me, { action: "create", name: "  CMG   Pimcore ", sessions: [a, b] });
        const cmg = made.group!;

        assert.equal(cmg.name, "CMG Pimcore", "spaces tidied");
        assert.deepEqual(made.members, { [a]: cmg.id, [b]: cmg.id });

        const hr = (await app.sessionGroups.change(me, { action: "create", name: "Interviews" })).group!;

        // One group per session: moving b to Interviews takes it out of CMG Pimcore.
        await app.sessionGroups.change(me, { action: "move", sessions: [b, c], group: hr.id });
        assert.deepEqual((await app.sessionGroups.list(me)).members, { [a]: cmg.id, [b]: hr.id, [c]: hr.id });

        // Out of every group.
        await app.sessionGroups.change(me, { action: "move", sessions: [c], group: null });
        assert.equal((await app.sessionGroups.list(me)).members[String(c)], undefined);

        await app.sessionGroups.change(me, { action: "pin", id: hr.id, pinned: true });
        await app.sessionGroups.change(me, { action: "fold", id: cmg.id, folded: true });
        await app.sessionGroups.change(me, { action: "rename", id: hr.id, name: "Hiring" });
        await app.sessionGroups.change(me, { action: "order", order: [hr.id, cmg.id] });

        const now = await app.sessionGroups.list(me);

        assert.deepEqual(
            now.groups.map((group) => [group.name, group.pinned, group.folded]),
            [
                ["Hiring", true, false],
                ["CMG Pimcore", false, true],
            ],
        );

        // Every tab of theirs heard it; nobody else did, and nobody else has any.
        assert.deepEqual(mine.last("session-groups"), now);
        assert.deepEqual(theirs.last("session-groups"), { groups: [], members: {} });
        assert.deepEqual(await app.sessionGroups.list(member), { groups: [], members: {} });

        // Deleting a group: its sessions go back to Active (no group), and nothing else changes.
        const left = await app.sessionGroups.change(me, { action: "delete", id: cmg.id });

        assert.deepEqual(left.groups.map((group) => group.name), ["Hiring"]);
        assert.deepEqual(left.members, { [b]: hr.id });
        assert.equal(app.sessionMeta(a)?.archived, undefined, "not archived");
    } finally {
        app.detach(mine.client);
        app.detach(theirs.client);
    }
});

test("a bad change is refused with why; a viewer or an invited guest can't change groups", async () => {
    const me = owner(app);
    const viewer = app.config.addUser("Viewer", "viewer").user;
    const guest = app.config.addUser("Guest", "guest", ["1"]).user;

    await assert.rejects(app.sessionGroups.change(me, { action: "create", name: " " }), { status: 400 });
    await assert.rejects(app.sessionGroups.change(me, { action: "create", name: "x".repeat(61) }), { status: 400 });
    await assert.rejects(app.sessionGroups.change(me, { action: "rename", id: "nope", name: "x" }), { status: 404 });
    await assert.rejects(app.sessionGroups.change(me, { action: "move", sessions: [999_999], group: null }), { status: 404 });
    await assert.rejects(app.sessionGroups.change(me, { action: "order", order: ["nope"] }), { status: 400 });
    await assert.rejects(app.sessionGroups.change(me, { action: "explode" }), { status: 400 });
    await assert.rejects(app.sessionGroups.change(viewer, { action: "create", name: "Mine" }), { status: 403 });
    await assert.rejects(app.sessionGroups.change(guest, { action: "create", name: "Mine" }), { status: 403 });
});

test("Pi's tools: list, create with sessions, rename, pin, fold, order, move; deleting asks on a card first", async () => {
    const me = owner(app);
    const here = await newSession(app);
    const [a, b] = [await newSession(app), await newSession(app)];
    const before = (await app.sessionGroups.list(me)).groups.length;
    const tool = async (name: string, args: unknown) => {
        const { submissionId } = await app.commands.submit(here, me, { text: `tool ${name} ${JSON.stringify(args)}`, requestId: crypto.randomUUID() });

        return (await app.harness.submission(submissionId, context))!.wait(context);
    };
    const groups = async () => (await app.sessionGroups.list(me)).groups;

    await tool("session_group_create", { name: "Pi made", sessions: [a, b] });
    const made = (await groups()).find((group) => group.name === "Pi made")!;

    assert.equal((await groups()).length, before + 1);
    assert.equal((await app.sessionGroups.list(me)).members[String(a)], made.id);

    await tool("session_group_rename", { group: "Pi made", name: "Pi's" });
    await tool("session_group_pin", { group: made.id, pinned: true });
    await tool("session_group_fold", { group: "Pi's", folded: true });
    await tool("session_group_move", { sessions: [b], group: null });

    const now = (await groups()).find((group) => group.id === made.id)!;

    assert.deepEqual([now.name, now.pinned, now.folded], ["Pi's", true, true]);
    assert.equal((await app.sessionGroups.list(me)).members[String(b)], undefined, "out of every group");

    const order = [made.id, ...(await groups()).filter((group) => group.id !== made.id).map((group) => group.id)];

    await tool("session_group_order", { groups: order });
    assert.equal((await groups())[0]!.id, made.id, "first");

    // Deleting waits for the person's answer on a card: no, and it stays; yes, and its session goes back to Active.
    const ask = () => tool("session_group_delete", { group: "Pi's", reason: "tidy up" });
    const refused = ask();

    await until(() => app.approvals.forConversation(here).length > 0, "the card", 10_000);
    const card = app.approvals.forConversation(here)[0]!;

    assert.match(card.subject, /Delete the group Pi's: its session goes back to Active/);
    await app.answerApproval(card.id, false, me);
    await refused;
    assert.ok((await groups()).some((group) => group.id === made.id), "still there");

    const allowed = ask();

    await until(() => app.approvals.forConversation(here).length > 0, "the second card", 10_000);
    await app.answerApproval(app.approvals.forConversation(here)[0]!.id, true, me);
    await allowed;
    assert.ok(!(await groups()).some((group) => group.id === made.id), "deleted");
    assert.equal((await app.sessionGroups.list(me)).members[String(a)], undefined, "back to Active");
});
