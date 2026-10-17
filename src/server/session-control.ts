/**
 * Sessions controlling other sessions (DESIGN.md section 4), the part of pi-pocket's PiP that stays: Pi in one
 * session lists the others, reads one, starts one, sends one a message, waits for its run to end, stops it, and sees
 * the calls waiting for approval there and denies them (never allows: that stays a person's). To test the app in a
 * session of its own, or to help its person look after the others.
 *
 * Every action is the person's whose message led to the calling session's work (`requesterOf`), with exactly their
 * rights: the checks are the ones their own requests meet. A session does not message or stop itself (its root, for a
 * subagent). Messages say where they come from (`[via session #N "title"]`), and at most `SENDS_PER_HOUR` messages and
 * starts leave a session in an hour, so two sessions messaging each other cannot spend without end. What a tool reads
 * from another session is data, fenced as such (`fence.ts`).
 */
import type { ConversationId } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { HttpError } from "./errors.ts";
import { clip, defang, quoted } from "./fence.ts";

const context = BACKGROUND_CONTEXT;

const SENDS_PER_HOUR = 30;
/** The longest a wait for a run lasts. */
export const MAX_WAIT_MS = 30 * 60_000;
/** A run that has not started this long after a wait began is taken as not coming: the session is idle. */
const START_GRACE_MS = 5_000;
export const READ_OPEN = "<session-transcript>";
export const READ_CLOSE = "</session-transcript>";

/** A session as the tools list it. */
export type SessionLine = {
    id: number;
    title: string;
    state: "working" | "waiting for approval" | "failed" | "idle";
    folder: string;
    model?: string;
    archived: boolean;
    updatedAt: number;
};

function textOf(message: Message): string {
    if (typeof message.content === "string") {
        return message.content;
    }

    return message.content
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n");
}

/** One message of a transcript, in a line or a few, cut to what a look needs. */
function messageLine(message: Message): string {
    if (message.role === "user") {
        return `person: ${clip(textOf(message), 1500)}`;
    }

    if (message.role === "assistant") {
        const calls = message.content.flatMap((part) =>
            part.type === "toolCall" ? [`${part.name}(${clip(JSON.stringify(part.arguments), 200)})`] : [],
        );
        const text = clip(textOf(message), 2000);

        return `pi: ${text}${calls.length === 0 ? "" : `${text === "" ? "" : "\n"}[calls ${calls.join(", ")}]`}`;
    }

    if (message.role === "toolResult") {
        return `result of ${message.toolName}${message.isError ? " (error)" : ""}: ${clip(textOf(message), 600)}`;
    }

    return "";
}

export class SessionControl {
    readonly #app: PocketApp;
    /** When each session sent or started something, for the hourly limit. */
    readonly #sent = new Map<number, number[]>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** The person the calling session works for now, and the session it is part of. */
    #caller(caller: ConversationId): { user: User; root: ConversationId } {
        const userId = this.#app.attribution.requesterOf(caller);
        const user = userId === undefined ? undefined : this.#app.config.userById(userId);

        if (user === undefined) {
            throw new Error("Nobody asked for this work, so there is nobody to act for in other sessions.");
        }

        return { user, root: this.#app.rootOf(caller) };
    }

    #target(caller: ConversationId, id: number, acting: boolean): { user: User; root: ConversationId; target: ConversationId } {
        const { user, root } = this.#caller(caller);
        const target = id as unknown as ConversationId;

        if (this.#app.sessionMeta(target) === undefined) {
            throw new Error(`There is no session #${id}.`);
        }

        this.#app.requireSee(user, target);

        if (acting && target === root) {
            throw new Error("That is this session: act here instead.");
        }

