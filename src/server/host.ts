import type { Context } from "@earendil-works/chord";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Skill } from "@earendil-works/pi-coding-agent";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type {
    ConversationId,
    DocumentReader,
    Extension,
    ModelRef,
    TaskId,
    Tx,
} from "@earendil-works/pi-durable";
import type { Role, User } from "./config.ts";
import type { Goals } from "./goals.ts";
import type { Schedules } from "./schedules.ts";

export interface ApprovalRequest {
    id: string;
    conversationId: ConversationId;
    taskId: TaskId;
    /** The model's tool call id, to show the decision on the call's card afterwards. */
    callId?: string;
    tool: string;
    subject: string;
    reason: string;
    score?: number;
    createdAt: number;
    /** Who Pi was working for when the call asked: set by `Approvals`, not by the asker. */
    requestedBy?: string;
}

export type ApprovalAnswer = { allow: boolean; by: string };

/**
 * Tool calls waiting for a human. In memory on purpose: the guard hook runs before a call's intent is stored, so after
 * a restart the hook runs again and asks again, unless its memo already holds the answer.
 */
export class Approvals {
    readonly #pending = new Map<
        string,
        { request: ApprovalRequest; resolve: (answer: ApprovalAnswer) => void }
    >();
    readonly #listeners = new Set<(conversationId: ConversationId) => void>();
    readonly #requesterOf: (conversationId: ConversationId) => string | undefined;

    /** `requesterOf`: who Pi works for in a conversation right now. */
    constructor(requesterOf: (conversationId: ConversationId) => string | undefined) {
        this.#requesterOf = requesterOf;
    }

    request(asked: ApprovalRequest, context: Context): Promise<ApprovalAnswer> {
        // Who asked is fixed now: someone writing to Pi while the call waits does not become its requester.
        const { requestedBy: _ignored, ...rest } = asked;
        const requestedBy = this.#requesterOf(asked.conversationId);
        const request: ApprovalRequest =
            requestedBy === undefined ? rest : { ...rest, requestedBy };
        const existing = this.#pending.get(request.id);

        if (existing !== undefined) {
            existing.resolve({ allow: false, by: "superseded" });
        }

        const answered = new Promise<ApprovalAnswer>((resolve) => {
            this.#pending.set(request.id, { request, resolve });
        });

        this.#emit(request.conversationId);

        return awaitWithContext(answered, context).finally(() => {
            if (this.#pending.get(request.id)?.request === request) {
                this.#pending.delete(request.id);
                this.#emit(request.conversationId);
            }
        });
    }

    answer(id: string, answer: ApprovalAnswer): boolean {
        const pending = this.#pending.get(id);

        if (pending === undefined) {
            return false;
        }

        this.#pending.delete(id);
        pending.resolve(answer);
        this.#emit(pending.request.conversationId);

        return true;
    }

