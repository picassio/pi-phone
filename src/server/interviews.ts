/**
 * Interviews: a form of questions Pi asks a person, answered in the app (`extensions/interview.ts`, the Interview sheet).
 * The question format, its checks, and how answers read back to Pi are pi-interview's (MIT, nicobailon/pi-interview-tool,
 * `schema.ts` and `index.ts`), so prompts written for it work here; what it shows them in is the app's own.
 *
 * One conversation document holds each interview by its tool call: the questions, the person's draft as they go, and
 * how it ended. The call waits for the person as an approval does (`Approvals`, with `form: { type: "interview" }`),
 * and after a restart it finds an answer given while it was away.
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

export type ContentBlock = {
    source: string;
    lang?: string;
    file?: string;
    title?: string;
    showSource?: boolean;
    lines?: string;
    highlights?: number[];
};

export type RichOption = { label: string; content?: ContentBlock; recommended?: boolean; conviction?: "strong" | "slight" };
export type OptionValue = string | RichOption;

export type MediaBlock = {
    type: "image" | "chart" | "mermaid" | "table" | "html";
    src?: string;
    alt?: string;
    chart?: { type: string; data: Record<string, JsonValue>; options?: Record<string, JsonValue> };
    mermaid?: string;
    table?: { headers: string[]; rows: string[][]; highlights?: number[] };
    html?: string;
    caption?: string;
    position?: "above" | "below" | "side";
    maxHeight?: string;
};

export type Question = {
    id: string;
    type: "single" | "multi" | "text" | "image" | "info";
    question: string;
    options?: OptionValue[];
    recommended?: string | string[];
    conviction?: "strong" | "slight";
    weight?: "critical" | "minor";
    context?: string;
    content?: ContentBlock;
    media?: MediaBlock | MediaBlock[];
};

export type QuestionsFile = { title?: string; description?: string; questions: Question[] };

/** A choice, with the note the person added to it. */
export type Choice = { option: string; note?: string };

/** One question's answer: text, a choice or choices, or image paths; with files the person attached to it. */
export type ResponseItem = { id: string; value: string | string[] | Choice | Choice[]; attachments?: string[] };

export type Interview = {
    questions: QuestionsFile;
    /** The answers so far, saved as the person goes. */
    draft: ResponseItem[];
    status: "waiting" | "completed" | "cancelled" | "timeout";
    /** Who finished it, and when. */
    by?: string;
    at?: number;
    createdAt: number;
    /** What the person asked about options, and the model's answers (`interview-helpers.ts`), by "<question id>\n<option>". */
    asked?: Record<string, { q: string; a: string; at: number }[]>;
};

