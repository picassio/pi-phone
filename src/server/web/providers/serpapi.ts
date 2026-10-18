/**
 * SerpApi's Google Search API (https://serpapi.com/search-api): Google's organic results, with a SerpApi key in the
 * `api_key` parameter. Domains go into the query as `site:` operators (more than one in parentheses with `OR`) and are
 * checked again on the answer, asking for 5 more to make up for what that drops; recency is Google's `tbs`. Each search
 * uses a SerpApi credit. Ported from pi-web-access's `serpapi.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider } from "../types.ts";

const TBS: Record<Recency, string> = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" };

/** Whether `url`'s host is one of `include` (when there are any) and none of `exclude`, subdomains included. */
function within(url: string, include: string[], exclude: string[]): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return (include.length === 0 || include.some(matches)) && !exclude.some(matches);
}

/** The query with Google's site operators: `site:a`, or `(site:a OR site:b)`, then `-site:c`. */
function googleQuery(query: string, include: string[], exclude: string[]): string {
    return [
        query,
        include.length === 1 ? `site:${include[0]}` : include.length > 1 ? `(${include.map((domain) => `site:${domain}`).join(" OR ")})` : "",
        ...exclude.map((domain) => `-site:${domain}`),
    ]
        .filter((part) => part !== "")
        .join(" ");
}

const provider: SearchProvider = {
    id: "serpapi",
    name: "SerpApi",
    site: "https://serpapi.com/manage-api-key",
    key: { kind: "secret", secret: "SERPAPI_KEY" },
    price: "1 search credit per search",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const filtered = include.length + exclude.length > 0;
        const url = new URL("https://serpapi.com/search.json");

        url.searchParams.set("engine", "google");
        url.searchParams.set("q", googleQuery(search.query, include, exclude));
        url.searchParams.set("api_key", `${key}`);
        url.searchParams.set("num", String(filtered ? Math.min(20, search.numResults + 5) : search.numResults));

        if (search.recency) {
            url.searchParams.set("tbs", TBS[search.recency]);
        }

        const answer = (await request("SerpApi", url.toString(), { signal: search.signal, key })) as { error?: unknown; organic_results?: unknown };

        if (typeof answer.error === "string" && answer.error.trim() !== "") {
            throw new ProviderError("SerpApi", answer.error.trim());
        }

        if (!Array.isArray(answer.organic_results)) {
            throw new ProviderError("SerpApi", "answered without organic results");
        }

        return {
            results: tidy(
                (answer.organic_results as { title?: unknown; link?: unknown; snippet?: unknown; date?: unknown }[])
                    .filter((result) => typeof result.link === "string" && within(result.link, include, exclude))
                    .map((result) => ({
                        title: clip(result.title, 200) || String(result.link),
                        url: String(result.link),
                        snippet: clip(result.snippet),
                        ...(typeof result.date === "string" ? { date: result.date } : {}),
                    })),
                search.numResults,
            ),
        };
    },
};

export default provider;
