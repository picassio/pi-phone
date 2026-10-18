/**
 * Web access: which search provider `web_search` uses, as the owner picked it in Settings › Web access, and its key from
 * the one place that provider's key lives: a Pi sign-in (Settings › Providers) for model providers, a secret
 * (Settings › Secrets) for the rest. No pick, no key, or no address: web search says which setting to change. There is
 * never a fallback to another provider.
 */
import type { ConfigStore } from "../config.ts";
import type { Secrets } from "../secrets.ts";
import { PROVIDERS } from "./providers/index.ts";
import type { Credentials, Recency, SearchProvider, SearchResponse } from "./types.ts";

/** A provider as Settings › Web access shows it: what it needs, and whether that is there. */
export type ProviderInfo = {
    id: string;
    name: string;
    site: string;
    price?: string;
    key: SearchProvider["key"];
    endpoint?: { label: string; default?: string; value?: string };
    /** Why it cannot search yet, or undefined when it can. */
    missing?: string;
};

export class WebSearch {
    readonly #config: ConfigStore;
    readonly #secrets: Secrets;
    readonly #piKey: (provider: string) => Promise<string | undefined>;
    readonly #providers: ReadonlyMap<string, SearchProvider>;

    constructor(
        config: ConfigStore,
        secrets: Secrets,
        piKey: (provider: string) => Promise<string | undefined>,
        providers: readonly SearchProvider[] = PROVIDERS,
    ) {
        this.#config = config;
        this.#secrets = secrets;
        this.#piKey = piKey;
        this.#providers = new Map(providers.map((provider) => [provider.id, provider]));
    }

    /** The picked provider's id, or undefined while web search is off. */
    get provider(): string | undefined {
        return this.#config.web.provider;
    }

    async providers(): Promise<ProviderInfo[]> {
        return Promise.all([...this.#providers.values()].map((provider) => this.#info(provider)));
    }

    /** Pick a provider (undefined: web search off), and set or clear self-hosted addresses. */
    set(change: { provider?: unknown; endpoints?: unknown }): void {
        const web = this.#config.web;

        if (change.provider !== undefined) {
            if (change.provider !== null && (typeof change.provider !== "string" || !this.#providers.has(change.provider))) {
                throw new Error(`No search provider ${String(change.provider)}`);
            }

            web.provider = change.provider ?? undefined;
        }

        if (change.endpoints !== undefined) {
            if (typeof change.endpoints !== "object" || change.endpoints === null) {
                throw new Error("endpoints are addresses by provider");
            }

            for (const [id, value] of Object.entries(change.endpoints)) {
                if (!this.#providers.get(id)?.endpoint) {
                    throw new Error(`${id} has no address to set`);
                }

                if (value === null || value === "") {
                    delete web.endpoints[id];
                } else if (typeof value !== "string" || !/^https?:\/\/\S+$/.test(value)) {
                    throw new Error(`${id}'s address is an http:// or https:// URL`);
                } else {
                    web.endpoints[id] = value.replace(/\/+$/, "");
                }
            }
        }

        this.#config.web = web;
    }

    /**
     * Search with the picked provider, or `provider` when Pi names one: one query, its results. A provider that is not
     * set up says which setting it needs.
     */
    async search(
        query: string,
        options: { numResults: number; recency?: Recency; domains?: readonly string[]; provider?: string; signal: AbortSignal },
    ): Promise<{ provider: SearchProvider; response: SearchResponse }> {
        const id = options.provider ?? this.provider;

        if (id === undefined) {
            throw new Error("Web search is off: the person picks a search provider in Settings › Web access.");
        }

        const provider = this.#providers.get(id);

        if (provider === undefined) {
            throw new Error(`No search provider ${id}. Providers: ${[...this.#providers.keys()].join(", ")}.`);
        }

        const credentials = await this.#credentials(provider);
        const response = await provider.search(
            {
                query,
                numResults: Math.max(1, Math.min(20, Math.round(options.numResults))),
                ...(options.recency === undefined ? {} : { recency: options.recency }),
                ...(options.domains === undefined || options.domains.length === 0 ? {} : { domains: options.domains }),
                signal: options.signal,
            },
            credentials,
        );

        return { provider, response };
    }

    /** The key and address a provider searches with, or an error naming the setting that lacks them. */
    async #credentials(provider: SearchProvider): Promise<Credentials> {
        const info = await this.#info(provider);

        if (info.missing !== undefined) {
            throw new Error(`${provider.name} is not set up: ${info.missing}`);
        }

        const key = await this.#key(provider);
        const endpoint = this.#config.web.endpoints[provider.id] ?? provider.endpoint?.default;

        return { ...(key === undefined ? {} : { key }), ...(endpoint === undefined ? {} : { endpoint }) };
    }

    async #key(provider: SearchProvider): Promise<string | undefined> {
        switch (provider.key.kind) {
            case "none":
                return undefined;
            case "pi":
                return this.#piKey(provider.key.provider);
            case "secret":
                return this.#secrets.has(provider.key.secret) ? this.#secrets.value(provider.key.secret) : undefined;
        }
    }

    async #info(provider: SearchProvider): Promise<ProviderInfo> {
        const set = this.#config.web.endpoints[provider.id];
        const key = await this.#key(provider);
        let missing: string | undefined;

        if (provider.key.kind === "pi" && key === undefined) {
            missing = `sign in to ${provider.key.provider} in Settings › Providers`;
        } else if (provider.key.kind === "secret" && key === undefined && provider.key.optional !== true) {
            missing = `add the secret ${provider.key.secret} in Settings › Secrets`;
        } else if (provider.endpoint !== undefined && set === undefined && provider.endpoint.default === undefined) {
            missing = `set its ${provider.endpoint.label} in Settings › Web access`;
        }

        return {
            id: provider.id,
            name: provider.name,
            site: provider.site,
            ...(provider.price === undefined ? {} : { price: provider.price }),
            key: provider.key,
            ...(provider.endpoint === undefined ? {} : { endpoint: { ...provider.endpoint, ...(set === undefined ? {} : { value: set }) } }),
            ...(missing === undefined ? {} : { missing }),
        };
    }
}
