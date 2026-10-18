/**
 * Ceramic's Search API (https://docs.ceramic.ai, `POST api.ceramic.ai/search`): a paid keyword index, so short keyword
 * queries work best. Domains to keep to become `site:` in the query (grouped with OR in parentheses); Ceramic documents
 * no exclusion, so excluded domains are only taken out of the answer, with a few extra results asked for. It has no
 * date filter and gives no dates, so recency is not sent (as in pi-web-access). Descriptions are asked for at 1,000
 * characters, the least it takes, and cut to 500. Ported from pi-web-access's `ceramic.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const MAX_RESULTS = 20;
const DESCRIPTION_CHARS = 1_000;
const SNIPPET_CHARS = 500;

/** Whether `url`'s host is one of `include` (when any) and none of `exclude`, subdomains included. */
function within(url: string, include: readonly string[], exclude: readonly string[]): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return !exclude.some(matches) && (include.length === 0 || include.some(matches));
}

const provider: SearchProvider = {
    id: "ceramic",
    name: "Ceramic",
    site: "https://platform.ceramic.ai/keys",
    key: { kind: "secret", secret: "CERAMIC_API_KEY" },
    price: "Paid, with free starter credits",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const sites = include.map((domain) => `site:${domain}`);
        const query = sites.length === 0 ? search.query : `${search.query} ${sites.length === 1 ? sites[0] : `(${sites.join(" OR ")})`}`;
        const filtered = include.length + exclude.length > 0;
        const answer = (await request("Ceramic", "https://api.ceramic.ai/search", {
            body: { query, maxResults: filtered ? Math.min(MAX_RESULTS, search.numResults + 5) : search.numResults, maxDescriptionLength: DESCRIPTION_CHARS },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { result?: { results?: unknown } };

        if (!Array.isArray(answer.result?.results)) {
            throw new ProviderError("Ceramic", "answered without result.results");
        }

        return {
            results: tidy(
                (answer.result.results as { title?: unknown; url?: unknown; description?: unknown }[])
                    .map((result, index) => ({
                        title: clip(result.title, 200) || `Source ${index + 1}`,
                        url: typeof result.url === "string" ? result.url : "",
                        snippet: clip(result.description, SNIPPET_CHARS),
                    }))
                    .filter((result) => within(result.url, include, exclude)),
                search.numResults,
            ),
        };
    },
};

export default provider;
