// Interviews: Pi asks a form of questions in pi-interview's format, the person answers it in the app, and Pi gets the
// answers in pi-interview's words. The call waits like an approval; the draft is saved as the person goes.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { formatAnswers, outcomeText, validateQuestions } from "../src/server/interviews.ts";

const QUESTIONS = {
    title: "Project setup",
    description: "Review my suggestions and adjust as needed.",
    questions: [
        { id: "context", type: "info", question: "Where we are", context: "SSR and edge.", media: { type: "mermaid", mermaid: "flowchart LR\n A --> B" } },
        { id: "framework", type: "single", question: "Which framework?", options: ["React", "Vue", "Svelte"], recommended: "React", weight: "critical" },
        { id: "features", type: "multi", question: "Which features?", options: ["Auth", { label: "Database", recommended: true }, "API"] },
        { id: "unsure", type: "single", question: "Tabs?", options: ["Tabs", "Spaces"], recommended: "Spaces", conviction: "slight" },
        { id: "notes", type: "text", question: "Anything else?" },
    ],
};
const file = join(work, "questions.json");

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("ask me")) {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: JSON.stringify(QUESTIONS) })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("ask from the file")) {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: file, timeout: 1 })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("ask badly")) {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: '{"questions": [{"id": "a", "type": "single", "question": "?"}]}' })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : "ok")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

after(async () => {
    await app?.close();
    cleanUp();
});

async function ask(id: Parameters<App["commands"]["submit"]>[0], text: string) {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });
    const done = async () => {
        await (await app.harness.submission(submissionId, context))!.wait(context);
        await app.harness.waitForIdle(context);

        return (await modelTexts(app, id)).at(-1)!;
    };

    return { done };
}

const waiting = (id: Parameters<App["approvals"]["forConversation"]>[0]) =>
    app.approvals.forConversation(id).find((each) => each.form?.type === "interview");

test("questions are checked and normalised as pi-interview does", () => {
    const checked = validateQuestions(structuredClone(QUESTIONS));

    assert.deepEqual(checked.questions[2]!.recommended, ["Database"], "an option marked recommended");
    assert.throws(() => validateQuestions({ questions: [{ id: "a", type: "single", question: "?" }] }), /options required/);
    assert.throws(() => validateQuestions({ questions: [{ id: "a", type: "text", question: "?" }, { id: "a", type: "text", question: "?" }] }), /Duplicate question id/);
    assert.throws(() => validateQuestions({ questions: [{ id: "a", type: "single", question: "?", options: ["x"], recommended: "y" }] }), /not in options/);
    assert.throws(() => validateQuestions({ questions: [{ id: "a", type: "text", question: "?", conviction: "strong" }] }), /conviction requires recommended/);

    const text = formatAnswers([{ id: "framework", value: { option: "Vue", note: "smaller" } }, { id: "notes", value: "" }], checked.questions);

    assert.match(text, /^- Which framework\?: Vue \(smaller\)\n\nStructured response data:/);
    assert.doesNotMatch(text, /Anything else/, "empty answers are left out");
    assert.match(outcomeText({ questions: checked, draft: [], status: "cancelled", createdAt: 0 }), /^User skipped the interview/);
});

test("Pi asks; the person answers in the form, saved as they go, and submits: Pi gets the answers", async () => {
    const id = await newSession(app);
    const turn = await ask(id, "ask me");

    await until(() => waiting(id) !== undefined, "the interview");
    const request = waiting(id)!;

    assert.equal(request.form?.type === "interview" && request.form.count, 4, "info is not a question to answer");
    assert.equal(request.form?.type === "interview" && request.form.title, "Project setup");

    const callId = request.form?.type === "interview" ? request.form.callId : "";
    const asked = await app.interview(id, callId, owner(app));

    // What Pi recommends is pre-selected, unless it is unsure.
    assert.deepEqual(asked.draft, [
        { id: "framework", value: { option: "React" } },
        { id: "features", value: [{ option: "Database" }] },
    ]);
    await assert.rejects(app.answerApproval(request.id, true, owner(app)), /answer it in its form/);
    await assert.rejects(app.answerInterview(id, callId, owner(app), { draft: [{ id: "nope", value: "x" }] }), /names one of the questions/);

    const draft = [
        { id: "framework", value: { option: "Svelte", note: "we know it" } },
        { id: "features", value: [{ option: "Auth" }, { option: "Database" }] },
        { id: "notes", value: "Ship by Friday" },
    ];

    await app.answerInterview(id, callId, owner(app), { draft });
    assert.deepEqual((await app.interview(id, callId, owner(app))).draft, draft, "saved as they go");
    assert.ok(waiting(id) !== undefined, "and still waiting");

    await app.answerInterview(id, callId, owner(app), { action: "submit" });
    const answer = await turn.done();

    assert.match(answer, /User completed the interview form/);
    assert.match(answer, /Which framework\?: Svelte \(we know it\)/);
    assert.match(answer, /Which features\?: Auth, Database/);
    assert.match(answer, /Anything else\?: Ship by Friday/);
    assert.equal((await app.interview(id, callId, owner(app))).status, "completed");
    await assert.rejects(app.answerInterview(id, callId, owner(app), { action: "submit" }), /has ended/);
});

test("skipping from the card, or a timeout, still gives Pi what was answered; bad questions say why", async () => {
    const id = await newSession(app);
    const turn = await ask(id, "ask me");

    await until(() => waiting(id) !== undefined, "the interview");
    assert.ok(await app.answerApproval(waiting(id)!.id, false, owner(app)));
    assert.match(await turn.done(), /User cancelled the interview with partial responses[^]*Which framework\?: React/);

    mkdirSync(work, { recursive: true });
    writeFileSync(file, JSON.stringify({ title: "Quick", questions: [{ id: "n", type: "text", question: "Name?" }] }));
    const timed = await ask(id, "ask from the file");

    assert.match(await timed.done(), /timed out after 1 seconds, without answers/);
    assert.equal(waiting(id), undefined);

    assert.match(await (await ask(id, "ask badly")).done(), /options required for type ..single/);
});

test("asking is allowed in plan mode: the person answers, Pi changes nothing", () => {
    assert.equal(blockedInPlanMode("interview", { questions: "{}" }), undefined);
});
