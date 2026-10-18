/**
 * SERPdive's Search API (https://serpdive.com/docs), with a SERPdive API key, at its free `krill` depth: extracted page
 * content and no written answer (`mako` and `moby` cost credits and are not offered). It takes no domain or date:
 * domains are checked on the answer, and recency is a hint in the query ("past week") that ranks recent pages higher
 * but does not guarantee them. `max_results` is a cap of at most 10. Ported from pi-web-access's `serpdive.ts` (MIT).
 */
import { clip, request, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider } from "../types.ts";

const MODEL = "krill";
const MAX_RESULTS = 10;

const RECENCY_HINT: Record<Recency, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

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

const provider: SearchProvider = {
    id: "serpdive",
    name: "SERPdive",
    site: "https://serpdive.com/dashboard/keys",
    key: { kind: "secret", secret: "SERPDIVE_API_KEY" },
    price: "Free at the krill depth (fair use)",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("SERPdive", "https://api.serpdive.com/v1/search", {
            body: {
                query: search.recency ? `${search.query} ${RECENCY_HINT[search.recency]}` : search.query,
                model: MODEL,
                max_results: Math.min(search.numResults, MAX_RESULTS),
            },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { answer?: unknown; results?: { url?: unknown; title?: unknown; date?: unknown; content?: unknown }[] };

        return {
            ...(typeof answer.answer === "string" && answer.answer.trim() !== "" ? { answer: answer.answer.trim() } : {}),
            results: tidy(
                (answer.results ?? [])
                    .filter((result) => typeof result.url === "string" && within(result.url, include, exclude))
                    .map((result) => ({
                        title: clip(result.title, 200) || String(result.url),
                        url: String(result.url),
                        snippet: clip(result.content),
                        ...(typeof result.date === "string" ? { date: result.date } : {}),
                    })),
                search.numResults,
            ),
        };
    },
};

export default provider;
