/**
 * Keenable's search API (https://keenable.ai): `POST https://api.keenable.ai/v1/search` with a key in `X-API-Key`, or
 * without one `…/v1/search/public`, limited per IP, which knows the caller by `X-Keenable-Title` (and answers 400
 * without it). One domain to keep to goes as `site`; more, and domains to leave out, as `site:` / `-site:` in the
 * query, and every domain filter is applied again to what comes back. Recency is `published_after`. Ported from
 * pi-web-access's `keenable.ts` (MIT).
 */
import { clip, ProviderError, request, since, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const MAX_REQUEST = 50;
const MAX_SNIPPET = 500;

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
    id: "keenable",
    name: "Keenable",
    site: "https://keenable.ai",
    key: { kind: "secret", secret: "KEENABLE_API_KEY", optional: true },
    price: "Free without a key (limited per IP); a key raises the limit",
    async search(search, { key }) {
        const domains = splitDomains(search.domains);
        const site = domains.include.length === 1 ? domains.include[0] : undefined;
        const query = [
            search.query,
            site === undefined && domains.include.length > 1 ? `(${domains.include.map((domain) => `site:${domain}`).join(" OR ")})` : "",
            ...domains.exclude.map((domain) => `-site:${domain}`),
        ]
            .filter((part) => part !== "")
            .join(" ");
        // Results are filtered again here, so leave some headroom when the query carries domain clauses.
        const clauses = domains.include.length > 1 || domains.exclude.length > 0;
        const keyed = key !== undefined && key !== "";
        let answer: unknown;

        try {
            answer = await request("Keenable", keyed ? "https://api.keenable.ai/v1/search" : "https://api.keenable.ai/v1/search/public", {
                body: {
                    query,
                    max_results: clauses ? Math.min(MAX_REQUEST, search.numResults + 5) : search.numResults,
                    snippet_max_length: MAX_SNIPPET,
                    ...(site === undefined ? {} : { site }),
                    ...(search.recency ? { published_after: since(search.recency) } : {}),
                },
                headers: { "x-keenable-title": "pi-phone", ...(keyed ? { "x-api-key": key } : {}) },
                signal: search.signal,
                key,
            });
        } catch (error) {
            if (error instanceof ProviderError && error.status === 429 && !keyed) {
                throw new ProviderError("Keenable", `${error.message.replace(/^Keenable: /, "")} (the limit without a key; a KEENABLE_API_KEY in Settings › Secrets raises it)`, 429);
            }

            throw error;
        }

        const results = (answer as { results?: unknown }).results;

        if (!Array.isArray(results)) {
            throw new ProviderError("Keenable", "answered without a list of results");
        }

        return {
            results: tidy(
                (results as { title?: unknown; url?: unknown; snippet?: unknown; description?: unknown }[])
                    .map((result, index) => ({
                        title: clip(result.title, 200) || `Source ${index + 1}`,
                        url: typeof result.url === "string" ? result.url : "",
                        // The page text is in `snippet`; `description` is usually empty.
                        snippet: clip(result.snippet, MAX_SNIPPET) || clip(result.description, MAX_SNIPPET),
                    }))
                    .filter((result) => inDomains(result.url, domains)),
                search.numResults,
            ),
        };
    },
};

export default provider;
