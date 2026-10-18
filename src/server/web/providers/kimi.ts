/**
 * Kimi Code Plan search: `POST https://api.kimi.com/coding/v1/search` with `{ text_query }` and the token of the Pi
 * sign-in "kimi-coding" (a Kimi Code subscription, not a Moonshot Open Platform key); searches draw on the plan's
 * shared quota. It takes no count, recency, or domain parameter: the count and domains are applied to what comes back,
 * and a search with recency fails rather than quietly ignoring it. Docs: https://www.kimi.com/code. Ported from
 * pi-web-access's `kimi-search.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

/** Whether `url`'s host is, or is under, one of `include` (when there are any) and none of `exclude`. */
function inDomains(url: string, { include, exclude }: { include: string[]; exclude: string[] }): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const under = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return (include.length === 0 || include.some(under)) && !exclude.some(under);
}

const provider: SearchProvider = {
    id: "kimi",
    name: "Kimi Code",
    site: "https://www.kimi.com/code",
    key: { kind: "pi", provider: "kimi-coding" },
    price: "Included in a Kimi Code Plan (its shared quota)",
    async search(search, { key }) {
        if (search.recency) {
            throw new ProviderError("Kimi", "its search takes no recency filter; search again without it");
        }

        const domains = splitDomains(search.domains);
        const answer = (await request("Kimi", "https://api.kimi.com/coding/v1/search", {
            body: { text_query: search.query },
            // Each call is a tool call to Kimi's service, with its own id.
            headers: { authorization: `Bearer ${key}`, "x-msh-tool-call-id": crypto.randomUUID() },
            signal: search.signal,
            key,
        })) as { search_results?: unknown };

        if (!Array.isArray(answer.search_results)) {
            throw new ProviderError("Kimi", "answered without a list of results (search_results)");
        }

        return {
            results: tidy(
                (answer.search_results as { title?: unknown; url?: unknown; snippet?: unknown }[])
                    .map((result) => {
                        const url = typeof result.url === "string" ? result.url.trim() : "";

                        return { title: clip(result.title, 200) || url, url, snippet: clip(result.snippet) };
                    })
                    .filter((result) => inDomains(result.url, domains)),
                search.numResults,
            ),
        };
    },
};

export default provider;
