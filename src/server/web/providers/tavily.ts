/**
 * Tavily's Search API (https://docs.tavily.com/documentation/api-reference/endpoint/search): pages with the content
 * that answers the query, and a short written answer, with a Tavily API key. It takes the count, a time range by name
 * (`day`, `week`, …), and domains to keep to and leave out. Basic depth, no raw page content. Ported from
 * pi-web-access's `tavily.ts` (MIT), without its pool of numbered keys and its gateway address.
 */
import { clip, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const provider: SearchProvider = {
    id: "tavily",
    name: "Tavily",
    site: "https://app.tavily.com/",
    key: { kind: "secret", secret: "TAVILY_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("Tavily", "https://api.tavily.com/search", {
            body: {
                query: search.query,
                search_depth: "basic",
                max_results: search.numResults,
                include_answer: "basic",
                include_raw_content: false,
                ...(search.recency ? { time_range: search.recency } : {}),
                ...(include.length > 0 ? { include_domains: include } : {}),
                ...(exclude.length > 0 ? { exclude_domains: exclude } : {}),
            },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { answer?: unknown; results?: { title?: unknown; url?: unknown; content?: unknown; published_date?: unknown }[] };

        return {
            ...(typeof answer.answer === "string" && answer.answer.trim() !== "" ? { answer: answer.answer.trim() } : {}),
            results: tidy(
                (answer.results ?? []).map((result) => ({
                    title: clip(result.title, 200) || String(result.url ?? ""),
                    url: String(result.url ?? ""),
                    snippet: clip(result.content),
                    ...(typeof result.published_date === "string" ? { date: result.published_date } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
