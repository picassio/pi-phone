/**
 * Capture (DESIGN.md section 4): what a session learned goes into the wiki, as pi-para's capture does when a pi session
 * ends. Here sessions do not end; they go idle. A session idle for the owner's minutes (`wikiCaptureMinutes`), with
 * messages since its last capture, is captured: its new messages, as pi-para serializes them, under pi-para's own capture
 * prompt, go to the "Wiki capture" session, which runs on the capture model with pi-para's capture instructions and the
 * wiki tools only (`pocket-para-capture`), searching before it writes. Each session's watermark (the last entry captured)
 * means nothing is captured twice; it moves when the capture's run answers. A run that fails moves nothing (PP-408): the
 * owner is told why (a notice, and the Wiki page), and the same messages go again with the session's next capture, which
 * comes once the session has been active again (or from its menu), so a failing capture is not sent again without end.
 *
 * The capture session is a session of its own, archived so the list stays the owner's: they can open it, see what was
 * captured and why, and talk to it. Its spend is the owner's. It runs on pi-para's `models.capture`, or the app's default
 * model when that is "auto"; with neither, nothing is captured and the Wiki page says why.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, defineDoc, type SubmissionId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { SessionsDoc, rebased } from "./docs.ts";
import { describe } from "./errors.ts";
import { generateSummary, serializeSessionForWiki } from "pi-para/summarize";

const context = BACKGROUND_CONTEXT;

/** The extension the capture session runs with, alone (`extensions/para.ts`). */
export const CAPTURE_EXTENSION = "pocket-para-capture";
/** How often sessions are looked at. */
const LOOK_MS = 60_000;
/** Open questions a capture is shown, oldest first. */
const MAX_OPEN_QUESTIONS = 40;
/** The most of a session's new messages one capture reads: its end, where what is new is. */
const MAX_DIGEST = 60_000;

/** Where each session's capture stands, and the capture session. */
export const ParaCaptureDoc = defineDoc<{
    conversation?: number;
    /**
     * Per session: the last entry captured, when it was last looked at, and the capture under way (`sending`: the entry
     * it reaches and its submission in the capture session), kept so a restart still settles it.
     */
    sessions: Record<string, { entry: number; at: number; sending?: { entry: number; submission: number } }>;
    last?: { session: number; at: number };
    /** The newest capture whose run failed, and why. */
    failed?: { session: number; at: number; why: string };
}>({
    kind: "phone.para-capture",
    version: 1,
    ...rebased,
    scope: "session",
    initial: () => ({ sessions: {} }),
});

type Why = { ok: true; model: { provider: string; modelId: string } } | { ok: false; why: string };