/** Every interview in a conversation, by its tool call's id. */
export const InterviewsDoc = defineDoc<{ items: Record<string, Interview> }>({
    kind: "pocket.interviews",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

const TYPES = new Set(["single", "multi", "text", "image", "info"]);
const MEDIA = new Set(["image", "chart", "mermaid", "table", "html"]);
const MAX_QUESTIONS = 50;

export const labelOf = (option: OptionValue): string => (typeof option === "string" ? option : option.label);

const isObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);

function checkContent(where: string, content: unknown): void {
    if (!isObject(content) || typeof content.source !== "string") {
        throw new Error(`${where}: content needs a "source" string`);
    }
}

function checkMedia(where: string, media: unknown): void {
    for (const block of Array.isArray(media) ? media : [media]) {
        if (!isObject(block) || !MEDIA.has(String(block.type))) {
            throw new Error(`${where}: media type is one of image, chart, mermaid, table, html`);
        }

        if (block.type === "image" && typeof block.src !== "string") {
            throw new Error(`${where}: an image needs "src"`);
        }

        if (block.type === "mermaid" && typeof block.mermaid !== "string") {
            throw new Error(`${where}: a mermaid block needs "mermaid"`);
        }

        if (
            block.type === "table" &&
            (!isObject(block.table) || !Array.isArray(block.table.headers) || !Array.isArray(block.table.rows))
        ) {
            throw new Error(`${where}: a table needs "table": { headers, rows }`);
        }

        if (block.type === "html" && typeof block.html !== "string") {
            throw new Error(`${where}: an html block needs "html"`);
        }

        if (block.type === "chart" && !isObject(block.chart)) {
            throw new Error(`${where}: a chart needs "chart": { type, data }`);
        }
    }
}

/**
 * The questions, checked as pi-interview checks them, with its normalisations: a single-select's one-item
 * recommendation becomes a string, a multi-select's becomes a list, and options marked `recommended` become the
 * question's recommendation.
 */
export function validateQuestions(data: unknown): QuestionsFile {
    if (!isObject(data) || !Array.isArray(data.questions)) {
        throw new Error('The questions are an object with a "questions" list');
    }

    if (data.questions.length === 0 || data.questions.length > MAX_QUESTIONS) {
        throw new Error(`An interview has 1 to ${MAX_QUESTIONS} questions`);
    }

    for (const field of ["title", "description"] as const) {
        if (data[field] !== undefined && typeof data[field] !== "string") {
            throw new Error(`"${field}" is text`);
        }
    }

    const ids = new Set<string>();
    const questions: Question[] = data.questions.map((raw: unknown, index: number) => {
        if (!isObject(raw) || typeof raw.id !== "string" || raw.id === "" || typeof raw.question !== "string") {
            throw new Error(`Question ${index + 1} needs an "id" and a "question"`);
        }

        const where = `Question "${raw.id}"`;

        if (ids.has(raw.id)) {
            throw new Error(`Duplicate question id: "${raw.id}"`);
        }

        ids.add(raw.id);

        if (!TYPES.has(String(raw.type))) {
            throw new Error(`${where}: type is one of single, multi, text, image, info`);
        }

        const question = { ...raw } as Question;

        if (question.content !== undefined) {
            checkContent(where, question.content);
        }

        if (question.media !== undefined) {
            checkMedia(where, question.media);
        }

        if (question.weight !== undefined && question.weight !== "critical" && question.weight !== "minor") {
            throw new Error(`${where}: weight is "critical" or "minor"`);
        }

        if (question.type === "single" || question.type === "multi") {
            if (!Array.isArray(question.options) || question.options.length === 0) {
                throw new Error(`${where}: options required for type "${question.type}"`);
            }

            for (const option of question.options) {
                if (typeof option !== "string" && !(isObject(option) && typeof option.label === "string")) {
                    throw new Error(`${where}: an option is text or { label, content? }`);
                }

                if (typeof option !== "string" && option.content !== undefined) {
                    checkContent(`${where}, option "${option.label}"`, option.content);
                }
            }

            // Options marked recommended become the question's recommendation, as in pi-interview.
            const marked = question.options.filter((option) => typeof option !== "string" && option.recommended === true);

            if (marked.length > 0 && question.recommended === undefined) {
                question.recommended = question.type === "single" ? labelOf(marked[0]!) : marked.map(labelOf);
            }
        } else if (question.options !== undefined) {
            throw new Error(`${where}: options not allowed for type "${question.type}"`);
        }

        if (question.conviction !== undefined && question.recommended === undefined) {
            throw new Error(`${where}: conviction requires recommended`);
        }

        if (question.recommended !== undefined) {
            const labels = question.options?.map(labelOf) ?? [];

            if (question.type !== "single" && question.type !== "multi") {
                throw new Error(`${where}: recommended not allowed for type "${question.type}"`);
            }

            if (question.type === "single") {
                if (Array.isArray(question.recommended) && question.recommended.length === 1) {
                    question.recommended = question.recommended[0]!;
                }

                if (typeof question.recommended !== "string") {
                    throw new Error(`${where}: recommended must be string for single-select`);
                }

                if (!labels.includes(question.recommended)) {
                    throw new Error(`${where}: recommended "${question.recommended}" not in options`);
                }
            } else {
                const recommended = Array.isArray(question.recommended) ? question.recommended : [question.recommended];

                for (const each of recommended) {
                    if (!labels.includes(each)) {
                        throw new Error(`${where}: recommended "${each}" not in options`);
                    }
                }

                question.recommended = recommended;
            }
        }

        return question;
    });

    return {
        ...(typeof data.title === "string" ? { title: data.title } : {}),
        ...(typeof data.description === "string" ? { description: data.description } : {}),
        questions,
    };
}

/** The questions from the tool's argument: inline JSON, repaired as pi-interview repairs a model's JSON when it must. */
export function parseQuestions(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch (first) {
        let json = text.trim();
        const fenced = json.match(/^`{3,}(?:json|jsonc)?\s*\n([\s\S]*?)\n\s*`{3,}\s*$/i);

        if (fenced) {
            json = fenced[1]!;
        }

        json = json
            .replace(/^\s*\/\/.*$/gm, "")
            .replace(/,(\s*[}\]])/g, "$1")
            .replace(/\u201C|\u201D/g, '"');

        try {
            return JSON.parse(json);
        } catch {
            throw new Error(`The questions are not valid JSON: ${first instanceof Error ? first.message : String(first)}`);
        }
    }
}

