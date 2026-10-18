/**
 * Parallel's Search API (https://docs.parallel.ai/search/search-quickstart): an objective plus search queries, answered
 * with pages and the excerpts of each that bear on the objective, with a Parallel API key in `x-api-key`. Domains and
 * recency go to its `source_policy`. Ported from pi-web-access's `parallel.ts` (MIT).
 */
import { clip, request, since, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const provider: SearchProvider = {
    id: "parallel",
    name: "Parallel",
    site: "https://platform.parallel.ai",
    key: { kind: "secret", secret: "PARALLEL_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const policy = {
            ...(include.length > 0 ? { include_domains: include } : {}),
            ...(exclude.length > 0 ? { exclude_domains: exclude } : {}),
            ...(search.recency ? { after_date: since(search.recency) } : {}),
        };
        const answer = (await request("Parallel", "https://api.parallel.ai/v1/search", {
            body: {
                objective: search.query,
                search_queries: [search.query],
                advanced_settings: { max_results: search.numResults, ...(Object.keys(policy).length > 0 ? { source_policy: policy } : {}) },
            },
            headers: { "x-api-key": `${key}` },
            signal: search.signal,
            key,
        })) as { results?: { url?: unknown; title?: unknown; publish_date?: unknown; excerpts?: unknown }[] };

        return {
            results: tidy(
                (answer.results ?? []).map((result) => ({
                    title: clip(result.title, 200) || String(result.url ?? ""),
                    url: String(result.url ?? ""),
                    // The excerpts are what Parallel picked for the objective: all of them, as far as they fit.
                    snippet: clip(
                        (Array.isArray(result.excerpts) ? result.excerpts : []).filter((excerpt): excerpt is string => typeof excerpt === "string").join(" "),
                    ),
                    ...(typeof result.publish_date === "string" ? { date: result.publish_date } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
