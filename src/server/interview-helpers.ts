/**
 * pi-interview's helpers for single and multiple choice questions, on the session's own model (`side-model.ts`):
 *
 * - **More options** ("✦ Generate more"): up to three new choices, added to the question;
 * - **Review**: the question and its options rewritten for clarity, shown as a proposal the person takes or leaves;
 * - **Ask** about one option: a short thread of the person's questions and the model's answers beside it, kept with the
 *   interview (`asked`), so it is there when the form opens again.
 *
 * Each works only while the interview waits, for those who may steer. The model reads the interview's title and
 * description, the question, its context, and its options; Pi gets the answers as before, with any options added.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { HttpError } from "./errors.ts";
import { type Interview, InterviewsDoc, type OptionValue, type Question } from "./interviews.ts";
import { askSessionModel } from "./side-model.ts";

const context = BACKGROUND_CONTEXT;
const MAX_NEW_OPTIONS = 3;
const MAX_OPTIONS = 20;
const MAX_ASK_CHARS = 2000;
/** One option's thread: question and answer pairs, the newest last. */
const MAX_THREAD = 12;

export type Thread = { q: string; a: string; at: number }[];
export type Review = { question: string; options: string[]; why: string };

const labelOf = (option: OptionValue) => (typeof option === "string" ? option : option.label);

/** The question as the model reads it. */
function describeQuestion(interview: Interview, question: Question): string {
    const lines = [
        interview.questions.title === undefined ? "" : `Form: ${interview.questions.title}`,
        interview.questions.description === undefined ? "" : `About the form: ${interview.questions.description}`,
        `Question (${question.type === "multi" ? "pick any" : "pick one"}): ${question.question}`,
        question.context === undefined ? "" : `Context: ${question.context}`,
        "Options:",
        ...(question.options ?? []).map((option) => `- ${labelOf(option)}`),
    ];

    return lines.filter((line) => line !== "").join("\n");
}

/** The first JSON value of `kind` in a reply, which may come fenced or with words around it. */
function jsonIn(text: string, kind: "[" | "{"): unknown {
    const start = text.indexOf(kind);
    const end = text.lastIndexOf(kind === "[" ? "]" : "}");

    if (start === -1 || end <= start) {
        throw new HttpError(502, "The model's reply had no answer in it. Try again.");
    }

    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        throw new HttpError(502, "The model's reply could not be read. Try again.");
    }
}

export class InterviewHelpers {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The waiting interview and one of its choice questions, or why not. */
    async #find(id: ConversationId, callId: string, questionId: string): Promise<{ interview: Interview; question: Question }> {
        const interview = (await this.#app.harness.snapshot(InterviewsDoc, id, context))?.items[callId];

        if (interview === undefined) {
            throw new HttpError(404, "No such interview");
        }

        if (interview.status !== "waiting") {
            throw new HttpError(409, "This interview has ended");
        }

        const question = interview.questions.questions.find((each) => each.id === questionId);

        if (question === undefined || (question.type !== "single" && question.type !== "multi")) {
            throw new HttpError(400, "Helpers are for single and multiple choice questions");
        }

        return { interview, question };
    }

    /** Change the waiting interview, and give it back as it is now. */
    #change(id: ConversationId, callId: string, change: (item: Interview) => void): Promise<Interview> {
        return this.#app.harness.commit(async (tx) => {
            const item = (await tx.doc(InterviewsDoc, id)).items[callId];

            if (item === undefined || item.status !== "waiting") {
                throw new HttpError(409, "This interview has ended");
            }

            change(item);

