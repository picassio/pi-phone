/**
 * `/better` in the app (PP-506): starting and stopping a session's helper (`better.ts`), its progress for the rows above
 * the message box, and which conversations are helpers. A helper belongs to its session: its spend, its secrets, who it
 * works for and who may open it follow the session's (`app.rootOf`).
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { type ConversationId, type EntryId, LiveDoc, type TaskId } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import { BETTER_TASK_OPTIONS, BetterDoc, type BetterProgress, type BetterResult, type BetterRun, BetterTask, helperProgress } from "./better.ts";
import type { User } from "./config.ts";
import { describe, HttpError } from "./errors.ts";
import { parsePlace } from "./places.ts";

const context = BACKGROUND_CONTEXT;
/** The rows follow a helper at most this often: a streaming answer commits every 90 ms. */
const PROGRESS_MS = 300;
/** How many of a helper's own entries the rows read: far more than 20 minutes of reading makes. */
const PROGRESS_ENTRIES = 2000;

/** What a session's view shows of `/better`: the run under way with its progress, and the last result. */
export type BetterView = {
    running: (BetterRun & BetterProgress) | null;
    last: BetterResult | null;
};

export class BetterRuns {
    readonly #app: PocketApp;
    /** Each helper's session, and where its copy of the session ends. */
    readonly #helpers = new Map<ConversationId, { parent: ConversationId; at?: number }>();
    /** Each session's helper's progress, by session. */
    readonly #progress = new Map<ConversationId, BetterProgress>();
    readonly #timers = new Map<ConversationId, NodeJS.Timeout>();

    constructor(app: PocketApp) {
        this.#app = app;
    }

    /** A helper's document, as read at the start or committed: it says whose helper it is. */
    noteHelper(id: ConversationId, doc: { parent?: number; at?: number } | null | undefined): void {
        if (doc?.parent !== undefined) {
            this.#helpers.set(id, { parent: doc.parent as ConversationId, ...(doc.at === undefined ? {} : { at: doc.at }) });
        }
    }

    /** The session `id` is the helper of, if it is one. */
    sessionOf(id: ConversationId): ConversationId | undefined {
        return this.#helpers.get(id)?.parent;
    }

    /**
     * `/better <prompt>` in session `id`, by `user`: a helper starts in the background. Refused while one runs there, and
     * with no prompt in a session with nothing to deepen yet.
     */
    async start(id: ConversationId, user: User, text: string): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        await app.requireDriver(id, user);

        if (app.sessionMeta(id) === undefined) {
            throw new HttpError(400, "/better runs in a session, not in a subagent or a helper.");
        }

        // The helper runs on the session's model, as a message would: the same checks.
        const agent = await app.agentState(id);
        const model = agent?.model === undefined ? undefined : app.models.getModel(agent.model.provider, agent.model.modelId);

        if (model === undefined) {
            throw new HttpError(409, "Pick a model for this conversation first.");
        }

        if (!app.policy.modelAllowed(model.provider, model.id)) {
            throw new HttpError(403, `${app.policy.get()?.role ?? "Your role"} does not include ${model.provider}/${model.id}: pick one of its models for this session.`);
        }

        app.spend.check(user, id);
        // A known secret's value pasted in stays out, as in a message (`Commands.submit`).
        const prompt = app.secrets.redact(text.trim(), id);
        const conversation = await app.conversation(id);

        await conversation.commit(async (tx) => {
            const doc = await tx.doc(BetterDoc, id);

            if (doc.run !== undefined) {
                throw new HttpError(409, "/better is already running here: stop it above the message box, or wait for it.");
            }

            if (prompt === "" && (await tx.scanEntries({ conversationId: id }, 1)).items.length === 0) {
                throw new HttpError(400, "/better has no task to deepen yet: give it a prompt, such as /better make the error messages clearer.");
            }

            const task = await tx.createTask(BetterTask, { kind: "prompt", by: user.id, prompt }, BETTER_TASK_OPTIONS);

            doc.run = { task: Number(task), by: user.id, prompt, startedAt: Date.now() };
        }, context);
    }

    /** Stop session `id`'s helper: its run stops, and its result says it was stopped. */
    async stop(id: ConversationId, user: User): Promise<void> {
        const app = this.#app;

        app.requireSee(user, id);
        app.requireSteer(user);
        const run = (await app.harness.snapshot(BetterDoc, id, context))?.run;

        if (run === undefined) {
            throw new HttpError(409, "No /better is running here.");
        }

        await app.harness.abortTask(run.task as unknown as TaskId, context);
    }

    /** Something of helper `id` was committed: its session's rows follow, a moment later. */
    changed(id: ConversationId): void {
        if (!this.#helpers.has(id) || this.#timers.has(id)) {
            return;
        }

        const timer = setTimeout(() => {
            this.#timers.delete(id);
            this.#refresh(id).catch((error: unknown) => this.#app.log(`/better progress not read: ${describe(error)}`));
        }, PROGRESS_MS);

        timer.unref();
        this.#timers.set(id, timer);
    }

    async #refresh(id: ConversationId): Promise<void> {
        const app = this.#app;
        const helper = this.#helpers.get(id);
        const conversation = await app.harness.conversation(id, context);

        if (helper === undefined || conversation === undefined) {
            return;
        }

        const own = await conversation.entries(
            { ...(helper.at === undefined ? {} : { minEntryId: (helper.at + 1) as EntryId }), order: "ascending" },
            PROGRESS_ENTRIES,
            undefined,
            context,
        );
        const live = await app.harness.snapshot(LiveDoc, id, context);
        const place = parsePlace(app.cwdOf(id));
        const home = place.machineId === undefined ? app.home : (app.places.machineOf(app.cwdOf(id))?.remote?.home ?? "~");

        this.#progress.set(helper.parent, helperProgress(own.items, live?.generation?.message as AssistantMessage | undefined, place.path, home));
        app.refreshView(helper.parent);
    }

    /** What session `id`'s view shows, from its `BetterDoc`. */
    view(id: ConversationId, doc: { run?: BetterRun; last?: BetterResult } | undefined): BetterView {
        const run = doc?.run;

        if (run === undefined) {
            this.#progress.delete(id);
        }

        return {
            running: run === undefined ? null : { ...run, ...(this.#progress.get(id) ?? { stage: 0, tools: [], count: 0, failed: 0 }) },
            last: doc?.last ?? null,
        };
    }
}
