/**
 * Web search providers for `web_search` (`extensions/web.ts`): one file each in `providers/`, ported from pi-web-access
 * (MIT, nicobailon/pi-web-access) to this one shape. The person picks one in Settings › Web access; there is no
 * fallback to another, and a provider's failure says what it was, naming the setting to change.
 */

export type Recency = "day" | "week" | "month" | "year";

export interface SearchRequest {
    query: string;
    /** 1 to 20. */
    numResults: number;
    recency?: Recency;
    /** Domains to keep to, and with a leading `-`, to leave out: `["github.com", "-reddit.com"]`. */
    domains?: readonly string[];
    signal: AbortSignal;
}

export interface SearchResult {
    title: string;
    url: string;
    /** What the page says about the query, for the model: a summary or a snippet, a few hundred characters at most. */
    snippet: string;
    /** When it was published, as the provider gives it (ISO when it can be). */
    date?: string;
}

export interface SearchResponse {
    /** A written answer, for providers that give one (Perplexity, OpenAI, Gemini, …). */
    answer?: string;
    results: SearchResult[];
}

/** What a search runs with: the key, from the place `SearchProvider.key` names, and the address the person set. */
export interface Credentials {
    key?: string;
    endpoint?: string;
}

/** Where a provider's key comes from: nowhere, a secret in Settings › Secrets, or a Pi sign-in in Settings › Providers. */
export type KeySource =
    | { kind: "none" }
    | { kind: "secret"; secret: string; optional?: boolean }
    | { kind: "pi"; provider: string };

export interface SearchProvider {
    /** pi-web-access's name for it, as its `provider` argument: `brave`, `deepseek`, … */
    readonly id: string;
    /** As people know it: "Brave Search". */
    readonly name: string;
    /** Where to learn about it and get a key. */
    readonly site: string;
    readonly key: KeySource;
    /** An address the person sets (a self-hosted SearXNG), with its default if it has one. */
    readonly endpoint?: { label: string; default?: string };
    /** One short line on what it costs or its free tier, for the picker. */
    readonly price?: string;
    search(request: SearchRequest, credentials: Credentials): Promise<SearchResponse>;
}
