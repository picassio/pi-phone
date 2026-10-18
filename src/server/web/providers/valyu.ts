/**
 * Valyu's Search API (https://docs.valyu.ai, `POST api.valyu.ai/v1/search`): research search over the web and
 * proprietary sources, with the key in `x-api-key`. Domains are `included_sources` / `excluded_sources`; recency is
 * `start_date` (YYYY-MM-DD). Each result carries the page's content, whose start is the snippet. The envelope's
 * `success` must be true. Ported from pi-web-access's `valyu.ts` (MIT).
 */
import { clip, ProviderError, request, since, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const provider: SearchProvider = {
    id: "valyu",
    name: "Valyu",
    site: "https://platform.valyu.ai",
    key: { kind: "secret", secret: "VALYU_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("Valyu", "https://api.valyu.ai/v1/search", {
            body: {
                query: search.query,
                max_num_results: search.numResults,
                ...(include.length > 0 ? { included_sources: include } : {}),
                ...(exclude.length > 0 ? { excluded_sources: exclude } : {}),
                ...(search.recency ? { start_date: since(search.recency) } : {}),
            },
            headers: { "x-api-key": `${key}` },
            signal: search.signal,
            key,
        })) as { success?: unknown; error?: unknown; results?: unknown };

        if (answer.success !== true || !Array.isArray(answer.results)) {
            throw new ProviderError("Valyu", `the search did not succeed: ${clip(answer.error, 300) || "no results list"}`);
        }

        return {
            results: tidy(
                (answer.results as { title?: unknown; url?: unknown; description?: unknown; content?: unknown }[]).map((result, index) => ({
                    title: clip(result.title, 200) || `Source ${index + 1}`,
                    url: typeof result.url === "string" ? result.url.trim() : "",
                    snippet: clip(result.content, 800) || clip(result.description, 800),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
