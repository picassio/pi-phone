// Pi's tools for the owner's library (PP-468, extensions/library.ts): skill_save and command_save draft and save only
// after the owner approves a card with the whole content (and the diff for an edit); library_pin, library_undo and
// library_delete ask with what and where; library_list only reads. A guest is refused before any card, and cannot
// approve one. An item changed while its card waited is not overwritten. All six wait for tool_search.
import { type App, cleanUp, context, lastText, newSession, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DEFERRED_TOOLS } from "../src/server/deferred-tools.ts";
import { libraryDiff, withFrontMatter } from "../src/server/extensions/library.ts";
import type { ApprovalRequest, LibraryForm } from "../src/server/host.ts";

const BODY = "# SSP review\n\n1. Run `npm test` in ~/work/ssp.\n2. Check the migrations.\n";
const calls: Record<string, [string, Record<string, unknown>]> = {
    "make the skill": ["skill_save", { name: "ssp-review", description: "Review a change to SSP. Use when the owner asks to review an SSP PR.", body: BODY, files: { "references/migrations.md": "Check down migrations too.\n" }, note: "first" }],
    "edit the skill": ["skill_save", { name: "ssp-review", description: "Review a change to SSP. Use when the owner asks to review an SSP PR or diff.", body: `${BODY}3. Post the summary on the PR.\n`, note: "post the summary" }],
    "same again": ["skill_save", { name: "ssp-review", description: "Review a change to SSP. Use when the owner asks to review an SSP PR or diff.", body: `${BODY}3. Post the summary on the PR.\n` }],
    "bad name": ["skill_save", { name: "SSP Review", description: "x", body: "y" }],
    "make the command": ["command_save", { name: "ssp-review", description: "Review an SSP PR", template: "Review the SSP pull request ${1:-I name next} with the ssp-review skill.", argument_hint: "[pr]" }],
    "pin it here": ["library_pin", { name: "ssp-review", kind: "skill", scope: "session" }],
    "pin it everywhere": ["library_pin", { name: "ssp-review", kind: "skill", scope: "all" }],
    "unpin it here": ["library_pin", { name: "ssp-review", kind: "skill", scope: "session", pinned: false }],
    "pin without kind": ["library_pin", { name: "ssp-review", scope: "all" }],
    "list": ["library_list", {}],
    "show it": ["library_list", { name: "ssp-review", kind: "skill" }],
    "undo it": ["library_undo", { name: "ssp-review", kind: "skill" }],
    "delete it": ["library_delete", { name: "ssp-review", kind: "command" }],
};
const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    for (const [ask, [tool, args]] of Object.entries(calls)) {
        // Another person's message comes with their name before it: "[from: Gina] list".
        if (role === "user" && text.replace(/^\[from: [^\]]+\] /, "") === ask) {
            return fauxAssistantMessage([fauxToolCall(tool, args as never)], { stopReason: "toolUse" });
        }
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `told: ${text}` : "ok")]);
};
let app: App;
let id: ConversationId;

