/**
 * Firecrawl's search (https://docs.firecrawl.dev/api-reference/endpoint/search): `POST <address>/v2/search` with
 * `sources: ["web"]` and `limit`, on Firecrawl's cloud (https://api.firecrawl.dev, with a key) or a self-hosted server
 * (key optional). The address has no default: the person sets which one. Recency is Google's `tbs` (`qdr:d` …); domains
 * are `includeDomains`, or `excludeDomains` when none are kept to, and the answer is kept to them too. The envelope's
 * `success` must be true. Search only: Firecrawl's page scraping is not used here. Ported from pi-web-access's
 * `firecrawl.ts` (MIT), API v2 only, without its v1 setting, its SSRF guard, and its scrape options.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const TBS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

/** Whether `url`'s host is one of `include` (when any) and none of `exclude`, subdomains included. */
function within(url: string, include: readonly string[], exclude: readonly string[]): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return !exclude.some(matches) && (include.length === 0 || include.some(matches));
}

/** The server's base address, without a trailing slash, query, or credentials; only http(s). */
function base(address: string | undefined): string {
    if (address === undefined || address.trim() === "") {
        throw new ProviderError("Firecrawl", "no address is set; set https://api.firecrawl.dev or your own server in Settings › Web access");
    }

    let url: URL;

    try {
        url = new URL(address.trim());
    } catch {
        throw new ProviderError("Firecrawl", `the address "${address}" is not a URL; set an http(s) address in Settings › Web access`);
    }

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
        throw new ProviderError("Firecrawl", "the address must be http(s), without a user name or password; set it in Settings › Web access");
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The first non-blank text among `values`. */
const first = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim() !== "")?.trim();

interface Item {
    title?: unknown;
    description?: unknown;
    snippet?: unknown;
    url?: unknown;
    metadata?: { title?: unknown; description?: unknown; sourceURL?: unknown; url?: unknown };
}

const provider: SearchProvider = {
    id: "firecrawl",
    name: "Firecrawl",
    site: "https://www.firecrawl.dev/app/api-keys",
    key: { kind: "secret", secret: "FIRECRAWL_API_KEY", optional: true },
    endpoint: { label: "Firecrawl address (https://api.firecrawl.dev, or your own server)" },
    async search(search, { key, endpoint }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("Firecrawl", `${base(endpoint)}/v2/search`, {
            body: {
                query: search.query,
                limit: search.numResults,
                sources: ["web"],
                ...(include.length > 0 ? { includeDomains: include } : exclude.length > 0 ? { excludeDomains: exclude } : {}),
                ...(search.recency ? { tbs: TBS[search.recency] } : {}),
            },
            headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { success?: unknown; error?: unknown; data?: unknown };

        if (answer.success !== true) {
            throw new ProviderError("Firecrawl", `the search did not succeed: ${clip(first(answer.error) ?? "no reason given", 300)}`);
        }

        // v2 answers `data: { web: [...] }`; older servers a bare list.
        const web = Array.isArray(answer.data) ? answer.data : typeof answer.data === "object" && answer.data !== null ? (answer.data as { web?: unknown }).web : undefined;

        if (!Array.isArray(web)) {
            throw new ProviderError("Firecrawl", "answered without a list of web results");
        }

        return {
            results: tidy(
                (web as Item[])
                    .map((item) => {
                        const url = first(item.url, item.metadata?.sourceURL, item.metadata?.url) ?? "";

                        return {
                            title: clip(first(item.title, item.metadata?.title) ?? url, 200),
                            url,
                            snippet: clip(first(item.description, item.snippet, item.metadata?.description)),
                        };
                    })
                    .filter((result) => within(result.url, include, exclude)),
                search.numResults,
            ),
        };
    },
};

export default provider;