    forConversation(conversationId: ConversationId): ApprovalRequest[] {
        return [...this.#pending.values()]
            .map((pending) => pending.request)
            .filter((request) => request.conversationId === conversationId);
    }

    all(): ApprovalRequest[] {
        return [...this.#pending.values()].map((pending) => pending.request);
    }

    subscribe(listener: (conversationId: ConversationId) => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    #emit(conversationId: ConversationId): void {
        for (const listener of this.#listeners) {
            listener(conversationId);
        }
    }
}

/** What a command gives back: a notice for the person who ran it alone, or a card of plain text for everyone here. */
export type CommandResult =
    | { type: "toast"; level: "info" | "warning" | "error"; message: string }
    | { type: "card"; output: string };

/** Who ran a command and where, with the durable task that runs it: read and change documents through it. */
export interface CommandContext {
    readonly user: Readonly<Pick<User, "id" | "name" | "role">>;
    readonly conversationId: ConversationId;
    readonly cwd: string;
    readonly signal: AbortSignal;
    readonly snapshot: DocumentReader["snapshot"];
    readonly context: Context;
    /** Change documents in one commit; answers what `change` returns. */
    commit<T>(change: (tx: Tx) => T | Promise<T>): Promise<T>;
}

/**
 * A command people run from the message box (`web.command(name, command)`), without asking Pi. `scope` says who may run
 * it: `"conversation"`, whoever may drive the session; `"global"`, the owner alone. Either way it runs in the session it
 * was typed in, and its card goes there.
 */
export interface ExtensionCommand {
    description: string;
    args?: string;
    scope: "conversation" | "global";
    handler(args: string, context: CommandContext): CommandResult | Promise<CommandResult>;
}

/** What browsers know about a command: no handler, and no file. The id changes with each version of its module. */
export type CommandInfo = Omit<ExtensionCommand, "handler"> & { id: string; name: string };

/** What the app gives its extensions. Extensions are reloaded on edit; the host is not. */
export interface PocketHost {
    readonly approvals: Approvals;
    readonly agentDir: string;
    readonly dataDir: string;
    /** Pi's configured extra skill paths, from its settings. */
    skillPaths(): string[];
    /** Pi's skills for a session working in `cwd`, from the places Pi looks (`skills.ts`). */
    skills(cwd: string): Skill[];
    /** The machine a session's cwd is on (`places.ts`), with what the prompt says about it; undefined on this phone. */
    machineOf(cwd: string): { name: string; address: string; path: string; platform: string } | undefined;
    /**
     * `provider/modelId` (or a bare model id) to a signed-in model whose sign-in has not expired, or an error that says
     * it is not available. The error names no other models: models are a person's to choose.
     */
    resolveModel(spec: string): ModelRef;
    /**
     * The models Pi may start subagents on besides their session's own, as the owner allowed them (`provider/modelId`).
     * Empty, the default: none.
     */
    subagentModels(): readonly string[];
    /**
     * Why Pi may not use a model now, in words for Pi to pass on (not known here, its provider not signed in, or its
     * sign-in expired), or undefined when it may. `fresh` asks the provider's sign-in again first.
     */
    modelProblem(ref: ModelRef, fresh?: boolean): Promise<string | undefined>;
    /** Who Pi works for in a conversation now: whose message led to its current work. */
    requesterOf(conversationId: ConversationId): string | undefined;
    /** Report something odd to the log and the connected clients: with `conversationId`, to that session's tabs only. */
    notice(
        level: "info" | "warning" | "error",
        message: string,
        conversationId?: ConversationId,
    ): void;
    /**
     * Why work Pi would start in a conversation with nobody asking (a subagent's report, say) may not start now: the
     * spend limit its session or whoever pays there reached. Undefined when it may.
     */
    heldBack(conversationId: ConversationId): string | undefined;
    /** Call `listener` whenever the owner changes a spend limit; returns how to stop. */
    onLimitsChanged(listener: () => void): () => void;
    /** Messages to Pi for later: the schedule tool sets up Pi's own. */
    readonly schedules: Pick<Schedules, "add" | "cancel" | "list" | "task">;
    /** Sessions' goals: the goals extension runs their checks and counts them. */
    readonly goals: Pick<Goals, "get" | "run" | "record" | "mayContinue">;
    /**
     * Text from elsewhere made safe for Pi to read (`fence.ts`): `quoted` gives one line, cut to `max`, without
     * invisible characters or any tag, in quotes it cannot close; `defang` keeps the lines, but no closing tag survives,
     * for text put between tags of your own. Tell Pi in the same place that it is data.
     */
    readonly text: { quoted(text: string, max?: number): string; defang(text: string): string };
    /** The thinking levels, lowest first, as a model and a session name them. */
    readonly thinkingLevels: readonly ModelThinkingLevel[];
}

/**
 * Who may use a module's web part: the owner alone (the default), anyone who can steer, or anyone who can view. People
 * invited to one session never may: a web part belongs to the whole app.
 */
export type WebAccess = "owner" | "steer" | "view";

export type WebMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** A request to a module's route, as its handler gets it. */
export interface WebRequest {
    readonly method: WebMethod;
    /** The path's `:name` parts, by name. */
    readonly params: Readonly<Record<string, string>>;
    readonly query: URLSearchParams;
    /** The JSON object the browser sent; empty for GET and DELETE. */
    readonly body: Readonly<Record<string, unknown>>;
    /** Who asked. */
    readonly user: { readonly id: string; readonly name: string; readonly role: Role };
    /** Aborted when the browser stops waiting for the answer. */
    readonly signal: AbortSignal;
}

/**
 * What a route answers: a value sent as JSON (undefined sends `{}`). An error made with `web.error` answers with its
 * status and words; any other throw is a 500, whose words only the owner sees.
 */
export type WebHandler = (request: WebRequest) => unknown;

/**
 * A module's own part of the app, the second argument of its default export: routes under `/api/x/<module>/`, a browser
 * module that adds to the app's screens, events from here to that browser module, and commands for the message box.
 * Routes, the browser module, and commands are registered while the module loads; they go with it when it reloads or
 * is turned off.
 */
export interface ExtensionWeb {
    /** The version of this API (`POCKET_API` in `extension-web.ts`). */
    readonly api: number;
    /** The module's name: its file's, without `.ts`. Its routes are under `/api/x/<module>/`. */
    readonly module: string;
    /** Answer `method` requests to `/api/x/<module>/<path>`. A part of `path` written `:name` matches any one part. */
    route(
        method: WebMethod,
        path: string,
        handle: WebHandler,
        options?: { access?: WebAccess },
    ): void;
    /**
     * The browser module that adds to the app: a `.js` file beside this module, or a folder with an `index.js` and the
     * files it imports. Browsers of the people `access` lets in load it.
     */
    client(entry: string, options?: { access?: WebAccess }): void;
    /**
     * Send the browser module an event (`pocket.on(event, …)` there): to everyone it loads for, or to one person. Never
     * throws: an event it cannot send (not JSON, too large) goes to the server's log instead.
     */
    send(event: string, data?: unknown, options?: { to?: string }): void;
    /** An error for a route to throw: whoever asked gets `status` (400 to 599) and `message` as they are. */
    error(status: number, message: string): Error;
    /**
     * Run `dispose` when this version of the module goes: replaced by an edit, turned off, or the server stopping. It
     * may return a promise: a stopping server waits for it, up to 3 s.
     */
    onDispose(dispose: () => unknown): void;
    /**
     * A command people run from the message box as `/name`, while the module loads. It goes with this version of the
     * module, as routes do. `scope: "conversation"` is for whoever may drive the session; `"global"` is the owner's.
     */
    command(name: string, command: ExtensionCommand): void;
}

/** The shape of every module in `src/server/extensions/`: a default export building one or more extensions. */
export type ExtensionModule = {
    /** Builds the module's extensions; a module that only adds to the app returns nothing. It may be async. */
    default: (
        host: PocketHost,
        web: ExtensionWeb,
    ) => Extension | readonly Extension[] | void | Promise<Extension | readonly Extension[] | void>;
    /** The version of the extension API the module needs, when it says: a newer one than the app's is not loaded. */
    pocketApi?: unknown;
};
