/**
 * XCrawl's SERP API (https://docs.xcrawl.com): `POST https://run.xcrawl.com/v1/serp` with an XCrawl key, `{ engine:
 * "google_search", q }`: Google's organic results. It takes no count, recency, or domain parameter: the count and
 * domains are applied to what comes back, and a search with recency fails rather than quietly ignoring it. Links
 * relative to the API (`/goto?url=…`) are made absolute against it. Ported from pi-web-access's `xcrawl.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

const URL_SERP = "https://run.xcrawl.com/v1/serp";

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
    id: "xcrawl",
    name: "XCrawl (Google SERP)",
    site: "https://dash.xcrawl.com/",
    key: { kind: "secret", secret: "XCRAWL_API_KEY" },
    async search(search, { key }) {
        if (search.recency) {
            throw new ProviderError("XCrawl", "its SERP API takes no recency filter; search again without it");
        }

        const answer = (await request("XCrawl", URL_SERP, {
            body: { engine: "google_search", q: search.query },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { search_metadata?: unknown; organic_results?: unknown };
        const metadata = answer.search_metadata;

        if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
            throw new ProviderError("XCrawl", "answered without search_metadata");
        }

        const status = (metadata as { status?: unknown }).status;

        if (status !== undefined && status !== "completed") {
            throw new ProviderError("XCrawl", `the search is ${JSON.stringify(status)}, not completed`);
        }

        if (!Array.isArray(answer.organic_results)) {
            throw new ProviderError("XCrawl", "answered without organic_results");
        }

        const results: SearchResult[] = (answer.organic_results as Record<string, unknown>[]).map((result, index) => {
            if (typeof result?.link !== "string" || result.link.trim() === "") {
                throw new ProviderError("XCrawl", `result ${index + 1} has no link`);
            }

            const url = new URL(result.link.trim(), URL_SERP).href;

            return { title: clip(result.title, 200) || url, url, snippet: clip(result.snippet) };
        });
        const domains = splitDomains(search.domains);

        return { results: tidy(results.filter((result) => inDomains(result.url, domains)), search.numResults) };
    },
};

export default provider;
