/**
 * The team's provider accounts (PP-69, wiki: pi-phone-team-providers): a provider's sign-in or key, set up once for the
 * team, whose models people's roles let them use. They live only here, in the gateway's own model runtime and its own
 * auth file (`<data>/team-providers/auth.json`); people's pi-phones never get them, and call their models through the
 * gateway (S2). Each is a provider of its own, `<provider>~team-<slug>`, made as a pi-phone makes an extra account
 * (`accounts.ts`): the provider's own code, sign-in and renewal included, runs as it would on the phone.
 *
 * Signing one in is a person's, from their pi-phone's Providers sheet: the flow runs here, and its steps (a link, a code
 * to paste, a device code) wait here for that pi-phone to fetch them (`wait`) and send the answers back (`answer`).
 */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, AssistantMessageEventStream, AuthPrompt, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ACCOUNT_PROVIDERS, accountProvider, baseProvider } from "../server/accounts.ts";
import { patchClaudeCodePayload } from "../server/cc-patch.ts";
import { DEFAULT_SETTINGS } from "../server/phone-settings.ts";
import { type AccountUsage, UsageLimits } from "../server/usage-limits.ts";
import { HttpError } from "../server/errors.ts";

export type TeamAccount = {
    /** `<provider>~team-<slug>`. */
    id: string;
    /** The provider it is an account of. */
    provider: string;
    name: string;
    createdAt: number;
    createdBy: string;
};

/** What a sign-in says next, as a pi-phone's Providers sheet shows a sign-in's steps (`providers.ts`). */
export type FlowStep =
    | { step: "event"; event: unknown }
    | { step: "prompt"; promptId: string; prompt: Omit<AuthPrompt, "signal"> }
    | { step: "prompt-closed"; promptId: string }
    | { step: "done"; ok: boolean; loginType: "oauth" | "api_key"; error?: string; details?: string };

type Flow = {
    id: string;
    account: string;
    userId: string;
    steps: FlowStep[];
    waiters: Set<() => void>;
    prompts: Map<string, { resolve: (value: string) => void; reject: (error: Error) => void; requiresKey: boolean }>;
    abort: AbortController;
    done: boolean;
};

/** Where the team accounts are kept: the gateway's store, as plain rows (no secrets). */
export interface TeamAccountRows {
    teamAccounts(): TeamAccount[];
    saveTeamAccount(account: TeamAccount): void;
    deleteTeamAccount(id: string): void;
    /** A stable id for this server, for sign-ins that identify the installation (ChatGPT). */
    deviceId(): string;
}

const MAX_NAME = 40;
/** The options a pi-phone's request may carry: how the model answers, never where to or with what credential. */
const RELAYED = ["temperature", "samplingParams", "maxTokens", "cacheRetention", "sessionId", "metadata", "toolChoice", "reasoning", "thinkingBudgets"] as const;
/** How long a finished sign-in's steps wait to be fetched. */
const FLOW_KEPT_MS = 10 * 60_000;

export const TEAM_SEPARATOR = "~team-";

/** Whether a provider id is a team account's. */
export const isTeamAccount = (id: string) => id.includes(TEAM_SEPARATOR);

function checkName(name: unknown): string {
    const label = typeof name === "string" ? name.trim() : "";

    if (label === "" || label.length > MAX_NAME) {
        throw new HttpError(400, `A name is 1 to ${MAX_NAME} characters.`);
    }

    return label;
}

export class TeamAccounts {
    readonly #rows: TeamAccountRows;
    readonly #dir: string;
    readonly #now: () => number;
    #runtime: ModelRuntime | undefined;
    readonly #flows = new Map<string, Flow>();

    /** The team subscriptions' plan limits (PP-74), asked with their sign-ins here; kept a minute. */
    readonly #usage: UsageLimits;
    /** Claude Code's version for the billing patch and the usage endpoint: the last caller's setting (`phone.json`). */
    #claudeVersion = DEFAULT_SETTINGS.claudeCodeBilling.version;

