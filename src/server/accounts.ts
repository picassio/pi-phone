/**
 * More than one account of a subscription provider (owner's decisions of 2026-10-19, wiki: provider-accounts-and-usage).
 * Each extra account is a provider of its own beside the original, `anthropic~work` beside `anthropic`: a new instance
 * of the provider (pi-ai's factory), with the same sign-in flows, its models carrying the account's id, and requests
 * handed to that instance with the original id, so the provider's own code (Claude's sign-in identity, Copilot's
 * request shape) sees what it always does. Pi's runtime keeps the account's sign-in under its id (`auth.json`), so a
 * session's model picks the account, and everything that follows the session's model (subagents, titles, schedules,
 * runs that outlive a restart) uses that account too.
 *
 * The original stays the default account: its sign-in is never moved, renamed, or touched here. An account's id is
 * fixed once made (sessions refer to it); renaming changes its name only. `accounts.json` in the data folder holds them,
 * and they are registered as the app opens, before any session resumes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HttpError } from "./errors.ts";

export type Account = {
    /** The account's provider id: `<provider>~<slug>`. */
    id: string;
    /** The provider it is an account of. */
    provider: string;
    name: string;
    createdAt: number;
};

/** The providers that may have more than one account, by id: a new instance of each. */
export const ACCOUNT_PROVIDERS: Readonly<Record<string, () => Provider>> = {
    anthropic: () => anthropicProvider() as unknown as Provider,
    "openai-codex": () => openaiCodexProvider() as unknown as Provider,
    "github-copilot": () => githubCopilotProvider() as unknown as Provider,
};

const SEPARATOR = "~";
const FILE = "accounts.json";
const MAX_NAME = 40;

/** The provider an account's id is of, or the id itself when it is no account's. */
export function baseProvider(providerId: string): string {
    const at = providerId.indexOf(SEPARATOR);

    return at === -1 ? providerId : providerId.slice(0, at);
}

/**
 * A provider for an account: `base` (a new instance) under `id`, its name with the account's, its models labelled with
 * `id`, and each request handed to `base` with the model's own provider id again. Credentials are not here: the runtime
 * resolves the account's own and passes them in the request's options.
 */
export function accountProvider(base: Provider, id: string, name: string): Provider {
    const label = <T extends { provider: string }>(model: T): T => ({ ...model, provider: id });
    const unlabel = <T extends { provider: string }>(model: T): T => ({ ...model, provider: base.id });

    return {
        id,
        name: `${base.name} · ${name}`,
        ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
        ...(base.headers === undefined ? {} : { headers: base.headers }),
        auth: base.auth,
        getModels: () => base.getModels().map(label),
        ...(base.getAllModels === undefined ? {} : { getAllModels: () => base.getAllModels!().map(label) }),
        ...(base.refreshModels === undefined ? {} : { refreshModels: (context) => base.refreshModels!(context) }),
        ...(base.filterModels === undefined
            ? {}
            : { filterModels: (models, credential) => base.filterModels!(models.map(unlabel), credential).map(label) }),
        ...(base.filterAllModels === undefined
            ? {}
            : {
                  filterAllModels: (models, credential) =>
                      base.filterAllModels!(models.map(unlabel), credential).map(label),
              }),
        stream: (model, context, options) => base.stream(unlabel(model), context, options),
        streamSimple: (model: Model<Api>, context, options) => base.streamSimple(unlabel(model), context, options),
        ...(base.fetchDeferred === undefined
            ? {}
            : { fetchDeferred: (model, handle, options) => base.fetchDeferred!(unlabel(model), handle, options) }),
        ...(base.cancelDeferred === undefined
            ? {}
            : { cancelDeferred: (model, handle, options) => base.cancelDeferred!(unlabel(model), handle, options) }),
    } as Provider;
}

export class Accounts {
    readonly #file: string;
    readonly #models: () => ModelRuntime;
    readonly #bases: Readonly<Record<string, () => Provider>>;
    #accounts: Account[];

    constructor(dataDir: string, models: () => ModelRuntime, bases = ACCOUNT_PROVIDERS) {
        this.#file = join(dataDir, FILE);
        this.#models = models;
        this.#bases = bases;
        this.#accounts = existsSync(this.#file)
            ? (JSON.parse(readFileSync(this.#file, "utf8")) as { accounts: Account[] }).accounts
            : [];
    }

    /** Each account as a provider: as the app opens, before any session resumes. */
    registerAll(): void {
        for (const account of this.#accounts) {
            this.#register(account);
        }
    }

    list(): Account[] {
        return this.#accounts.map((account) => ({ ...account }));
    }

    /** The providers that may have more accounts. */
    providers(): string[] {
        return Object.keys(this.#bases);
    }

    get(id: string): Account | undefined {
        return this.#accounts.find((account) => account.id === id);
    }

    /** A new account of `provider`, named `name`: registered at once, then signed in from the Providers sheet. */
    add(provider: unknown, name: unknown): Account {
        if (typeof provider !== "string" || this.#bases[provider] === undefined) {
            throw new HttpError(400, `Accounts are for ${Object.keys(this.#bases).join(", ")}.`);
        }

        const label = checkName(name);
        const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "account";
        let id = `${provider}${SEPARATOR}${slug}`;

        for (let n = 2; this.#models().getProvider(id) !== undefined || this.get(id) !== undefined; n++) {
            id = `${provider}${SEPARATOR}${slug}-${n}`;
        }

        const account: Account = { id, provider, name: label, createdAt: Date.now() };

        this.#register(account);
        this.#accounts.push(account);
        this.#save();

        return { ...account };
    }

    /** A new name; the id stays, as sessions refer to it. */
    rename(id: string, name: unknown): Account {
        const account = this.#require(id);

        account.name = checkName(name);
        this.#register(account);
        this.#save();

        return { ...account };
    }

    /** Sign the account out and forget it. Sessions on its models then show that they need a sign-in. */
    async remove(id: string): Promise<void> {
        this.#require(id);
        const models = this.#models();

        if (models.getProviderAuthStatus(id).configured) {
            await models.logout(id);
        }

        models.unregisterProvider(id);
        this.#accounts = this.#accounts.filter((each) => each.id !== id);
        this.#save();
    }

    #require(id: string): Account {
        const account = this.get(id);

        if (account === undefined) {
            throw new HttpError(404, "There is no such account.");
        }

        return account;
    }

    #register(account: Account): void {
        const make = this.#bases[account.provider];

        if (make === undefined) {
            throw new Error(`No provider ${account.provider} for the account ${account.name}`);
        }

        this.#models().registerNativeProvider(accountProvider(make(), account.id, account.name));
    }

    #save(): void {
        writeFileSync(this.#file, `${JSON.stringify({ accounts: this.#accounts }, null, 2)}\n`, { mode: 0o600 });
    }
}

function checkName(name: unknown): string {
    if (typeof name !== "string" || name.trim() === "") {
        throw new HttpError(400, "Name the account (for example Work).");
    }

    if (name.trim().length > MAX_NAME) {
        throw new HttpError(400, `An account's name is at most ${MAX_NAME} characters.`);
    }

    return name.trim();
}
