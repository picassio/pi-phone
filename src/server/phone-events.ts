/**
 * What the app's background service tells the owner when the app is not in front (DESIGN.md section 4): a session's
 * run ended, failed, or waits for an approval. PiService long-polls `GET /api/phone/events?after=<seq>` with the owner
 * token and posts a notification for each; tapping one opens that session. Kept in memory, the last `KEPT` only: a
 * service that was away for longer gets what is left, and `after=-1` starts at now without the past.
 *
 * Sessions only (the app's list), not subagents: their parent's run says when the work is done.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Translate } from "./i18n.ts";

/** An English sentence with `{name}` placeholders, and their values: said in the owner's language when sent (PP-85). */
export type Said = { text: string; vars?: Record<string, string | number> };

/** A sentence to say in the owner's language: `scripts/i18n-check.ts` finds it, as it finds a `t` call's. */
export const said = (text: string, vars?: Record<string, string | number>): Said => (vars === undefined ? { text } : { text, vars });

export type PhoneEvent = {
    seq: number;
    /**
     * `security`: about the owner's sign-in (a recovery code was used); `session` is 0, and it opens the app. `limit`: a
     * run began to wait 10 minutes or more for a provider's limit (`limit-gate.ts`), once for the wait.
     */
    kind: "done" | "failed" | "approval" | "security" | "limit";
    session: number;
    /** The session's title (data), or for `security` what happened. */
    title: string;
    /** What to say, in English: Pi's last words (data), or the app's own sentence. */
    text: string;
    /** The app's own words of `title` and `text`, to say in a language; without them, they are said as they are. */
    say?: { title?: Said; text?: Said };
    at: number;
};

/** An event as the phone shows it: its heading and text in a language (`t`), the heading saying what happened. */
export function inLanguage(event: PhoneEvent, t: Translate): PhoneEvent & { heading: string } {
    const title = event.say?.title === undefined ? event.title : t(event.say.title.text, event.say.title.vars);
    const text = event.say?.text === undefined ? event.text : t(event.say.text.text, event.say.text.vars);
    const heading =
        event.kind === "security"
            ? title
            : event.kind === "approval"
              ? t("Waiting for you: {title}", { title })
              : event.kind === "limit"
                ? t("Waiting for a limit: {title}", { title })
                : event.kind === "failed"
                  ? t("Failed: {title}", { title })
                  : t("Done: {title}", { title });

    return { ...event, title, text, heading };
}

const KEPT = 100;
/** How long a poll waits for an event before it answers with none. */
export const POLL_MS = 50_000;

export class PhoneEvents {
    #seq = 0;
    readonly #events: PhoneEvent[] = [];
    readonly #waiting = new Set<() => void>();
    /** Who hears every event as it happens (the Projects extension: a task session's run ended). */
    readonly #listeners = new Set<(event: Omit<PhoneEvent, "seq" | "at">) => void>();
    /** Sessions whose ends the phone does not hear (task and main sessions: the board says it); approvals it always does. */
    readonly #quiet = new Set<(session: number) => boolean>();
    /** Who hears what the phone is told, after the quiet rules: push notifications for the web UI (PP-127). */
    readonly #posted = new Set<(event: PhoneEvent) => void>();

    /** Hear each event the phone is told (not the quiet ones), as it is; returns how to stop. */
    onPosted(listener: (event: PhoneEvent) => void): () => void {
        this.#posted.add(listener);

        return () => this.#posted.delete(listener);
    }

    /** Hear every event, quiet or not; returns how to stop. */
    subscribe(listener: (event: Omit<PhoneEvent, "seq" | "at">) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    /** Keep the ends of the sessions `test` names from the phone (not their approvals); returns how to stop. */
    quiet(test: (session: number) => boolean): () => void {
        this.#quiet.add(test);

        return () => this.#quiet.delete(test);
    }

    add(event: Omit<PhoneEvent, "seq" | "at">): void {
        for (const listener of this.#listeners) {
            try {
                listener(event);
            } catch {
                // A listener's trouble is its own: the phone still hears.
            }
        }

        if (event.kind === "done" && [...this.#quiet].some((test) => test(event.session))) {
            return;
        }

        const posted = { ...event, seq: ++this.#seq, at: Date.now() };

        this.#events.push(posted);

        if (this.#events.length > KEPT) {
            this.#events.shift();
        }

        for (const listener of this.#posted) {
            try {
                listener(posted);
            } catch {
                // A listener's trouble is its own: the phone still hears.
            }
        }

        for (const wake of [...this.#waiting]) {
            wake();
        }
    }

    /** Events after `after`, waiting up to `POLL_MS` for one; with `after` -1, none, and the sequence now. */
    async after(after: number, signal: AbortSignal): Promise<{ seq: number; events: PhoneEvent[] }> {
        if (after < 0) {
            return { seq: this.#seq, events: [] };
        }

        if (this.#seq <= after) {
            await new Promise<void>((resolve) => {
                const wake = () => {
                    clearTimeout(timer);
                    this.#waiting.delete(wake);
                    resolve();
                };
                const timer = setTimeout(wake, POLL_MS);

                this.#waiting.add(wake);
                signal.addEventListener("abort", wake, { once: true });
            });
        }

        return { seq: this.#seq, events: this.#events.filter((event) => event.seq > after) };
    }

    /** For notifications: a session's id as the app's routes have it. */
    static session(id: ConversationId): number {
        return Number(id);
    }
}