    constructor(rows: TeamAccountRows, dataDir: string, now: () => number = Date.now, usageFetch?: typeof fetch) {
        this.#rows = rows;
        this.#dir = join(dataDir, "team-providers");
        this.#now = now;
        this.#usage = new UsageLimits({
            models: () => this.runtime,
            claudeVersion: () => this.#claudeVersion,
            publish: () => undefined,
            authPath: join(this.#dir, "auth.json"),
            now,
            ...(usageFetch === undefined ? {} : { fetch: usageFetch }),
        });
    }

    /** The plan limits of these team accounts that have them (a subscription of Claude, Codex or Copilot). */
    async usage(ids: readonly string[], fresh: boolean): Promise<AccountUsage[]> {
        const found = await Promise.all(ids.map((id) => this.#usage.get(id, fresh)));

        return found.filter((each): each is AccountUsage => each !== undefined);
    }

    /** An answer on `id` ended: its figures are asked again, at most once a minute. */
    answered(id: string): void {
        this.#usage.afterRun(id);
    }

    /** The gateway's own model runtime, with the team's sign-ins only; each team account registered on it. */
    async open(runtime?: ModelRuntime): Promise<void> {
        mkdirSync(this.#dir, { recursive: true, mode: 0o700 });
        this.#runtime =
            runtime ??
            (await ModelRuntime.create({
                authPath: join(this.#dir, "auth.json"),
                modelsPath: null,
                modelsStorePath: join(this.#dir, "models-store.json"),
            }));

        for (const account of this.#rows.teamAccounts()) {
            this.#register(account);
        }

        await this.#runtime.getAvailable().catch(() => []);
    }

    get runtime(): ModelRuntime {
        if (this.#runtime === undefined) {
            throw new Error("Team accounts are not open yet.");
        }

        return this.#runtime;
    }

    /** The provider a team account is made from: a new instance for the subscription ones, else the runtime's own. */
    #base(provider: string): Provider {
        const make = ACCOUNT_PROVIDERS[provider];
        const base = make === undefined ? this.runtime.getProvider(provider) : make();

        if (base === undefined || isTeamAccount(provider) || provider.includes("~")) {
            throw new HttpError(400, `No provider ${provider} here.`);
        }

        return base;
    }

    #register(account: TeamAccount): void {
        // The name a model menu shows after the provider's: "Team Work" (`<provider> · Team Work account`).
        this.runtime.registerNativeProvider(accountProvider(this.#base(account.provider), account.id, `Team ${account.name}`));
    }

    get(id: string): TeamAccount | undefined {
        return this.#rows.teamAccounts().find((account) => account.id === id);
    }

    /** Every team account, with what its sign-in can do and whether it is signed in. */
    list() {
        const rows = this.#rows.teamAccounts();

        // None made yet: nothing to ask the runtime about.
        if (rows.length === 0) {
            return [];
        }

        const runtime = this.runtime;

        return rows.map((account) => {
            const provider = runtime.getProvider(account.id);
            const auth = (provider as { auth?: { apiKey?: unknown; oauth?: { name?: string; loginLabel?: string } } } | undefined)?.auth;
            const status = runtime.getProviderAuthStatus(account.id);

            return {
                ...account,
                providerName: runtime.getProvider(account.provider)?.name ?? account.provider,
                configured: status.configured,
                oauth: runtime.isUsingOAuth(account.id),
                // What it can be signed in with: the provider's own subscription sign-in, an API key, or both.
                signIn: {
                    oauth: auth?.oauth === undefined ? null : (auth.oauth.loginLabel ?? auth.oauth.name ?? "Subscription"),
                    apiKey: auth?.apiKey !== undefined,
                },
                models: runtime.getModels(account.id).length,
            };
        });
    }

    /** A new team account of `provider`, named `name`: registered at once, then signed in from a Providers sheet. */
    add(provider: unknown, name: unknown, by: string): TeamAccount {
        if (typeof provider !== "string" || provider === "") {
            throw new HttpError(400, "Say which provider.");
        }

        const label = checkName(name);

        this.#base(provider);
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "account";
        let id = `${provider}${TEAM_SEPARATOR}${slug}`;

        for (let n = 2; this.get(id) !== undefined || this.runtime.getProvider(id) !== undefined; n++) {
            id = `${provider}${TEAM_SEPARATOR}${slug}-${n}`;
        }

        const account: TeamAccount = { id, provider, name: label, createdAt: this.#now(), createdBy: by };

        this.#register(account);
        this.#rows.saveTeamAccount(account);

        return account;
    }

    rename(id: string, name: unknown): TeamAccount {
        const account = this.#need(id);
        const renamed = { ...account, name: checkName(name) };

        this.#rows.saveTeamAccount(renamed);
        this.#register(renamed);

        return renamed;
    }

    /** Signed out and gone: its sign-in deleted, and its provider with it. */
    async remove(id: string): Promise<void> {
        this.#need(id);
        await this.runtime.logout(id).catch(() => undefined);
        this.runtime.unregisterProvider(id);
        this.#rows.deleteTeamAccount(id);
    }

    async logout(id: string): Promise<void> {
        this.#need(id);
        await this.runtime.logout(id);
    }

    #need(id: string): TeamAccount {
        const account = this.get(id);

        if (account === undefined) {
            throw new HttpError(404, "No such team account.");
        }

        return account;
    }

    // ─── Its models, used through the gateway (S2) ───

    /** A team account's models, as its people's pi-phones list them. */
    models(id: string): readonly Model<Api>[] {
        this.#need(id);

        return this.runtime.getModels(id);
    }

    /**
     * One answer of a team account's model, with its sign-in: the gateway's own copy of the model, and only the options a
     * pi-phone may set (`RELAYED`), so what it sends cannot change where the request goes or what it carries.
     */
    /**
     * One answer of a team account's model. `billing` is the caller's Claude Code billing setting: a Claude subscription's
     * requests get the patch here, where they are made (the caller's own `onPayload` can't come along).
     */
    stream(id: string, modelId: string, context: Context, given: Record<string, unknown>, signal: AbortSignal, billing?: { enabled: boolean; version: string }): AssistantMessageEventStream {
        this.#need(id);
        const model = this.runtime.getModel(id, modelId);

        if (model === undefined) {
            throw new HttpError(404, `The team account has no model ${modelId}.`);
        }

        const options: SimpleStreamOptions = { signal };

        for (const key of RELAYED) {
            if (given[key] !== undefined) {
                (options as Record<string, unknown>)[key] = given[key];
            }
        }

        if (billing?.enabled === true && /^\d+\.\d+\.\d+$/.test(billing.version)) {
            const version = billing.version;

            this.#claudeVersion = version;
            options.onPayload = (payload, requestModel) => patchClaudeCodePayload(payload, baseProvider(requestModel.provider), { version });
        }

        return this.runtime.streamSimple(model, context, options);
    }

    // ─── Signing in, from a person's Providers sheet ───

    /** Start a sign-in of a team account, for `userId`: its steps wait in `wait`. */
    startLogin(id: string, userId: string, type: "oauth" | "api_key"): string {
        this.#need(id);

        const flow: Flow = { id: randomUUID(), account: id, userId, steps: [], waiters: new Set(), prompts: new Map(), abort: new AbortController(), done: false };
        const push = (step: FlowStep) => {
            flow.steps.push(step);

            for (const wake of flow.waiters) {
                wake();
            }

            flow.waiters.clear();
        };
        let lastPromptType: AuthPrompt["type"] | undefined;

        this.#flows.set(flow.id, flow);

        const interaction = {
            signal: flow.abort.signal,
            prompt: (prompt: AuthPrompt) =>
                new Promise<string>((resolve, reject) => {
                    const promptId = randomUUID();
                    const { signal, ...shown } = prompt;

                    lastPromptType = prompt.type;
                    flow.prompts.set(promptId, { resolve, reject, requiresKey: type === "api_key" && prompt.type === "secret" });
                    signal?.addEventListener("abort", () => {
                        flow.prompts.delete(promptId);
                        push({ step: "prompt-closed", promptId });
                        reject(new Error("cancelled"));
                    });
                    push({ step: "prompt", promptId, prompt: shown as Omit<AuthPrompt, "signal"> });
                }),
            notify: (event: unknown) => push({ step: "event", event }),
        };

        void this.runtime
            .login(id, type, interaction as never, { getDeviceId: () => this.#rows.deviceId() })
            .then(
                async () => {
                    await this.runtime.getAvailable(id).catch(() => []);
                    push({ step: "done", ok: true, loginType: type });
                },
                (error: unknown) =>
                    push({
                        step: "done",
                        ok: false,
                        loginType: type,
                        error: type === "oauth" && lastPromptType === "manual_code" ? "That code was not accepted." : "Sign-in did not finish. Try again.",
                        details: error instanceof Error ? error.message : String(error),
                    }),
            )
            .finally(() => {
                flow.done = true;
                setTimeout(() => this.#flows.delete(flow.id), FLOW_KEPT_MS).unref();
            });

        return flow.id;
    }

    /** The steps of a sign-in after the first `after`, as soon as there are any (or none after `waitMs`). */
    async wait(flowId: string, userId: string, after: number, waitMs = 25_000): Promise<{ steps: FlowStep[]; done: boolean }> {
        const flow = this.#flow(flowId, userId);

        if (flow.steps.length <= after && !flow.done) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, waitMs);

                flow.waiters.add(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }

        return { steps: flow.steps.slice(after), done: flow.done && flow.steps.length > 0 && flow.steps.at(-1)!.step === "done" };
    }

    answer(flowId: string, userId: string, promptId: string, value: string | undefined): void {
        const flow = this.#flow(flowId, userId);
        const prompt = flow.prompts.get(promptId);

        if (prompt === undefined) {
            throw new HttpError(404, "No such prompt");
        }

        if (prompt.requiresKey && value !== undefined && value.trim() === "") {
            throw new HttpError(400, "Enter an API key.");
        }

        flow.prompts.delete(promptId);

        if (value === undefined) {
            prompt.reject(new Error("cancelled"));
            flow.abort.abort();
        } else {
            prompt.resolve(value);
        }
    }

    cancel(flowId: string, userId: string): void {
        const flow = this.#flows.get(flowId);

        if (flow !== undefined && flow.userId === userId) {
            flow.abort.abort();
        }
    }

    #flow(flowId: string, userId: string): Flow {
        const flow = this.#flows.get(flowId);

        if (flow === undefined || flow.userId !== userId) {
            throw new HttpError(404, "No such sign-in");
        }

        return flow;
    }
}
