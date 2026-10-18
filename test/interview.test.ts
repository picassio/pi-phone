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

    // The helpers on the session's model (interview-helpers.ts).
    if (role === "user" && text.startsWith("Someone is answering a form. Suggest")) {
        return fauxAssistantMessage([fauxText('Here: ["Solid", "react", "Angular", "Solid"]')]);
    }

    if (role === "user" && text.startsWith("Someone is answering a form. Review")) {
        return fauxAssistantMessage([fauxText('```json\n{"question": "Which UI framework should the app use?", "options": ["React", "Vue.js", "Svelte"], "why": "Names Vue in full."}\n```')]);
    }

    if (role === "user" && text.startsWith("Someone answering a form asks about one")) {
        const asked = /They ask: (.*)$/.exec(text)?.[1];
        const before = (text.match(/They asked: /g) ?? []).length;

        return fauxAssistantMessage([fauxText(`About ${/The option they ask about: (.*)/.exec(text)?.[1]}: ${asked} (${before} before)`)]);
    }

    if (role === "user" && text.endsWith("ask me later")) {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: JSON.stringify(QUESTIONS), async: true })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("ask later, briefly")) {
        return fauxAssistantMessage([fauxToolCall("interview", { questions: JSON.stringify({ questions: [{ id: "n", type: "text", question: "Name?" }] }), async: true, timeout: 1 })], { stopReason: "toolUse" });
    }

    if (role === "user" && /Interview \w+ finished\./.test(text)) {
        return fauxAssistantMessage([fauxText(`heard back: ${text}`)]);
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

test("async: the call returns at once, Pi keeps going, and the answers come later as a message that starts a turn", async () => {
    const id = await newSession(app);
    const answer = await (await ask(id, "ask me later")).done();
    const shortId = /Interview (\w+) is open in the app/.exec(answer)?.[1];

    assert.ok(shortId, answer);
    assert.match(answer, new RegExp(`answers come in a message starting \\\\?"Interview ${shortId} finished\\.`));
    // The turn ended, and the form still waits for the person.
    await until(() => waiting(id) !== undefined, "the interview");
    const request = waiting(id)!;
    const callId = request.form?.type === "interview" ? request.form.callId : "";

    await app.answerInterview(id, callId, owner(app), { draft: [{ id: "framework", value: { option: "Vue" } }, { id: "notes", value: "later is fine" }], action: "submit" });
    await until(async () => (await modelTexts(app, id)).some((text) => text.includes("heard back:")), "the answers' message, and Pi's turn");
    const heard = (await modelTexts(app, id)).find((text) => text.includes("heard back:"))!;

    assert.match(heard, new RegExp(`Interview ${shortId} finished\\.`));
    assert.match(heard, /User completed the interview form/);
    assert.match(heard, /Which framework\?: Vue/);
    assert.match(heard, /Anything else\?: later is fine/);
    assert.equal(waiting(id), undefined);

    // A timeout ends it too, and says so.
    await (await ask(id, "ask later, briefly")).done();
    await until(async () => (await modelTexts(app, id)).filter((text) => text.includes("heard back:")).length === 2, "the timeout's message");
    assert.match((await modelTexts(app, id)).filter((text) => text.includes("heard back:"))[1]!, /timed out after 1 seconds, without answers/);
});

test("helpers on the session's model: more options, a review to take, and asking about an option, kept with the interview", async () => {
    const id = await newSession(app);
    const turn = await ask(id, "ask me");

    await until(() => waiting(id) !== undefined, "the interview");
    const request = waiting(id)!;
    const callId = request.form?.type === "interview" ? request.form.callId : "";
    const helpers = app.interviewHelpers;
    const framework = async () => (await app.interview(id, callId, owner(app))).questions.questions.find((each) => each.id === "framework")!;

    // More options: new ones only, once each, whatever their case.
    await helpers.moreOptions(id, callId, "framework");
    assert.deepEqual((await framework()).options, ["React", "Vue", "Svelte", "Solid", "Angular"]);
    await assert.rejects(helpers.moreOptions(id, callId, "notes"), /single and multiple choice/);

    // A review is a proposal; using it renames the options, and the person's choice and note go with theirs.
    await app.answerInterview(id, callId, owner(app), { draft: [{ id: "framework", value: { option: "Vue", note: "we know it" } }] });
    const review = await helpers.review(id, callId, "framework");

    assert.deepEqual(review, { question: "Which UI framework should the app use?", options: ["React", "Vue.js", "Svelte"], why: "Names Vue in full." });
    assert.equal((await framework()).question, "Which framework?", "not applied until used");
    const used = await helpers.useReview(id, callId, "framework", review);

    assert.equal((await framework()).question, "Which UI framework should the app use?");
    assert.deepEqual((await framework()).options, ["React", "Vue.js", "Svelte"]);
    assert.equal((await framework()).recommended, "React");
    assert.deepEqual(used.draft.find((each) => each.id === "framework")?.value, { option: "Vue.js", note: "we know it" });
    await assert.rejects(helpers.useReview(id, callId, "framework", { question: "?", options: ["one"] }), /at least two options/);

    // Asking: the thread grows, the model reads what came before, and it stays with the interview.
    await helpers.ask(id, callId, "framework", "Svelte", "Pros and cons?");
    const asked = await helpers.ask(id, callId, "framework", "Svelte", "Is it fast?");

    assert.deepEqual(
        asked.asked?.["framework\nSvelte"]?.map((each) => [each.q, each.a]),
        [
            ["Pros and cons?", "About Svelte: Pros and cons? (0 before)"],
            ["Is it fast?", "About Svelte: Is it fast? (1 before)"],
        ],
    );
    await assert.rejects(helpers.ask(id, callId, "framework", "Ember", "Hm?"), /Not one of this question's options/);

    // Pi gets the answer with the question as it is now.
    await app.answerInterview(id, callId, owner(app), { action: "submit" });
    assert.match(await turn.done(), /Which UI framework should the app use\?: Vue\.js \(we know it\)/);
    await assert.rejects(helpers.moreOptions(id, callId, "framework"), /has ended/);
});

test("asking is allowed in plan mode: the person answers, Pi changes nothing", () => {
    assert.equal(blockedInPlanMode("interview", { questions: "{}" }), undefined);
});
