/**
 * Session titles. A session is named after its first message at once; when that message is long, or is a command (a
 * skill or prompt template), the session's own model writes a short title in its place, unless someone
 * renamed the session first. Never another model picked on the side, such as a cheaper one of the same provider: nobody
 * chose that one, and it may cost what nobody agreed to. A reply that is no title (the model thinking aloud, or cut off)
 * leaves the first one. What it costs counts as the session's spend, like Pi's own requests (`side-model.ts`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { SessionsDoc } from "./docs.ts";
import { describe } from "./errors.ts";
import { askSessionModel } from "./side-model.ts";

const context = BACKGROUND_CONTEXT;

/** First messages this long or longer get a written title; shorter ones are a title already. */
const LONG_WORDS = 9;
const MAX_TITLE = 60;
/**
 * More words than this is no title but prose, such as a model thinking aloud. The model is asked for 3 to 6 words, but
 * some languages put spaces between syllables (Vietnamese), and some models are wordy.
 */
const MAX_WORDS = 15;
/**
 * Reasoning some servers send at the start of the reply's text: a block in tags, or one whose closing tag never came.
 * Such tags further on are the title's own words ("Use <think> tags in prompts").
 */
const REASONING = /^\s*<(think|thinking|reasoning)>[\s\S]*?(<\/\1>|$)/i;
/** Reasoning whose opening tag the server left out: up to a closing tag that ends its line, as such reasoning's does. */
const REASONING_END = /^[\s\S]*?<\/(think|thinking|reasoning)>[^\S\n]*(\n|$)/i;
/** How much of the first message the model reads. */
const READ_CHARS = 3000;

/** What the model is asked, before the first message. */
export const TITLE_PROMPT =
    "You name chat sessions. Reply with only a title of 3 to 6 words for a session that starts with the message below: plain words, no quotes, no punctuation at the end, in the message's language.";

/** Whether the title a first message gives is worth replacing: it is long, or more than one line. */
export function wantsTitle(text: string): boolean {
    const words = text.trim().split(/\s+/).length;

    return words >= LONG_WORDS || text.trim().includes("\n");
}

/**
 * A model's reply as a title: its first line, without quotes or a label, and not too long. Undefined when that is
 * empty, or is a sentence rather than a title, as when a model thinks aloud in its reply. Reasoning at its start, in
 * `<think>` tags (or `<thinking>`, `<reasoning>`) as some servers send it, is left out.
 */
export function cleanTitle(reply: string): string | undefined {
    const line = reply
        .replace(REASONING, "")
        .replace(REASONING_END, "")
        .trim()
        .split("\n")[0]!
        .replace(/^(title|session title)\s*:\s*/i, "")
        .replace(/^["'“‘*#\s]+|["'”’*\s.!?:;,]+$/g, "")
        .trim();

    if (line === "" || line.split(/\s+/).length > MAX_WORDS) {
        return undefined;
    }

    return line.length > MAX_TITLE ? `${line.slice(0, MAX_TITLE - 1).trimEnd()}…` : line;
}


/**
 * Ask for a title for a session whose first message is `text`, and use it if the session still has the title that
 * message gave it (`provisional`). Failures, and replies that are no title or were cut off, only leave that title in
 * place.
 */
export async function writeTitle(
    app: PocketApp,
    id: ConversationId,
    text: string,
    provisional: string,
): Promise<void> {
    try {
        if (app.spend.heldBack(id) !== undefined) {
            return;
        }

        if ((await app.agentState(id))?.model === undefined) {
            return;
        }

        const reply = await askSessionModel(app, id, `${TITLE_PROMPT}\n\n<message>\n${text.slice(0, READ_CHARS)}\n</message>`, {
            maxTokens: 1024,
        });
        const title = cleanTitle(reply.text);

        await app.harness.commit(async (tx) => {
            // Only a reply that ended by itself: one cut off at the token limit is a model that went on, not a title.
            if (title === undefined || reply.stopReason !== "stop") {
                return;
            }

            const meta = (await tx.doc(SessionsDoc)).items[String(id)];

            if (meta !== undefined && meta.title === provisional) {
                meta.title = title;
            }
        }, context);
    } catch (error) {
        app.log(`no title for session ${String(id)}: ${describe(error)}`);
    }
}
