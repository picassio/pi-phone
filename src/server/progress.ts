/**
 * The progress board (PP-283, GitHub issue #5): what Pi does in every session, for the phone to show while another app
 * is in front: the app's always-on notification, and the floating bubble when the owner turns it on. One row per
 * session or subagent that works or waits for the owner, what it does now in a few words, and since when; the title
 * counts them, with the sessions done in the last hour.
 *
 * The phone's service long-polls it (`GET /api/phone/progress?after=<version>`): a new version whenever the board, as
 * said in a language, changes. It is read again every `TICK_MS` while a poll waits, so a run's steps show within that.
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ApprovalRequest } from "./host.ts";
import type { Translate } from "./i18n.ts";
import type { PeekLine } from "./projection.ts";

/** How often a waiting poll reads the board again. */
export const TICK_MS = 1_500;
/** How long a poll waits for a change before it answers with the board as it is. */
export const PROGRESS_POLL_MS = 50_000;
/** Rows the board lists at most; the rest are counted. */
export const MAX_ROWS = 5;
/** Sessions done within this long count in the title. */
const DONE_WINDOW_MS = 60 * 60 * 1000;

export type ProgressRow = {
    /** The session to open (a subagent's root session). */
    session: number;
    conversationId: number;
    /** The session's title; a subagent's is "session · name". */
    title: string;
    state: "working" | "waiting";
    /** What it does now, in a few words. */
    doing: string;
    /** Since when it works, or waits. */
    since: number;
    /** What waits for the owner, when it waits; `simple` when Approve and Deny answer it (no form to fill). */
    approval?: { id: string; simple: boolean };
};

export type ProgressBoard = {
    version: number;
    /** The title: "3 working · 1 waits for you · 2 done", or that Pi is idle. */
    heading: string;
    working: number;
    waiting: number;
    done: number;
    rows: ProgressRow[];
    /** Rows past `MAX_ROWS`. */
    more: number;
};

/** What the board is read from: the app's runs, approvals, titles, peeks, and ends. */
export type ProgressSource = {
    /** Conversations with a run going. */
    busy(): readonly ConversationId[];
    approvals(): readonly ApprovalRequest[];
    /** A session's title, or a subagent's "session · name"; undefined for a conversation the board leaves out. */
    title(id: ConversationId): string | undefined;
    /** The session a conversation belongs to. */
    rootOf(id: ConversationId): ConversationId;
    /** When its run began. */
    since(id: ConversationId): number | undefined;
    /** Its newest steps, as a peek tile shows them; undefined when they cannot be read now. */
    peek(id: ConversationId): Promise<readonly PeekLine[] | undefined>;
    /** How many sessions ended their run since `at`. */
    doneSince(at: number): number;
    now(): number;
};

/** A value of a call's arguments that says what it works on: a path, a command, an address, a query, or a name. */
function what(args: Record<string, string | number | boolean>): string {
    for (const key of ["path", "file_path", "command", "url", "query", "name", "app", "action"]) {
        const value = args[key];

        if (typeof value === "string" && value.trim() !== "") {
            return value;
        }
    }

    return "";
}

