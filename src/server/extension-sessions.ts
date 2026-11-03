/**
 * Ordinary sessions an extension starts (PP-380, from pi-pocket 0.28.0's `host.sessions.start`): a top-level session,
 * like New session, for the person Pi works for in the source session, made once for a key. Not a linked session: it
 * does not show under the source, and its first message is the person's own words, not a message from a session.
 *
 * Every check is the person's, before anything is made: they may see the source and start sessions (an invited person
 * may not), the source is within its spend limit, the folder is there, the model can be used now, and a first message
 * is not blank and has a model to take it. A repeat of a key returns the session its first call made, acting for the
 * person that call acted for, and sends the first message once; it does not check the model, the folder or the spend
 * limit again. The session and the call's record are made in one commit (`ExtensionSessionCallsDoc`): of two calls at
 * once with one key, the one that finds the record aborts its own commit, which then makes nothing.
 */
import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import { AgentDoc, type ConversationId, type ModelRef, type Tx } from "@earendil-works/pi-durable";
import type { PocketApp } from "./app.ts";
import type { User } from "./config.ts";
import { type ExtensionSessionCall, ExtensionSessionCallsDoc } from "./docs.ts";
import { HttpError } from "./errors.ts";
import type { SessionsApi, SessionStart } from "./host.ts";
import { isThinkingLevel, levelAtMost, resolveModel, THINKING_LEVELS } from "./models.ts";
import { clientKey, ownRequest } from "./requests.ts";

const context = BACKGROUND_CONTEXT;
/** The call records a source keeps: the newest 1000, 30 days at most. */
const KEEP_CALLS = 1000;
const KEEP_CALLS_MS = 30 * 24 * 60 * 60 * 1000;

/** A key's record in its source, as a hash: stable across restarts, and short enough for a message's request id. */
const callToken = (source: ConversationId, key: string): string => createHash("sha256").update(`session:${source}:${key}`).digest("hex");

/** The record of call `token`, made when there is none, the oldest pruned to make room. */
function recordOf(calls: { items: Record<string, ExtensionSessionCall> }, token: string, now: number): ExtensionSessionCall {
    const known = calls.items[token];

    if (known !== undefined) {
        return known;
    }

    calls.items = Object.fromEntries(
        Object.entries(calls.items)
            .filter(([, record]) => now - record.at < KEEP_CALLS_MS)
            .sort(([, a], [, b]) => a.at - b.at)
            .slice(-(KEEP_CALLS - 1)),
    );
    calls.items[token] = { at: now };

    return calls.items[token];
}

/** Thrown inside the creation commit when a call with the same key recorded its session first: that commit makes nothing. */
class AlreadyStarted extends Error {
    readonly session: ConversationId;

    constructor(session: ConversationId) {
        super("This call already started a session.");
        this.name = "AlreadyStarted";
        this.session = session;
    }
}

export class ExtensionSessions implements SessionsApi {
    readonly #app: PocketApp;

    constructor(app: PocketApp) {
        this.#app = app;
    }

