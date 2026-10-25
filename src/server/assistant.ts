/**
 * pi-phone as the phone's assistant (PP-146): what the side key's sheet does, as the owner set it in Settings ›
 * Assistant. The sheet itself is the web app's (`web/assist.js`, opened by `PiAssistantSession.java`); these are the
 * choices it reads from the server's state, and Pi changes through the settings tools (`assistant.*`).
 *
 * - `opens`: where the words go: the last session the owner was in (on this phone), a new session in `folder` (made
 *   when the words are sent, not when the sheet opens), or always `session`.
 * - `send`: "tap": the words wait for Send; "auto": they go by themselves 3 seconds after the person stops speaking.
 * - `from`: the message notes the app that was in front ("From Chrome"), so Pi can offer phone control for it.
 */
import { HttpError } from "./errors.ts";

export type AssistantOpens = "last" | "new" | "session";
export type AssistantSend = "tap" | "auto";

export interface AssistantSettings {
    readonly opens: AssistantOpens;
    /** The folder a new session starts in; null: the app's default folder (`defaultCwd`). */
    readonly folder: string | null;
    /** The session `opens: "session"` sends to; null until one is picked. */
    readonly session: number | null;
    readonly send: AssistantSend;
    readonly from: boolean;
}

export const DEFAULT_ASSISTANT: AssistantSettings = { opens: "last", folder: null, session: null, send: "tap", from: true };

const OPENS: readonly AssistantOpens[] = ["last", "new", "session"];
const SENDS: readonly AssistantSend[] = ["tap", "auto"];
const KEYS = ["opens", "folder", "session", "send", "from"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The settings as kept (only what differs from the defaults is stored), with the defaults filled in. What does not
 * parse is left at its default: the file is the app's, written only through `withAssistant`.
 */
export function readAssistant(stored: unknown): AssistantSettings {
    if (!isRecord(stored)) {
        return DEFAULT_ASSISTANT;
    }

    return {
        opens: OPENS.includes(stored.opens as AssistantOpens) ? (stored.opens as AssistantOpens) : DEFAULT_ASSISTANT.opens,
        folder: typeof stored.folder === "string" && stored.folder !== "" ? stored.folder : null,
        session: typeof stored.session === "number" && Number.isInteger(stored.session) && stored.session > 0 ? stored.session : null,
        send: SENDS.includes(stored.send as AssistantSend) ? (stored.send as AssistantSend) : DEFAULT_ASSISTANT.send,
        from: typeof stored.from === "boolean" ? stored.from : DEFAULT_ASSISTANT.from,
    };
}

/**
 * `current` with `patch` applied, checked: a patch names only known keys, each with a value it may take. `opens:
 * "session"` needs a session, given in the same patch or already set.
 */
export function withAssistant(current: AssistantSettings, patch: unknown): AssistantSettings {
    if (!isRecord(patch)) {
        throw new HttpError(400, "assistant is an object of the settings to change.");
    }

    for (const key of Object.keys(patch)) {
        if (!(KEYS as readonly string[]).includes(key)) {
            throw new HttpError(400, `assistant has no setting "${key}".`);
        }
    }

    const next = { ...current };

    if (patch.opens !== undefined) {
        if (!OPENS.includes(patch.opens as AssistantOpens)) {
            throw new HttpError(400, "assistant.opens is last, new, or session.");
        }

        next.opens = patch.opens as AssistantOpens;
    }

    if (patch.folder !== undefined) {
        if (patch.folder !== null && (typeof patch.folder !== "string" || patch.folder.trim() === "")) {
            throw new HttpError(400, "assistant.folder is a folder, or null for the default folder.");
        }

        next.folder = patch.folder === null ? null : patch.folder.trim();
    }

    if (patch.session !== undefined) {
        if (patch.session !== null && !(typeof patch.session === "number" && Number.isInteger(patch.session) && patch.session > 0)) {
            throw new HttpError(400, "assistant.session is a session's number, or null.");
        }

        next.session = patch.session;
    }

    if (patch.send !== undefined) {
        if (!SENDS.includes(patch.send as AssistantSend)) {
            throw new HttpError(400, "assistant.send is tap or auto.");
        }

        next.send = patch.send as AssistantSend;
    }

    if (patch.from !== undefined) {
        if (typeof patch.from !== "boolean") {
            throw new HttpError(400, "assistant.from is true or false.");
        }

        next.from = patch.from;
    }

    if (next.opens === "session" && next.session === null) {
        throw new HttpError(400, "Pick the session the assistant opens (assistant.session).");
    }

    return next;
}

/** What is kept: only the settings that differ from the defaults; undefined when none do. */
export function storedAssistant(settings: AssistantSettings): Partial<AssistantSettings> | undefined {
    const kept: Partial<Record<keyof AssistantSettings, unknown>> = {};

    for (const key of KEYS) {
        if (settings[key] !== DEFAULT_ASSISTANT[key]) {
            kept[key] = settings[key];
        }
    }

    return Object.keys(kept).length === 0 ? undefined : (kept as Partial<AssistantSettings>);
}

/**
 * For Pi, in sessions on the phone: what a message from the side key's sheet is, and what it may lead to. The sheet starts
 * one with `(From Chrome · com.android.chrome)` when it says the app in front (`web/assist.js`).
 */
export const ASSISTANT_PROMPT =
    "Messages from the phone's assistant: the owner can hold the side key in any app and speak to you; such a message may start with (From <app> · <package>), the app that was in front. Answer briefly, as speech-to-text can mishear. When helping needs that app, offer phone control for it (phone_control start with that app); the owner approves on a card in the same sheet.";
