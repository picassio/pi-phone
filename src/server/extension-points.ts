/**
 * `host.ask` (pi-pocket 0.22.0's extension point, experimental; ported from its `src/server/extension-points.ts`, commit
 * 46d7353): a question for the person Pi works for, on a card in the session, through `Approvals` (it waits, notifies,
 * and shows as an approval does). What they type goes back to the asker alone: the request that tabs see has the
 * fields, never the values, and the answer route checks them (`PocketApp.answerAsk`).
 *
 * pi-pocket's `host.browser` is not ported yet: pi-phone's browser is its own (`browser/pi-browser.ts`).
 */
import type { Context } from "@earendil-works/chord";
import { HttpError } from "./errors.ts";
import type { Approvals, AskAnswer, AskField, AskRequest } from "./host.ts";

/** The most fields on one card, and the longest value each takes. */
export const MAX_ASK_FIELDS = 6;
export const MAX_ASK_VALUE = 4096;
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const AUTOCOMPLETE = /^[a-z][a-z0-9 -]{0,39}$/;

/** One line of text, at most `max` characters: what an extension says on a card. */
function line(value: unknown, what: string, max: number): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > max || /[\r\n]/.test(value)) {
        throw new Error(`host.ask: ${what} is one line of 1 to ${max} characters`);
    }

    return value.trim();
}

export async function ask(approvals: Approvals, request: AskRequest, context: Context): Promise<AskAnswer> {
    const { conversationId, id, taskId, callId } = request ?? ({} as AskRequest);

    if (typeof id !== "string" || id === "" || id.length > 200) {
        throw new Error("host.ask: give it an id, such as `${api.taskId}:${api.callId}`");
    }

    if (conversationId === undefined || taskId === undefined) {
        throw new Error("host.ask: give it the conversationId and the taskId that asks");
    }

    const title = line(request.title, "the title", 120);

    if (request.text !== undefined && (typeof request.text !== "string" || request.text.length > 2000)) {
        throw new Error("host.ask: text is up to 2000 characters");
    }

    const text = request.text?.trim();
    const given = request.fields ?? [];

    if (!Array.isArray(given) || given.length > MAX_ASK_FIELDS) {
        throw new Error(`host.ask: fields is a list of up to ${MAX_ASK_FIELDS}`);
    }

    const fields: AskField[] = given.map((field: AskField) => {
        if (typeof field?.name !== "string" || !FIELD_NAME.test(field.name)) {
            throw new Error("host.ask: a field's name is letters, digits, and _, starting with a letter");
        }

        return {
            name: field.name,
            label: line(field.label, "a field's label", 80),
            ...(field.secret === true ? { secret: true } : {}),
            ...(field.placeholder === undefined ? {} : { placeholder: line(field.placeholder, "a placeholder", 80) }),
            ...(typeof field.autocomplete === "string" && AUTOCOMPLETE.test(field.autocomplete)
                ? { autocomplete: field.autocomplete }
                : {}),
        };
    });

    if (new Set(fields.map((field) => field.name)).size !== fields.length) {
        throw new Error("host.ask: two fields have the same name");
    }

    const submit = request.submit === undefined ? (fields.length === 0 ? "Done" : "Send") : line(request.submit, "submit", 30);
    const answer = await approvals.request(
        {
            id,
            conversationId,
            taskId,
            ...(callId === undefined ? {} : { callId }),
            tool: "ask",
            subject: title,
            reason: text ?? "",
            createdAt: Date.now(),
            form: { type: "ask", title, ...(text ? { text } : {}), fields, submit },
        },
        context,
    );

    if (!answer.allow) {
        return Object.freeze({ answered: false, by: answer.by });
    }

    return Object.freeze({ answered: true, by: answer.by, values: Object.freeze({ ...(answer.values ?? {}) }) });
}

/**
 * What a person typed on an ask's card, checked against its fields: each one there, as text of up to `MAX_ASK_VALUE`
 * characters, and nothing else. An error (400) says what is wrong, never a value.
 */
export function checkValues(fields: readonly AskField[], values: unknown): Record<string, string> {
    if (typeof values !== "object" || values === null || Array.isArray(values)) {
        if (fields.length === 0 && (values === undefined || values === null)) {
            return {};
        }

        throw new HttpError(400, "Fill in the fields.");
    }

    const out: Record<string, string> = {};

    for (const field of fields) {
        const value = (values as Record<string, unknown>)[field.name];

        if (typeof value !== "string" || value === "") {
            throw new HttpError(400, `Fill in ${field.label}.`);
        }

        if (value.length > MAX_ASK_VALUE) {
            throw new HttpError(400, `${field.label} is too long.`);
        }

        out[field.name] = value;
    }

    if (Object.keys(values).some((key) => !fields.some((field) => field.name === key))) {
        throw new HttpError(400, "That is not a field of this card.");
    }

    return out;
}
