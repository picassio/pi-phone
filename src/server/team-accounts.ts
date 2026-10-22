/**
 * The team's provider accounts, as this pi-phone sees them on the team server (PP-69, `src/gateway/team-accounts.ts`):
 * listed in the Providers sheet beside the person's own, and, for someone with providers.manage, added, signed in,
 * renamed, signed out and removed there. Their sign-ins and keys stay on the gateway: a sign-in runs there, and this
 * pi-phone fetches its steps (a link, a code to paste, a device code) and shows them in its sign-in card as its own
 * sign-ins do (the `auth` event), and sends the answers back.
 */
import {
    type Api,
    type AssistantMessage,
    type AssistantMessageEvent,
    type AssistantMessageEventStream,
    createAssistantMessageEventStream,
    type Context,
    type Model,
    type Provider,
    type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HttpError } from "./errors.ts";
import type { AccountUsage } from "./usage-limits.ts";

/** The options sent along with a request: how the model answers (the gateway takes only these too). */
const RELAYED = ["temperature", "samplingParams", "maxTokens", "cacheRetention", "sessionId", "metadata", "toolChoice", "reasoning", "thinkingBudgets"] as const;
/** What a team account's provider is signed in with here: nothing real, the gateway has the sign-in. */
const ON_THE_TEAM_SERVER = "team-server";

/** A failed answer, as pi-ai ends a stream that failed: the reason in `errorMessage`. */
function failed(model: Model<Api>, message: string, aborted = false): AssistantMessageEvent {
    const error: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: aborted ? "aborted" : "error",
        errorMessage: message,
        timestamp: Date.now(),
    };

    return { type: "error", reason: aborted ? "aborted" : "error", error };
}

/** A sign-in step as the Providers sheet shows it (`providers.ts`, `client.send("auth", …)`). */
type Step = { step: string; [key: string]: unknown };

export type TeamAccountRow = {
    id: string;
    provider: string;
    name: string;
    providerName: string;
    configured: boolean;
    oauth: boolean;
    signIn: { oauth: string | null; apiKey: boolean };
    models: number;
    /** The roles that may use it, by name. */
    roles: string[];
    /** Whether this person's role may use it. */
    usable: boolean;
};

export class TeamAccountsClient {
    readonly #server: { url: string; token: string } | undefined;
    /** Send a sign-in's step to this person's open tabs. */
    readonly #send: (data: Record<string, unknown>) => void;
    /** Sign-ins under way here, by id: whose they are. */
    readonly #flows = new Set<string>();
    /** The team accounts registered as providers here: their names, by id. */
    readonly #registered = new Map<string, string>();

    /** The person's Claude Code billing setting (`phone.json`), sent with each answer asked of the team server. */
    readonly #billing: () => { enabled: boolean; version: string };

    constructor(server: { url: string; token: string } | undefined, send: (data: Record<string, unknown>) => void, billing: () => { enabled: boolean; version: string }) {
        this.#server = server;
        this.#send = send;
        this.#billing = billing;
    }