const short = (text: string, max = 70) => {
    const flat = text.replace(/\s+/g, " ").trim();

    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** What a step says it does, in a few words, in a language. */
export function doingText(line: PeekLine | undefined, t: Translate): string {
    if (line === undefined) {
        return t("working");
    }

    if (line.kind === "shell") {
        return t("running {what}", { what: short(line.command) });
    }

    if (line.kind === "text") {
        return short(line.text);
    }

    if (line.kind === "limit") {
        return t("waiting for its provider's limit");
    }

    if (line.kind !== "tool" || line.status !== "running") {
        return t("thinking");
    }

    const subject = short(what(line.args));

    switch (line.name) {
        case "read":
            return t("reading {what}", { what: subject });
        case "edit":
        case "write":
            return t("editing {what}", { what: subject });
        case "bash":
            return t("running {what}", { what: subject });
        case "subagent":
            return t("waiting for its subagents");
        case "web_search":
        case "fetch_content":
            return t("reading the web: {what}", { what: subject });
        default:
            return subject === "" ? line.name : `${line.name} ${subject}`;
    }
}

export class Progress {
    readonly #source: ProgressSource;
    #version = 0;
    /** The board as last said, by language, to tell a change. */
    readonly #said = new Map<string, string>();

    constructor(source: ProgressSource) {
        this.#source = source;
    }

    /** The board now, in `language`'s words (`t`): a new version when it changed since it was last said so. */
    async board(t: Translate, language: string): Promise<ProgressBoard> {
        const source = this.#source;
        const now = source.now();
        const approvals = source.approvals();
        const waitingFor = new Map<ConversationId, ApprovalRequest>();

        for (const request of approvals) {
            if (!waitingFor.has(request.conversationId)) {
                waitingFor.set(request.conversationId, request);
            }
        }

        const ids = [...new Set([...source.busy(), ...waitingFor.keys()])];
        const rows: ProgressRow[] = [];

        for (const id of ids) {
            const title = source.title(id);

            if (title === undefined) {
                continue;
            }

            const request = waitingFor.get(id);

            if (request !== undefined) {
                rows.push({
                    session: Number(source.rootOf(id)),
                    conversationId: Number(id),
                    title,
                    state: "waiting",
                    doing: t("waits: {what}", { what: short(`${request.tool} ${request.subject}`) }),
                    since: request.createdAt,
                    approval: { id: request.id, simple: request.form === undefined },
                });

                continue;
            }

            const lines = await source.peek(id);

            rows.push({
                session: Number(source.rootOf(id)),
                conversationId: Number(id),
                title,
                state: "working",
                doing: doingText(lines?.at(-1), t),
                since: source.since(id) ?? now,
            });
        }

        // What waits for the owner first, then the longest at work.
        rows.sort((a, b) => (a.state === b.state ? a.since - b.since : a.state === "waiting" ? -1 : 1));

        const working = rows.filter((row) => row.state === "working").length;
        const waiting = rows.length - working;
        const done = source.doneSince(now - DONE_WINDOW_MS);
        const parts = [
            ...(working === 0 ? [] : [t("{n} working", { n: working })]),
            ...(waiting === 0 ? [] : [t("{n} waits for you", { n: waiting })]),
            ...(done === 0 ? [] : [t("{n} done", { n: done })]),
        ];
        const board = {
            heading: working + waiting === 0 ? (done === 0 ? t("Pi is idle") : `${t("Pi is idle")} · ${parts.join(" · ")}`) : parts.join(" · "),
            working,
            waiting,
            done,
            rows: rows.slice(0, MAX_ROWS),
            more: Math.max(0, rows.length - MAX_ROWS),
        };
        // What it says, without the times that tick: a run's minutes going by are no change to send.
        const said = JSON.stringify({ ...board, rows: board.rows.map(({ since: _since, ...rest }) => rest) });

        if (this.#said.get(language) !== said) {
            this.#said.set(language, said);
            this.#version += 1;
        }

        return { version: this.#version, ...board };
    }

    /**
     * The board once it differs from version `after` (-1: at once), read again every `TICK_MS` and waiting up to
     * `PROGRESS_POLL_MS`; then as it is.
     */
    async after(after: number, t: Translate, language: string, signal: AbortSignal, waitMs = PROGRESS_POLL_MS): Promise<ProgressBoard> {
        const until = this.#source.now() + waitMs;
        let board = await this.board(t, language);

        // A version past this server's (the phone polled a server before this one) is answered at once too.
        while (board.version === after && this.#source.now() < until && !signal.aborted) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, TICK_MS);

                signal.addEventListener("abort", () => {
                    clearTimeout(timer);
                    resolve();
                }, { once: true });
            });
            board = await this.board(t, language);
        }

        return board;
    }
}
