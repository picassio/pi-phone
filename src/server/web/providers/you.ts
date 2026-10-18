/**
 * You.com's Web Search API (https://you.com/docs/guides/search, `POST ydc-index.io/v1/search`), with the key in
 * `X-API-Key`. Recency is `freshness` (`day` … `year`); domains are `include_domains` / `exclude_domains`. The snippet
 * is the description, else the first of the result's snippets. Each request uses You.com API credits. Ported from
 * pi-web-access's `you.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const provider: SearchProvider = {
    id: "you",
    name: "You.com",
    site: "https://you.com/platform/api-keys",
    key: { kind: "secret", secret: "YDC_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("You.com", "https://ydc-index.io/v1/search", {
            body: {
                query: search.query,
                count: search.numResults,
                ...(search.recency ? { freshness: search.recency } : {}),
                ...(include.length > 0 ? { include_domains: include } : {}),
                ...(exclude.length > 0 ? { exclude_domains: exclude } : {}),
            },
            headers: { "x-api-key": `${key}` },
            signal: search.signal,
            key,
        })) as { results?: { web?: unknown } };

        if (!Array.isArray(answer.results?.web)) {
            throw new ProviderError("You.com", "answered without results.web");
        }

        return {
            results: tidy(
                (answer.results.web as { url?: unknown; title?: unknown; description?: unknown; snippets?: unknown; page_age?: unknown }[]).map((result, index) => ({
                    title: clip(result.title, 200) || `Source ${index + 1}`,
                    url: typeof result.url === "string" ? result.url : "",
                    snippet: clip(result.description) || (Array.isArray(result.snippets) ? clip(result.snippets[0]) : ""),
                    ...(typeof result.page_age === "string" ? { date: result.page_age } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
