/**
 * Search1API's Search (https://www.search1api.com/docs/basic/search): Google-like results with snippets, with a
 * Search1API key. It takes the count, include and exclude sites, and a time range by name (`day`, `week`, …). Deep
 * Search (`crawl_results`) is never asked for: it costs a credit per page. Ported from pi-web-access's `search1api.ts`
 * (MIT), search only.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const provider: SearchProvider = {
    id: "search1api",
    name: "Search1API",
    site: "https://dashboard.search1api.com",
    key: { kind: "secret", secret: "SEARCH1API_KEY" },
    price: "1 credit per search",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("Search1API", "https://api.search1api.com/search", {
            body: {
                query: search.query,
                max_results: search.numResults,
                crawl_results: 0,
                ...(include.length > 0 ? { include_sites: include } : {}),
                ...(exclude.length > 0 ? { exclude_sites: exclude } : {}),
                ...(search.recency ? { time_range: search.recency } : {}),
            },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { results?: unknown };

        if (!Array.isArray(answer.results)) {
            throw new ProviderError("Search1API", "answered without a result list");
        }

        return {
            results: tidy(
                (answer.results as { title?: unknown; link?: unknown; snippet?: unknown }[]).map((result) => ({
                    title: clip(result.title, 200) || String(result.link ?? "").trim(),
                    url: String(result.link ?? "").trim(),
                    snippet: clip(result.snippet),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
