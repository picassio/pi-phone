/**
 * Serply's Google Search API (https://serply.io/docs): Google's organic results, with a Serply key in `X-Api-Key`.
 * Domains go into the query as `site:` operators (more than one in parentheses with `OR`) and are checked again on the
 * answer, asking for 5 more to make up for what that drops; recency is Google's `tbs`. Each search uses Serply
 * credits. Ported from pi-web-access's `serply.ts` (MIT).
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
    id: "serply",
    name: "Serply",
    site: "https://serply.io",
    key: { kind: "secret", secret: "SERPLY_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const filtered = include.length + exclude.length > 0;
        const url = new URL("https://api.serply.io/v1/search");

        url.searchParams.set("q", googleQuery(search.query, include, exclude));
        url.searchParams.set("num", String(filtered ? Math.min(20, search.numResults + 5) : search.numResults));

        if (search.recency) {
            url.searchParams.set("tbs", TBS[search.recency]);
        }

        const answer = (await request("Serply", url.toString(), { headers: { "x-api-key": `${key}` }, signal: search.signal, key })) as {
            detail?: unknown;
            results?: unknown;
        };

        if (typeof answer.detail === "string" && answer.detail.trim() !== "") {
            throw new ProviderError("Serply", answer.detail.trim());
        }

        if (!Array.isArray(answer.results)) {
            throw new ProviderError("Serply", "answered without a result list");
        }

        return {
            results: tidy(
                (answer.results as { title?: unknown; link?: unknown; description?: unknown }[])
                    .filter((result) => typeof result.link === "string" && within(result.link, include, exclude))
                    .map((result) => ({
                        title: clip(result.title, 200) || String(result.link),
                        url: String(result.link),
                        snippet: clip(result.description),
                    })),
                search.numResults,
            ),
        };
    },
};

export default provider;