before(async () => {
    app = await openApp(scriptedModel(route));
    id = await newSession(app);
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** One turn as `user`; with `answer`, its card is read (and `meanwhile` run) before it is answered so. */
async function turn(text: string, answer?: boolean, user = owner(app), meanwhile?: () => void): Promise<{ said: string; card?: ApprovalRequest & { form: LibraryForm } }> {
    const { submissionId } = await app.commands.submit(id, user, { text, requestId: crypto.randomUUID() });
    let card: (ApprovalRequest & { form: LibraryForm }) | undefined;

    if (answer !== undefined) {
        await until(() => app.approvals.forConversation(id).length > 0, "the card");
        card = app.approvals.forConversation(id)[0] as ApprovalRequest & { form: LibraryForm };
        meanwhile?.();
        await app.answerApproval(card.id, answer, owner(app));
    }

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    const view = await (await app.harness.conversation(id, context))!.context(context);
    const said = view.messages.filter((message) => message.role === "toolResult").at(-1);

    return { said: JSON.stringify(said?.content ?? ""), ...(card === undefined ? {} : { card }) };
}

test("all six wait for tool_search", () => {
    for (const name of ["skill_save", "command_save", "library_pin", "library_list", "library_undo", "library_delete"]) {
        assert.ok(DEFERRED_TOOLS.includes(name), name);
    }
});

test("skill_save: the card shows the whole skill; nothing is saved before Approve, nor on Deny", async () => {
    let waiting = 0;
    const denied = await turn("make the skill", false, owner(app), () => {
        waiting = app.library.list().length;
    });

    assert.equal(waiting, 0, "nothing saved while the card waits");
    assert.equal(denied.card?.tool, "skill_save");
    assert.equal(denied.card?.subject, "Save the new skill ssp-review");
    assert.equal(denied.card?.form.action, "save");
    assert.equal(denied.card?.form.diff, undefined, "a new skill has no diff");
    assert.deepEqual(
        denied.card?.form.files?.map((file) => file.path),
        ["SKILL.md", "references/migrations.md"],
    );
    assert.equal(
        denied.card?.form.files?.[0]?.text,
        `---\nname: "ssp-review"\ndescription: "Review a change to SSP. Use when the owner asks to review an SSP PR."\n---\n\n${BODY}`,
    );
    assert.match(denied.said, /declined: nothing was saved/);
    assert.equal(app.library.list().length, 0);

    const saved = await turn("make the skill", true);

    assert.match(saved.said, /Saved the skill ssp-review as version 1 .*pinned nowhere\. Pin it where it should be used with library_pin/);
    assert.equal(app.library.item("skill", "ssp-review").description, "Review a change to SSP. Use when the owner asks to review an SSP PR.");
    assert.match((await turn("bad name")).said, /SSP Review is not a valid name/);
});

test("an edit: the card shows the diff and the version it replaces; other files and front matter keys are kept", async () => {
    // The owner added a key on the page: Pi's edit keeps it.
    const files = app.library.files("skill", "ssp-review");

    app.library.save("skill", "ssp-review", { ...files, "SKILL.md": files["SKILL.md"]!.replace("---\n\n", "compatibility: \"Needs node\"\n---\n\n") });

    const edit = await turn("edit the skill", true);

    assert.equal(edit.card?.subject, "Save the skill ssp-review: version 2 → a new version");
    assert.equal(edit.card?.form.from, 2);
    assert.equal(edit.card?.form.note, "post the summary");
    assert.match(edit.card?.form.diff ?? "", /^--- SKILL\.md\n\+\+\+ SKILL\.md\n@@ [^]*-description: "Review a change to SSP\. Use when the owner asks to review an SSP PR\."\n\+description: [^]*\+3\. Post the summary on the PR\./);
    assert.doesNotMatch(edit.card?.form.diff ?? "", /migrations\.md/, "an unchanged file is not in the diff");
    assert.match(edit.said, /as version 3/);

    const now = app.library.files("skill", "ssp-review");

    assert.equal(now["references/migrations.md"], "Check down migrations too.\n");
    assert.match(now["SKILL.md"]!, /^---\nname: "ssp-review"\ndescription: "[^"]+or diff\."\ncompatibility: "Needs node"\n---\n/);
    assert.match((await turn("same again")).said, /already like this: nothing to save/);
    assert.equal(app.approvals.forConversation(id).length, 0);
});

test("command_save writes a prompt template with its description and argument hint", async () => {
    const saved = await turn("make the command", true);

    assert.equal(saved.card?.form.kind, "command");
    assert.deepEqual(saved.card?.form.files?.map((file) => file.path), ["ssp-review.md"]);
    assert.match(saved.said, /Saved the command ssp-review as version 1 .*Typed as \/ssp-review/);
    assert.equal(
        readFileSync(app.library.pathOf("command", "ssp-review"), "utf8"),
        '---\ndescription: "Review an SSP PR"\nargument-hint: "[pr]"\n---\n\nReview the SSP pull request ${1:-I name next} with the ssp-review skill.\n',
    );
    assert.equal(app.library.item("command", "ssp-review").argumentHint, "[pr]");
});

test("library_pin asks with what and where; this session by default; a name of two kinds needs the kind", async () => {
    assert.match((await turn("pin without kind")).said, /a skill and a command named ssp-review: give the kind/);

    const pin = await turn("pin it here", true);
    const title = app.sessionMeta(id)?.title ?? "New session";

    assert.equal(pin.card?.subject, `Pin the skill ssp-review to session ${String(id)} (${title})`);
    assert.deepEqual(pin.card?.form.pin, { scope: "session", target: String(id), label: title, pinned: true });
    assert.match(pin.said, new RegExp(`Pinned the skill ssp-review: now pinned to session ${String(id)}`));
    assert.deepEqual(app.librarySkills(id), [app.library.pathOf("skill", "ssp-review")]);

    const denied = await turn("pin it everywhere", false);

    assert.equal(denied.card?.subject, "Pin the skill ssp-review to every session");
    assert.match(denied.said, /declined: the pins stay as they were/);
    assert.match((await turn("pin it here")).said, /already pinned to session/);

    const unpin = await turn("unpin it here", true);

    assert.equal(unpin.card?.subject, `Unpin the skill ssp-review from session ${String(id)} (${title})`);
    assert.deepEqual(app.librarySkills(id), []);
});

test("library_list reads without a card: every item, then one's files and versions", async () => {
    const all = await turn("list");

    assert.match(all.said, /- skill ssp-review \(version 3, 3 kept\), pinned nowhere: Review a change to SSP/);
    assert.match(all.said, /- command \/ssp-review \(version 1, 1 kept\), pinned nowhere: Review an SSP PR/);

    const one = await turn("show it");

    assert.match(one.said, /skill ssp-review, at version 3, pinned nowhere/);
    assert.match(one.said, /Versions \(newest first\): 3 \(current\) [\d-]+ [\d:]+ post the summary; 2 [^;]+; 1 [\d-]+ [\d:]+ first/);
    assert.match(one.said, /=== references\/migrations\.md\\nCheck down migrations too\./);
    assert.equal(app.approvals.forConversation(id).length, 0);
});

test("library_undo asks with the change back; library_delete with its versions; both change only on Approve", async () => {
    const undo = await turn("undo it", true);

    assert.equal(undo.card?.subject, "Take the skill ssp-review back: version 3 → 2");
    assert.equal(undo.card?.form.from, 3);
    assert.equal(undo.card?.form.to, 2);
    assert.match(undo.card?.form.diff ?? "", /-3\. Post the summary on the PR\./);
    assert.equal(app.library.item("skill", "ssp-review").version, 2);

    const kept = await turn("delete it", false);

    assert.equal(kept.card?.subject, "Delete the command ssp-review and its 1 kept version");
    assert.equal(kept.card?.form.versions, 1);
    assert.equal(app.library.item("command", "ssp-review").version, 1);

    await turn("delete it", true);
    assert.deepEqual(app.library.list().map((item) => `${item.kind} ${item.name}`), ["skill ssp-review"]);
});

test("an item changed while its card waited is not overwritten", async () => {
    const before = app.library.item("skill", "ssp-review").version;
    const raced = await turn("edit the skill", true, owner(app), () => {
        app.library.save("skill", "ssp-review", { ...app.library.files("skill", "ssp-review"), "notes.md": "The owner's own edit.\n" });
    });

    assert.match(raced.said, /changed while the card waited \(now at version 4\): nothing was done/);
    assert.equal(app.library.item("skill", "ssp-review").version, 4);
    assert.equal(before, 2);
});

test("a guest is refused before any card, and cannot approve a library card", async () => {
    const guest = app.config.addUser("Gina", "guest");
    const refused = await turn("list", undefined, guest.user);

    assert.match(refused.said, /The library of skills and commands is the owner's/);
    assert.equal(app.approvals.forConversation(id).length, 0);

    const { submissionId } = await app.commands.submit(id, owner(app), { text: "pin it everywhere", requestId: crypto.randomUUID() });

    await until(() => app.approvals.forConversation(id).length > 0, "the card");
    const card = app.approvals.forConversation(id)[0]!;

    await assert.rejects(app.answerApproval(card.id, true, guest.user), /The library of skills and commands is the owner's/);
    await app.answerApproval(card.id, false, owner(app));
    await (await app.harness.submission(submissionId, context))!.wait(context);
});

test("the diff and front matter helpers", () => {
    assert.equal(libraryDiff({ a: "x\n" }, { a: "x\n" }), "");
    assert.equal(libraryDiff({}, { "b.md": "new\n" }), "--- b.md\n+++ b.md\n@@ -0,0 +1,1 @@\n+new\n");
    assert.equal(withFrontMatter({ description: 'Say "hi": twice', "argument-hint": undefined }, { "odd key": [1] }, "\n\nBody  \n"), '---\ndescription: "Say \\"hi\\": twice"\n"odd key": [1]\n---\n\nBody\n');
});