export class ParaCapture {
    readonly #app: PocketApp;
    #timer: NodeJS.Timeout | undefined;
    #looking = false;
    /** The captures under way, by session: each settles when its run ends. */
    readonly #settling = new Map<string, Promise<void>>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    start(): void {
        this.#timer = setInterval(() => void this.look(), LOOK_MS);
        this.#timer.unref();
        // Captures sent before a restart: their runs go on, and settle here.
        void this.#state().then(
            (state) => {
                for (const [key, each] of Object.entries(state.sessions)) {
                    if (each.sending !== undefined) {
                        this.#settle(Number(key) as unknown as ConversationId, each.sending.submission as SubmissionId);
                    }
                }
            },
            (error: unknown) => this.#app.log(`wiki capture: the captures under way were not read: ${describe(error)}`),
        );
    }

    /** Resolves once every capture under way has ended (each moved its session's watermark, or told why it failed). */
    async settled(): Promise<void> {
        await Promise.all(this.#settling.values());
    }

    stop(): void {
        clearInterval(this.#timer);
    }

    /** The model captures run on, or why there is none. */
    async model(): Promise<Why> {
        const { config } = await this.#app.para.open();
        const chosen = config.models.capture;

        if (chosen !== "auto") {
            if (chosen.model === undefined || chosen.model === "") {
                return { ok: false, why: "pick a capture model (Wiki settings)" };
            }

            return { ok: true, model: { provider: chosen.provider, modelId: chosen.model } };
        }

        const fallback = this.#app.config.defaultModel;

        return fallback === undefined
            ? { ok: false, why: "pick a capture model (Wiki settings), or a default model for new sessions" }
            : { ok: true, model: { provider: fallback.provider, modelId: fallback.modelId } };
    }

    /** Sessions idle long enough with something new: each is captured. */
    async look(): Promise<void> {
        const minutes = this.#app.config.wikiCaptureMinutes;

        if (minutes === null || this.#looking || !this.#app.loader.extensionNames().includes(CAPTURE_EXTENSION)) {
            return;
        }

        this.#looking = true;

        try {
            const state = await this.#state();

            for (const [key, meta] of Object.entries(this.#app.sessionCatalogue())) {
                const id = Number(key) as unknown as ConversationId;
                const ended = this.#app.endedAt(id);

                if (
                    meta.wikiCapture === true ||
                    meta.pip !== undefined ||
                    meta.archived === true ||
                    ended === undefined ||
                    this.#app.isBusy(id) ||
                    Date.now() - ended < minutes * 60_000 ||
                    (state.sessions[key]?.at ?? 0) >= ended
                ) {
                    continue;
                }

                await this.capture(id).catch((error: unknown) =>
                    this.#app.log(`wiki capture of session ${key} failed: ${describe(error)}`),
                );
                // One at a time: they share the capture session, whose context each one starts afresh.
                await this.settled();
            }
        } finally {
            this.#looking = false;
        }
    }

    /**
     * Capture a session's messages since its last capture now. Answers what happened: the capture session's id, or
     * why nothing went (nothing new, no model).
     */
    async capture(id: ConversationId): Promise<{ sent: boolean; conversation?: number; why?: string }> {
        const app = this.#app;
        const meta = app.sessionMeta(id);

        if (meta === undefined || meta.wikiCapture === true) {
            return { sent: false, why: "only sessions are captured" };
        }

        const model = await this.model();

        if (!model.ok) {
            return { sent: false, why: model.why };
        }

        const state = await this.#state();

        if (state.sessions[String(id)]?.sending !== undefined) {
            return { sent: false, why: "a capture of this session is under way" };
        }

        const since = state.sessions[String(id)]?.entry ?? 0;
        const view = await (await app.harness.conversation(id, context))!.context(context);
        const messages: Message[] = [];
        let last = since;

        view.entries.forEach((entry, index) => {
            if (Number(entry.id) > since) {
                messages.push(...(view.contributions[index] ?? []).filter((message) => message.role !== "system"));
                last = Math.max(last, Number(entry.id));
            }
        });

        if (messages.length === 0) {
            await this.#mark(id, last);

            return { sent: false, why: "nothing new since the last capture" };
        }

        const scope = await app.para.scope(app.cwdOf(id));
        const serialized = serializeSessionForWiki(messages);
        const digest = serialized.length > MAX_DIGEST ? `…(earlier messages left out)\n${serialized.slice(-MAX_DIGEST)}` : serialized;
        // Every open question in the wiki, not only this scope's: a session can answer one asked anywhere.
        const open = await app.para.openQuestionsText(MAX_OPEN_QUESTIONS);
        const text = [
            generateSummary(digest, { mode: "session", scope }),
            "",
            `Session file: pi-phone session #${String(id)} "${meta.title ?? "New session"}" (cite it as pi-phone:session/${String(id)})`,
            `Project scope: ${scope.name}`,
            ...(open === ""
                ? []
                : [
                      "",
                      "## Open questions in the wiki",
                      "",
                      `Resolve each one this session answered (as session #${String(id)}, dated today), on its page; leave the rest. Questions you add: \`- [ ] (YYYY-MM-DD, #${String(id)}) question\`.`,
                      "",
                      open,
                  ]),
        ].join("\n");
        const capture = await this.#conversation(model.model);
        const owner = app.config.users.find((user) => user.role === "owner")!;

        // A fresh context for each capture: the capture session's earlier ones would only cost tokens.
        await (await app.harness.conversation(capture, context))!.reset(undefined, context);
        const { submissionId } = await app.commands.submit(
            capture,
            owner,
            // A capture sent again after a failure is a new request: the same id would answer with the failed one. The
            // same attempt keeps its id, so one sent again after a restart before it was noted is not sent twice.
            { text, requestId: `wiki-capture:${String(id)}:${String(last)}:${String(state.sessions[String(id)]?.at ?? 0)}` },
            `wiki capture of session #${String(id)}`,
        );

        // Looked at now, so the idle look does not send it again while it runs; the watermark waits for the answer.
        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(ParaCaptureDoc);

            state.sessions[String(id)] = { entry: since, at: Date.now(), sending: { entry: last, submission: Number(submissionId) } };
        }, context);
        this.#settle(id, submissionId);

        return { sent: true, conversation: Number(capture) };
    }

    /**
     * When the capture's run ends: answered, the watermark moves to what it captured; not, it stays, the failure is kept
     * for the Wiki page, and the owner is told why, with where to change the capture model.
     */
    #settle(id: ConversationId, submissionId: SubmissionId): void {
        const app = this.#app;
        const key = String(id);

        if (this.#settling.has(key)) {
            return;
        }

        const settling = (async () => {
            const submission = await app.harness.submission(submissionId, context);

            if (submission === undefined) {
                throw new Error(`its submission ${String(submissionId)} is not in the capture session`);
            }

            const settled = await submission.wait(context);
            const why =
                settled.status === "done"
                    ? undefined
                    : `${settled.reason ?? "no answer"}${settled.detail === undefined ? "" : `: ${typeof settled.detail === "string" ? settled.detail : JSON.stringify(settled.detail)}`}`.slice(0, 400);

            await app.harness.commit(async (tx) => {
                const state = await tx.doc(ParaCaptureDoc);
                const each = state.sessions[key];

                if (each?.sending?.submission !== Number(submissionId)) {
                    return;
                }

                const now = Date.now();

                if (why === undefined) {
                    state.sessions[key] = { entry: each.sending.entry, at: now };
                    state.last = { session: Number(id), at: now };
                } else {
                    state.sessions[key] = { entry: each.entry, at: now };
                    state.failed = { session: Number(id), at: now, why };
                }
            }, context);

            if (why !== undefined) {
                app.ownerNotice("error", `Wiki capture of session #${key} failed: ${why}. It goes again with the session's next capture; the capture model is in Wiki settings.`);
            }
        })()
            .catch((error: unknown) => app.log(`wiki capture of session ${key}: ${describe(error)}`))
            .finally(() => this.#settling.delete(key));

        this.#settling.set(key, settling);
    }

    /** The capture session: made once, on the capture model, with the capture extension alone. */
    async #conversation(model: { provider: string; modelId: string }): Promise<ConversationId> {
        const app = this.#app;
        const known = (await this.#state()).conversation;

        if (known !== undefined && app.sessionMeta(known as unknown as ConversationId) !== undefined) {
            const id = known as unknown as ConversationId;

            await app.harness.commit(async (tx) => {
                Object.assign(await tx.doc(AgentDoc, id), { model, extensions: [CAPTURE_EXTENSION] });
            }, context);

            return id;
        }

        const owner = app.config.users.find((user) => user.role === "owner")!;
        const { id } = await app.commands.createSession(owner, { cwd: app.para.wikiDirNow(), title: "Wiki capture" });

        await app.harness.commit(async (tx) => {
            Object.assign(await tx.doc(AgentDoc, id), { model, thinkingLevel: "low", extensions: [CAPTURE_EXTENSION] });
            const meta = (await tx.doc(SessionsDoc)).items[String(id)]!;

            meta.wikiCapture = true;
            meta.archived = true;
            (await tx.doc(ParaCaptureDoc)).conversation = Number(id);
        }, context);

        return id;
    }

    async #state() {
        return (await this.#app.harness.snapshot(ParaCaptureDoc, context)) ?? { sessions: {} };
    }

    async #mark(id: ConversationId, entry: number): Promise<void> {
        await this.#app.harness.commit(async (tx) => {
            const state = await tx.doc(ParaCaptureDoc);

            state.sessions[String(id)] = { entry, at: Date.now() };
        }, context);
    }

    /** Minutes a session is idle before it is captured, or null: only when asked. The owner's (the route checks). */
    setMinutes(minutes: unknown): void {
        if (minutes !== null && (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 1 || minutes > 1440)) {
            throw new Error("Capture after a whole number of idle minutes from 1 to 1440, or only when asked.");
        }

        this.#app.config.wikiCaptureMinutes = minutes;
    }

    /** For the Wiki page: whether captures run, on what, the last one, and the capture session. */
    async status() {
        const minutes = this.#app.config.wikiCaptureMinutes;
        const model = await this.model();
        const state = await this.#state();

        return {
            minutes,
            model: model.ok ? `${model.model.provider}/${model.model.modelId}` : null,
            why: model.ok ? null : model.why,
            last: state.last ?? null,
            // Only when no capture answered since: one that did means the model works again.
            failed: state.failed !== undefined && (state.last === undefined || state.failed.at > state.last.at) ? state.failed : null,
            conversation: state.conversation ?? null,
        };
    }
}