    /**
     * The plan limits of the team subscriptions this person may use (PP-74), asked of the team server, which keeps them a
     * minute: none off the team server or without team accounts here.
     */
    async usage(fresh: boolean): Promise<AccountUsage[]> {
        if (this.#server === undefined || this.#registered.size === 0) {
            return [];
        }

        return (await this.#call<{ usage: AccountUsage[] }>({ action: "usage", fresh })).usage;
    }

    /** On the team server only. */
    get available(): boolean {
        return this.#server !== undefined;
    }

    async #call<T>(body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
        const server = this.#server;

        if (server === undefined) {
            throw new HttpError(400, "Team accounts are for the team server.");
        }

        const response = await fetch(`${server.url}/internal/team-accounts`, {
            method: "POST",
            headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const answer = (await response.json()) as { value?: T; error?: string };

        if (!response.ok) {
            throw new HttpError(response.status, answer.error ?? `The team server answered ${response.status}.`);
        }

        return answer.value as T;
    }

    /** The team accounts this person may see, and whether they manage them. */
    async list(): Promise<{ manage: boolean; accounts: TeamAccountRow[] }> {
        return await this.#call({ action: "list" });
    }

    async add(provider: unknown, name: unknown): Promise<unknown> {
        return await this.#call({ action: "add", provider, name });
    }

    async rename(id: string, name: unknown): Promise<unknown> {
        return await this.#call({ action: "rename", id, name });
    }

    async logout(id: string): Promise<void> {
        await this.#call({ action: "logout", id });
    }

    async remove(id: string): Promise<void> {
        await this.#call({ action: "remove", id });
    }

    /**
     * Sign a team account in, on the gateway: its steps reach this person's tabs as they come, as one of their own
     * sign-ins does. `onDone`: after it finished (well or not).
     */
    async startLogin(id: string, providerName: string, type: "oauth" | "api_key", onDone: () => void): Promise<string> {
        const { flowId } = await this.#call<{ flowId: string }>({ action: "login", id, type });

        this.#flows.add(flowId);
        void (async () => {
            let after = 0;

            try {
                for (;;) {
                    const { steps, done } = await this.#call<{ steps: Step[]; done: boolean }>({ action: "wait", flowId, after }, 40_000);

                    after += steps.length;

                    for (const step of steps) {
                        this.#send({ flowId, providerId: id, providerName, ...step });
                    }

                    if (done) {
                        break;
                    }
                }
            } catch (error) {
                this.#send({ flowId, providerId: id, providerName, step: "done", ok: false, loginType: type, error: "The team server stopped answering. Try again.", details: error instanceof Error ? error.message : String(error) });
            } finally {
                this.#flows.delete(flowId);
                onDone();
            }
        })();

        return flowId;
    }

    /**
     * The team accounts this person may use, signed in, as providers of this pi-phone (S2): each with its models, from the
     * gateway, and answers that come from there. Ones no longer theirs (a role changed, an account removed or signed
     * out) go: a session on one then says its model needs another. On the team server only; again at each policy.
     */
    async sync(models: ModelRuntime): Promise<void> {
        if (!this.available) {
            return;
        }

        const { accounts } = await this.list();
        const usable = accounts.filter((account) => account.usable && account.configured);

        for (const account of usable) {
            const base = models.getProvider(account.provider);

            if (base === undefined) {
                continue;
            }

            const { models: list } = await this.#call<{ models: Model<Api>[] }>({ action: "models", id: account.id });

            models.registerNativeProvider(this.#provider(account, base, list));
            await models.setRuntimeApiKey(account.id, ON_THE_TEAM_SERVER);
            this.#registered.set(account.id, account.name);
        }

        for (const id of [...this.#registered.keys()]) {
            if (!usable.some((account) => account.id === id)) {
                await models.removeRuntimeApiKey(id).catch(() => undefined);
                models.unregisterProvider(id);
                this.#registered.delete(id);
            }
        }
    }

    /**
     * Whether the team accounts this person may use (signed in) changed since the last sync, and then sync: a teammate
     * signed one in, signed one out, renamed or removed one. Asked when the Providers sheet or the model menu opens.
     */
    async refresh(models: ModelRuntime): Promise<boolean> {
        if (!this.available) {
            return false;
        }

        const { accounts } = await this.list();
        const now = accounts
            .filter((account) => account.usable && account.configured && models.getProvider(account.provider) !== undefined)
            .map((account) => `${account.id}=${account.name}`)
            .sort();
        const was = [...this.#registered].map(([id, name]) => `${id}=${name}`).sort();

        if (now.join("\n") === was.join("\n")) {
            return false;
        }

        await this.sync(models);

        return true;
    }

    /** The name a team account's models show after their provider's: "Team Work" (`anthropic · Team Work account`). */
    label(id: string): string | undefined {
        const name = this.#registered.get(id);

        return name === undefined ? undefined : `Team ${name}`;
    }

    /** A team account as a provider here: its models, and each answer asked of the gateway. */
    #provider(account: TeamAccountRow, base: Provider, list: Model<Api>[]): Provider {
        const relay = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => this.#stream(model, context, options);

        return {
            id: account.id,
            name: `${base.name} · Team ${account.name}`,
            auth: base.auth,
            getModels: () => list,
            stream: relay,
            streamSimple: relay,
        } as unknown as Provider;
    }

    /** One answer of a team account's model: asked of the gateway, its events pushed here as they come. */
    #stream(model: Model<Api>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
        const events = createAssistantMessageEventStream();
        const server = this.#server!;
        const relayed: Record<string, unknown> = {};

        for (const key of RELAYED) {
            if (options?.[key] !== undefined) {
                relayed[key] = options[key];
            }
        }

        void (async () => {
            let ended = false;

            try {
                const response = await fetch(`${server.url}/internal/llm/stream`, {
                    method: "POST",
                    headers: { authorization: `Bearer ${server.token}`, "content-type": "application/json" },
                    body: JSON.stringify({ id: model.provider, model: model.id, context, options: relayed, billing: this.#billing() }),
                    ...(options?.signal === undefined ? {} : { signal: options.signal }),
                });

                if (!response.ok || response.body === null) {
                    const answer = (await response.json().catch(() => ({}))) as { error?: string };

                    events.push(failed(model, answer.error ?? `The team server answered ${response.status}.`));
                    ended = true;

                    return;
                }

                const decoder = new TextDecoder();
                let pending = "";

                for await (const chunk of response.body) {
                    pending += decoder.decode(chunk as Uint8Array, { stream: true });

                    for (let end = pending.indexOf("\n"); end !== -1; end = pending.indexOf("\n")) {
                        const line = pending.slice(0, end);

                        pending = pending.slice(end + 1);

                        if (line.trim() !== "") {
                            const event = JSON.parse(line) as AssistantMessageEvent;

                            events.push(event);
                            ended ||= event.type === "done" || event.type === "error";
                        }
                    }
                }
            } catch (error) {
                if (!ended) {
                    const aborted = options?.signal?.aborted === true;

                    events.push(failed(model, aborted ? "Stopped." : `The team server stopped answering: ${error instanceof Error ? error.message : String(error)}`, aborted));
                    ended = true;
                }
            } finally {
                if (!ended) {
                    events.push(failed(model, "The team server ended the answer early."));
                }

                events.end();
            }
        })();

        return events;
    }

    /** Whether a sign-in is one of the team's, under way here. */
    owns(flowId: string): boolean {
        return this.#flows.has(flowId);
    }

    async answer(flowId: string, promptId: string, value: string | undefined): Promise<void> {
        await this.#call({ action: "answer", flowId, promptId, value: value ?? null });
    }

    async cancel(flowId: string): Promise<void> {
        await this.#call({ action: "cancel", flowId });
    }
}