            return JSON.parse(JSON.stringify(item)) as Interview;
        }, context);
    }

    /** Up to three new options, added to the question: the interview as it is now. */
    async moreOptions(id: ConversationId, callId: string, questionId: string): Promise<Interview> {
        const { interview, question } = await this.#find(id, callId, questionId);
        const have = (question.options ?? []).map(labelOf);

        if (have.length >= MAX_OPTIONS) {
            throw new HttpError(409, `This question has ${MAX_OPTIONS} options already`);
        }

        const reply = await askSessionModel(
            this.#app,
            id,
            [
                "Someone is answering a form. Suggest up to 3 more options for the question below: distinct from the ones it has, as sensible as them, short like them, in the question's language.",
                'Reply with only a JSON array of strings, such as ["First", "Second"].',
                "",
                describeQuestion(interview, question),
            ].join("\n"),
            { maxTokens: 2048 },
        );
        const found = jsonIn(reply.text, "[");
        const known = new Set(have.map((label) => label.toLowerCase()));
        const fresh = (Array.isArray(found) ? found : [])
            .filter((each): each is string => typeof each === "string")
            .map((each) => each.trim().slice(0, 200))
            .filter((each) => each !== "" && !known.has(each.toLowerCase()))
            .filter((each, index, list) => list.findIndex((other) => other.toLowerCase() === each.toLowerCase()) === index)
            .slice(0, Math.min(MAX_NEW_OPTIONS, MAX_OPTIONS - have.length));

        if (fresh.length === 0) {
            throw new HttpError(502, "The model had no new options.");
        }

        return this.#change(id, callId, (item) => {
            const target = item.questions.questions.find((each) => each.id === questionId)!;

            target.options = [...(target.options ?? []), ...fresh];
        });
    }

    /** The question and its options, rewritten for clarity: a proposal, not applied. */
    async review(id: ConversationId, callId: string, questionId: string): Promise<Review> {
        const { interview, question } = await this.#find(id, callId, questionId);
        const reply = await askSessionModel(
            this.#app,
            id,
            [
                "Someone is answering a form. Review the question below: rewrite it and its options so each is clear and the options do not overlap. Keep what they mean and how many there are, unless two say the same; use the question's language.",
                'Reply with only JSON: {"question": "...", "options": ["...", "..."], "why": "one short sentence on what changed"}.',
                "",
                describeQuestion(interview, question),
            ].join("\n"),
            { maxTokens: 2048 },
        );
        const found = jsonIn(reply.text, "{") as Partial<Review>;
        const options = Array.isArray(found.options)
            ? found.options.filter((each): each is string => typeof each === "string" && each.trim() !== "").map((each) => each.trim().slice(0, 200))
            : [];

        if (typeof found.question !== "string" || found.question.trim() === "" || options.length < 2) {
            throw new HttpError(502, "The model's review was not a question with options. Try again.");
        }

        return { question: found.question.trim().slice(0, 1000), options: options.slice(0, MAX_OPTIONS), why: typeof found.why === "string" ? found.why.trim().slice(0, 300) : "" };
    }

    /**
     * Use a review: the question's words and options become the proposal's. Choices for options that are gone are
     * dropped from the draft; the others, and notes on them, stay. Rich options' content goes with them, by position.
     */
    async useReview(id: ConversationId, callId: string, questionId: string, review: unknown): Promise<Interview> {
        const proposal = review as Partial<Review> | null;

        if (
            proposal === null ||
            typeof proposal !== "object" ||
            typeof proposal.question !== "string" ||
            proposal.question.trim() === "" ||
            !Array.isArray(proposal.options) ||
            proposal.options.length < 2 ||
            proposal.options.length > MAX_OPTIONS ||
            !proposal.options.every((each) => typeof each === "string" && each.trim() !== "")
        ) {
            throw new HttpError(400, "A review is a question with at least two options");
        }

        return this.#change(id, callId, (item) => {
            const target = item.questions.questions.find((each) => each.id === questionId);

            if (target === undefined || (target.type !== "single" && target.type !== "multi")) {
                throw new HttpError(400, "Helpers are for single and multiple choice questions");
            }

            const before = target.options ?? [];
            const renamed = new Map(before.map((option, index) => [labelOf(option), proposal.options![index]?.trim()]));

            target.question = proposal.question!.trim();
            target.options = proposal.options!.map((label, index) => {
                const old = before[index];

                return old !== undefined && typeof old !== "string" ? { ...old, label: label.trim() } : label.trim();
            });

            const labels = new Set(target.options.map(labelOf));
            const keep = (choice: { option: string; note?: string }) => {
                const now = renamed.get(choice.option) ?? choice.option;

                return labels.has(now) ? [{ ...choice, option: now }] : [];
            };

            if (target.recommended !== undefined) {
                const picks = (Array.isArray(target.recommended) ? target.recommended : [target.recommended])
                    .map((pick) => renamed.get(pick) ?? pick)
                    .filter((pick) => labels.has(pick));

                if (picks.length === 0) {
                    delete target.recommended;
                } else {
                    target.recommended = Array.isArray(target.recommended) ? picks : picks[0]!;
                }
            }

            item.draft = item.draft.flatMap((response) => {
                if (response.id !== questionId) {
                    return [response];
                }

                const value = response.value;
                const choices = (Array.isArray(value) ? value : [value]).filter(
                    (each): each is { option: string; note?: string } => typeof each === "object" && each !== null && "option" in each,
                );
                const kept = choices.flatMap(keep);

                if (kept.length === 0) {
                    return [];
                }

                return [{ ...response, value: target.type === "multi" ? kept : kept[0]! }];
            });
        });
    }

    /** Ask about one option: the model's answer joins the option's thread, kept with the interview. */
    async ask(id: ConversationId, callId: string, questionId: string, option: string, prompt: string): Promise<Interview> {
        const { interview, question } = await this.#find(id, callId, questionId);
        const asked = prompt.trim().slice(0, MAX_ASK_CHARS);

        if (asked === "") {
            throw new HttpError(400, "Ask something");
        }

        if (!(question.options ?? []).some((each) => labelOf(each) === option)) {
            throw new HttpError(400, "Not one of this question's options");
        }

        const key = `${questionId}\n${option}`;
        const thread = interview.asked?.[key] ?? [];
        const reply = await askSessionModel(
            this.#app,
            id,
            [
                "Someone answering a form asks about one of a question's options. Answer briefly and concretely (a few sentences or a short list, in Markdown), in their language. Say plainly when it depends on something you do not know.",
                "",
                describeQuestion(interview, question),
                "",
                `The option they ask about: ${option}`,
                ...thread.flatMap((turn) => ["", `They asked: ${turn.q}`, `You answered: ${turn.a}`]),
                "",
                `They ask: ${asked}`,
            ].join("\n"),
            { maxTokens: 4096 },
        );

        if (reply.text === "") {
            throw new HttpError(502, "The model gave no answer. Try again.");
        }

        return this.#change(id, callId, (item) => {
            item.asked ??= {};
            item.asked[key] = [...(item.asked[key] ?? []), { q: asked, a: reply.text, at: Date.now() }].slice(-MAX_THREAD);
        });
    }
}