        return { user, root, target };
    }

    /** Count a message or start against the hourly limit, or refuse it. */
    #spend(root: ConversationId): void {
        const now = Date.now();
        const recent = (this.#sent.get(Number(root)) ?? []).filter((at) => now - at < 3_600_000);

        if (recent.length >= SENDS_PER_HOUR) {
            throw new Error(`This session sent or started ${SENDS_PER_HOUR} times in the last hour: that is the most. Ask your person before more.`);
        }

        recent.push(now);
        this.#sent.set(Number(root), recent);
    }

    #via(root: ConversationId): string {
        return `session #${String(root)} ${quoted(this.#app.sessionMeta(root)?.title ?? "", 60)}`;
    }

    #line(item: ReturnType<PocketApp["sessions"]>[number]): SessionLine {
        const failed = (item as { failed?: boolean }).failed === true;

        return {
            id: item.id,
            title: item.title ?? "New session",
            state: item.waiting ? "waiting for approval" : item.busy ? "working" : failed ? "failed" : "idle",
            folder: item.cwd,
            ...(item.model === undefined ? {} : { model: item.model }),
            archived: item.archived === true,
            updatedAt: item.updatedAt,
        };
    }

    list(caller: ConversationId, query = "", archived = false): SessionLine[] {
        const { user } = this.#caller(caller);
        const needle = query.trim().toLowerCase();

        return this.#app
            .sessions(user)
            .filter((item) => (item.archived === true) === archived)
            .filter((item) => needle === "" || `${item.title ?? ""}\n${item.cwd}`.toLowerCase().includes(needle))
            .map((item) => this.#line(item));
    }

    /** A session's state now, in a line. */
    status(caller: ConversationId, id: number): string {
        const { user } = this.#target(caller, id, false);
        const item = this.#app.sessions(user).find((each) => each.id === id);

        if (item === undefined) {
            throw new Error(`There is no session #${id}.`);
        }

        const line = this.#line(item);

        return `#${line.id} ${quoted(line.title)} · ${line.state} · ${line.folder}${line.model === undefined ? "" : ` · ${line.model}`}`;
    }

    /** The end of a session's conversation as its model has it, fenced as data. */
    async read(caller: ConversationId, id: number, count = 30): Promise<string> {
        const { target } = this.#target(caller, id, false);
        const view = await (await this.#app.harness.conversation(target, context))!.context(context);
        const lines = view.messages
            .filter((message) => message.role !== "system")
            .slice(-Math.max(1, Math.min(200, count)))
            .map(messageLine)
            .filter((line) => line !== "");
        const waiting = this.#app.approvals
            .all()
            .filter((request) => this.#app.rootOf(request.conversationId) === target)
            .map((request) => `waiting for approval: ${request.id} ${request.tool} ${quoted(request.subject, 200)}`);

        return [
            this.status(caller, id),
            ...waiting,
            READ_OPEN,
            defang(lines.join("\n\n")),
            READ_CLOSE,
        ].join("\n");
    }

    async start(
        caller: ConversationId,
        request: { cwd: string; message: string; title?: string; key: string },
    ): Promise<{ id: number }> {
        const { user, root } = this.#caller(caller);

        this.#spend(root);
        const { id } = await this.#app.commands.createSession(user, {
            cwd: request.cwd,
            ...(request.title === undefined ? {} : { title: request.title }),
        });

        await this.#app.commands.submit(id, user, { text: request.message, requestId: request.key }, this.#via(root));

        return { id: Number(id) };
    }

    async send(caller: ConversationId, id: number, message: string, now: boolean, key: string): Promise<void> {
        const { user, root, target } = this.#target(caller, id, true);

        this.#spend(root);
        await this.#app.commands.submit(
            target,
            user,
            { text: message, requestId: key, mode: now ? "steer" : "followUp" },
            this.#via(root),
        );
    }

    async stop(caller: ConversationId, id: number): Promise<void> {
        const { user, target } = this.#target(caller, id, true);

        await this.#app.commands.abort(target, user);
    }

    /**
     * Wait until the session's run ends (or, when none starts within a few seconds, that it is idle), up to `timeoutMs`;
     * answers its state then and its last answer.
     */
    async wait(caller: ConversationId, id: number, timeoutMs: number, signal: AbortSignal): Promise<string> {
        const { target } = this.#target(caller, id, false);
        const since = Date.now();
        const until = since + Math.min(MAX_WAIT_MS, Math.max(1000, timeoutMs));
        let ended = false;

        while (!signal.aborted && Date.now() < until) {
            const busy = this.#app.isBusy(target);

            if (!busy && ((this.#app.endedAt(target) ?? 0) >= since || Date.now() - since > START_GRACE_MS)) {
                ended = true;
                break;
            }

            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        signal.throwIfAborted();
        const view = await (await this.#app.harness.conversation(target, context))!.context(context);
        const answer = view.messages.findLast((message) => message.role === "assistant");

        return [
            ended ? "Its run ended." : `Still working after ${Math.round((Date.now() - since) / 1000)} s.`,
            this.status(caller, id),
            ...(answer === undefined ? [] : [READ_OPEN, defang(messageLine(answer)), READ_CLOSE]),
        ].join("\n");
    }

    /** The calls waiting for approval in the sessions the person sees. */
    approvals(caller: ConversationId): string[] {
        const { user } = this.#caller(caller);

        return this.#app.approvals
            .all()
            .filter((request) => this.#app.canSee(user, this.#app.rootOf(request.conversationId)))
            .map(
                (request) =>
                    `${request.id}: session #${String(this.#app.rootOf(request.conversationId))} · ${request.tool} ${quoted(request.subject, 200)} · ${quoted(request.reason, 200)}`,
            );
    }

    async deny(caller: ConversationId, approvalId: string): Promise<void> {
        const { user } = this.#caller(caller);

        try {
            if (!(await this.#app.answerApproval(approvalId, false, user))) {
                throw new Error(`No call waits as ${approvalId}.`);
            }
        } catch (error) {
            throw new Error(error instanceof HttpError ? error.message : String(error));
        }
    }
}