    async start(source: ConversationId, request: SessionStart, key: string): Promise<{ session: ConversationId }> {
        const app = this.#app;

        // Commands.submit sends no blank message: refused before anything is made.
        if (request.message !== undefined && request.message.trim() === "") {
            throw new HttpError(400, "The first message is empty.");
        }

        const token = callToken(source, key);
        const recorded = async () => (await app.harness.snapshot(ExtensionSessionCallsDoc, source, context))?.items[token];
        const previous = await recorded();
        // A repeat acts for the person the first call acted for: the message is theirs, and goes once.
        const requester = previous?.by ?? app.attribution.requesterOf(source);
        const user = requester === undefined ? undefined : app.config.userById(requester);

        if (app.sessionMeta(source) === undefined || user === undefined) {
            throw new HttpError(403, "A session starts only where Pi works for someone.");
        }

        app.requireSee(user, source);

        // A repeat returns the session the first call made, even when a check below would refuse a new call now.
        let session = previous?.conversationId as ConversationId | undefined;
        let sender = user;

        if (session === undefined) {
            const chosen = await this.#chosen(request.model, request.thinking);

            // Before anything is made: a source past its spend limit starts nothing.
            app.spend.check(user, source);
            session = await this.#create(source, user, request, chosen, token).catch(async (error: unknown) => {
                if (!(error instanceof AlreadyStarted)) {
                    throw error;
                }

                const winner = await recorded();

                // The message is the winner's person's: the call that lost the race does not send it again as another.
                sender = (winner?.by === undefined ? undefined : app.config.userById(winner.by)) ?? user;

                return (winner?.conversationId as ConversationId | undefined) ?? error.session;
            });
        }

        if (request.message !== undefined) {
            await this.#message(session, sender, request.message, token);
        }

        return { session };
    }

    /** The model and thinking asked for, checked before anything is made. No model: what a new session starts with. */
    async #chosen(spec: string | undefined, level: string | undefined): Promise<{ model?: ModelRef; thinking?: ModelThinkingLevel }> {
        const app = this.#app;
        const named = spec?.trim() || undefined;
        const asked = level?.trim() || undefined;

        if (asked !== undefined && !isThinkingLevel(asked)) {
            throw new HttpError(400, `Thinking must be one of: ${THINKING_LEVELS.join(", ")}.`);
        }

        if (named === undefined) {
            return asked === undefined ? {} : { thinking: asked };
        }

        let model: ModelRef;

        try {
            model = resolveModel(app.models, named, app.signInNeeded);
        } catch (error) {
            throw new HttpError(400, error instanceof Error ? error.message : String(error));
        }

        const problem = await app.providers.problem(model, true);

        if (problem !== undefined) {
            throw new HttpError(400, `The model ${model.provider}/${model.modelId} cannot be used now: ${problem}.`);
        }

        return { model, ...(asked === undefined ? {} : { thinking: asked }) };
    }

    /** Make the session and the call's record in one commit. */
    async #create(
        source: ConversationId,
        user: User,
        request: SessionStart,
        chosen: { model?: ModelRef; thinking?: ModelThinkingLevel },
        token: string,
    ): Promise<ConversationId> {
        const app = this.#app;
        const now = Date.now();
        const { id } = await app.commands.createSession(
            user,
            {
                ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
                ...(request.title === undefined ? {} : { title: request.title }),
            },
            {
                ...(chosen.model === undefined ? {} : { model: chosen.model }),
                init: async (tx, made) => {
                    const agent = await tx.doc(AgentDoc, made);
                    const model = agent.model && app.models.getModel(agent.model.provider, agent.model.modelId);

                    // Commands.submit refuses a first message on a session with no model: refused here, in the commit
                    // that makes the session, it leaves no session.
                    if (request.message !== undefined && model === undefined) {
                        throw new HttpError(409, "Pick a model first: name one in `model`, or choose a default model.");
                    }

                    // Lowered to a level the session's model has, named or a new session's.
                    if (chosen.thinking !== undefined && model !== undefined) {
                        agent.thinkingLevel = levelAtMost(model, chosen.thinking) ?? "off";
                    }

                    await this.#receipt(tx, source, made, user, token, now);
                },
            },
        );

        return id;
    }

    /** Record this call; a call with the same key that recorded first: abort, so this commit writes nothing. */
    async #receipt(tx: Tx, source: ConversationId, made: ConversationId, user: User, token: string, now: number): Promise<void> {
        const receipt = recordOf(await tx.doc(ExtensionSessionCallsDoc, source), token, now);

        if (receipt.conversationId !== undefined) {
            throw new AlreadyStarted(receipt.conversationId as unknown as ConversationId);
        }

        Object.assign(receipt, { conversationId: Number(made), by: user.id });
    }

    /** Send the first message as the person's own words, once: a message already stored for this key is the first. */
    async #message(id: ConversationId, user: User, message: string, token: string): Promise<void> {
        const app = this.#app;
        const requestId = ownRequest(user.id, clientKey(token));
        // Looked up before Commands.submit: its checks (a spend limit reached since) would refuse a repeat.
        const sent = (await app.harness.commit((tx) => tx.submissionByRequest(id, requestId), context)) !== undefined;

        if (!sent) {
            await app.commands.submit(id, user, { text: message, requestId: token });
        }
    }
}