const isChoice = (value: unknown): value is Choice =>
    isObject(value) && typeof value.option === "string";

function valueText(value: ResponseItem["value"]): string {
    const one = (item: string | Choice) => (typeof item === "string" ? item : item.note ? `${item.option} (${item.note})` : item.option);

    return Array.isArray(value) ? (value as (string | Choice)[]).map(one).join(", ") : one(value);
}

function answered(response: ResponseItem | undefined): boolean {
    if (response === undefined) {
        return false;
    }

    const { value } = response;
    const filled = Array.isArray(value)
        ? (value as (string | Choice)[]).some((item) => (typeof item === "string" ? item : item.option).trim() !== "")
        : (isChoice(value) ? value.option : value).trim() !== "";

    return filled || (response.attachments?.length ?? 0) > 0;
}

/** The answers as pi-interview gives them to Pi: a line each, then the same as JSON. "(none)" when there are none. */
export function formatAnswers(responses: readonly ResponseItem[], questions: readonly Question[]): string {
    const byId = new Map(responses.map((response) => [response.id, response]));
    const items = questions.flatMap((question) => {
        const response = byId.get(question.id);

        return answered(response)
            ? [{ question, response: response!, item: { id: question.id, question: question.question, type: question.type, value: response!.value, ...(response!.attachments?.length ? { attachments: [...response!.attachments] } : {}) } }]
            : [];
    });

    if (items.length === 0) {
        return "(none)";
    }

    const lines = items.map(({ question, response }) => {
        const images = Array.isArray(response.value) ? response.value.length : response.value === "" ? 0 : 1;
        const summary =
            question.type === "image"
                ? images === 1
                    ? "1 image attached"
                    : `${images} images attached`
                : valueText(response.value);
        const files = response.attachments?.length ? ` [attachments: ${response.attachments.join(", ")}]` : "";
        const paths = question.type === "image" ? ` [${(Array.isArray(response.value) ? response.value : [response.value]).join(", ")}]` : "";

        return `- ${question.question}: ${summary}${paths}${files}`;
    });

    return `${lines.join("\n")}\n\nStructured response data:\n\n\`\`\`json\n${JSON.stringify(items.map((each) => each.item), null, 2)}\n\`\`\``;
}

/** What Pi is told when an interview ends, in pi-interview's words. */
export function outcomeText(interview: Interview, timeoutSeconds?: number): string {
    const answers = formatAnswers(interview.draft, interview.questions.questions);

    if (interview.status === "completed") {
        return `User completed the interview form.\n\nAnswered responses:\n${answers}`;
    }

    if (interview.status === "timeout") {
        return answers === "(none)"
            ? `Interview form timed out after ${timeoutSeconds} seconds, without answers. Proceed with your best judgment.`
            : `Interview form timed out after ${timeoutSeconds} seconds.\n\nAnswered responses before timeout:\n${answers}\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
    }

    return answers === "(none)"
        ? "User skipped the interview without providing answers. Proceed with your best judgment - use recommended options where specified, make reasonable choices elsewhere. Don't ask for clarification unless absolutely necessary."
        : `User cancelled the interview with partial responses.\n\nAnswered responses:\n${answers}\n\nProceed with these inputs and use your best judgment for unanswered questions.`;
}

/** A draft from the page, checked against the questions: only their ids, with values of their kind. */
export function checkDraft(raw: unknown, questions: readonly Question[]): ResponseItem[] {
    if (!Array.isArray(raw)) {
        throw new Error("The answers are a list");
    }

    const byId = new Map(questions.map((question) => [question.id, question]));
    const strings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");

    return raw.map((item: unknown) => {
        if (!isObject(item) || typeof item.id !== "string" || !byId.has(item.id)) {
            throw new Error("An answer names one of the questions");
        }

        const value = item.value;
        const ok =
            typeof value === "string" ||
            strings(value) ||
            isChoice(value) ||
            (Array.isArray(value) && value.every(isChoice));

        if (!ok) {
            throw new Error(`The answer to "${item.id}" is text, a choice, or a list of them`);
        }

        if (item.attachments !== undefined && !strings(item.attachments)) {
            throw new Error(`The attachments of "${item.id}" are paths`);
        }

        return {
            id: item.id,
            value: value as ResponseItem["value"],
            ...(item.attachments === undefined ? {} : { attachments: item.attachments as string[] }),
        };
    });
}
