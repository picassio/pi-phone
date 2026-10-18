/**
 * Perplexity's Search API (https://docs.perplexity.ai/guides/search-quickstart): ranked pages with snippets, no written
 * answer, with a Perplexity API key. It takes the count, a recency filter, and a domain list where `-domain` leaves one
 * out. Ported from pi-web-access's `perplexity.ts` (MIT), without its client-side limit of 10 searches a minute.
 */
import { clip, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

/** A domain as Perplexity's filter takes it. */
const DOMAIN = /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/;

const provider: SearchProvider = {
    id: "perplexity",
    name: "Perplexity",
    site: "https://perplexity.ai/settings/api",
    key: { kind: "secret", secret: "PERPLEXITY_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const domains = [...include.filter((domain) => DOMAIN.test(domain)), ...exclude.filter((domain) => DOMAIN.test(domain)).map((domain) => `-${domain}`)];
        const answer = (await request("Perplexity", "https://api.perplexity.ai/search", {
            body: {
                query: search.query,
                max_results: search.numResults,
                search_type: "fast",
                search_context_size: "medium",
                ...(search.recency ? { search_recency_filter: search.recency } : {}),
                ...(domains.length > 0 ? { search_domain_filter: domains } : {}),
            },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { results?: { title?: unknown; url?: unknown; snippet?: unknown; date?: unknown }[] };

        return {
            results: tidy(
                (answer.results ?? []).map((result) => ({
                    title: clip(result.title, 200) || String(result.url ?? ""),
                    url: String(result.url ?? ""),
                    snippet: clip(result.snippet),
                    ...(typeof result.date === "string" ? { date: result.date } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
