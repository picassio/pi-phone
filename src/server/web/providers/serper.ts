/**
 * Serper's Google Search API (https://serper.dev): Google's organic results, with a Serper key in `X-API-KEY`. Domains
 * go into the query as `site:` operators (more than one in parentheses with `OR`) and are checked again on the answer,
 * asking for 5 more to make up for what that drops; recency is Google's `tbs`. Ported from pi-web-access's
 * `serper.ts` (MIT).
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
    id: "serper",
    name: "Serper",
    site: "https://serper.dev",
    key: { kind: "secret", secret: "SERPER_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const filtered = include.length + exclude.length > 0;
        const answer = (await request("Serper", "https://google.serper.dev/search", {
            body: {
                q: googleQuery(search.query, include, exclude),
                num: filtered ? Math.min(20, search.numResults + 5) : search.numResults,
                ...(search.recency ? { tbs: TBS[search.recency] } : {}),
            },
            headers: { "x-api-key": `${key}` },
            signal: search.signal,
            key,
        })) as { organic?: unknown };

        if (!Array.isArray(answer.organic)) {
            throw new ProviderError("Serper", "answered without organic results");
        }

        return {
            results: tidy(
                (answer.organic as { title?: unknown; link?: unknown; snippet?: unknown; date?: unknown }[])
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
