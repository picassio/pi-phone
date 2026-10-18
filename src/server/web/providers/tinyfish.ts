/**
 * TinyFish's Search API (https://docs.tinyfish.ai/search-api/reference): a GET with the query, domains to keep to and
 * leave out, and recency in minutes, with a TinyFish API key in `X-API-Key`. A page holds 10 results, so more than 10
 * takes a second page, unless the first came back short. Ported from pi-web-access's `tinyfish.ts` (MIT), search only.
 */
import { clip, ProviderError, RECENCY_DAYS, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchRequest, SearchResult } from "../types.ts";

const SEARCH_URL = "https://api.search.tinyfish.ai";
const PAGE_SIZE = 10;

function pageUrl(search: SearchRequest, page: number): string {
    const { include, exclude } = splitDomains(search.domains);
    const params = new URLSearchParams({ query: search.query });

    if (include.length > 0) {
        params.set("include_domains", include.join(","));
    }

    if (exclude.length > 0) {
        params.set("exclude_domains", exclude.join(","));
    }

    if (search.recency) {
        params.set("recency_minutes", String(RECENCY_DAYS[search.recency] * 1_440));
    }

    if (page > 0) {
        params.set("page", String(page));
    }

    return `${SEARCH_URL}?${params.toString()}`;
}

const provider: SearchProvider = {
    id: "tinyfish",
    name: "TinyFish",
    site: "https://agent.tinyfish.ai/api-keys",
    key: { kind: "secret", secret: "TINYFISH_API_KEY" },
    price: "No credits; Free plan 30 searches a minute",
    async search(search, { key }) {
        const found: SearchResult[] = [];

        for (let page = 0; page < (search.numResults > PAGE_SIZE ? 2 : 1); page++) {
            const answer = (await request("TinyFish", pageUrl(search, page), { headers: { "x-api-key": `${key}` }, signal: search.signal, key })) as {
                results?: unknown;
            };

            if (!Array.isArray(answer.results)) {
                throw new ProviderError("TinyFish", "answered without a result list");
            }

            const results = answer.results as { title?: unknown; url?: unknown; snippet?: unknown; date?: unknown }[];

            found.push(
                ...results.map((result) => ({
                    title: clip(result.title, 200) || String(result.url ?? "").trim(),
                    url: String(result.url ?? "").trim(),
                    snippet: clip(result.snippet),
                    ...(typeof result.date === "string" && result.date !== "" ? { date: result.date } : {}),
                })),
            );

            if (results.length < PAGE_SIZE) {
                break;
            }
        }

        return { results: tidy(found, search.numResults) };
    },
};

export default provider;
