/**
 * SerpBase's Google Search API (https://serpbase.dev): Google's organic results, with a SerpBase key in the `api_key`
 * parameter. Domains go into the query as `site:` operators (more than one in parentheses with `OR`) and are checked
 * again on the answer; recency is Google's `tbs`. Each search uses paid SERP credits. Ported from pi-web-access's
 * `serpbase.ts` (MIT).
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

interface Organic {
    title?: unknown;
    link?: unknown;
    url?: unknown;
    snippet?: unknown;
    description?: unknown;
}

const provider: SearchProvider = {
    id: "serpbase",
    name: "SerpBase",
    site: "https://serpbase.dev",
    key: { kind: "secret", secret: "SERPBASE_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const url = new URL("https://api.serpbase.dev/google/search");

        url.searchParams.set("q", googleQuery(search.query, include, exclude));
        url.searchParams.set("api_key", `${key}`);
        url.searchParams.set("num", String(search.numResults));

        if (search.recency) {
            url.searchParams.set("tbs", TBS[search.recency]);
        }

        const answer = (await request("SerpBase", url.toString(), { signal: search.signal, key })) as {
            error?: unknown;
            status?: unknown;
            organic_results?: unknown;
            organic?: unknown;
            results?: unknown;
        };

        if (typeof answer.error === "string" && answer.error.trim() !== "") {
            throw new ProviderError("SerpBase", `${answer.error.trim()}${typeof answer.status === "number" || typeof answer.status === "string" ? ` (status ${answer.status})` : ""}`);
        }

        // SerpBase names the list as SerpApi does, as Serper does, or plainly; pi-web-access reads all three.
        const organic = answer.organic_results ?? answer.organic ?? answer.results;

        if (!Array.isArray(organic)) {
            throw new ProviderError("SerpBase", "answered without organic results");
        }

        return {
            results: tidy(
                (organic as Organic[]).flatMap((result) => {
                    const link = typeof result.link === "string" ? result.link : typeof result.url === "string" ? result.url : "";

                    return link !== "" && within(link, include, exclude)
                        ? [{ title: clip(result.title, 200) || link, url: link, snippet: clip(result.snippet) || clip(result.description) }]
                        : [];
                }),
                search.numResults,
            ),
        };
    },
};

export default provider;
