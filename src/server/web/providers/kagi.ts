/**
 * Kagi's Search API (https://help.kagi.com/kagi/api/search.html): `POST https://kagi.com/api/v1/search` with a Kagi
 * key, `{ query, limit }`. It takes no recency or domain filter, and pi-web-access sends none, so a search with one
 * fails rather than quietly ignoring it. Ported from pi-web-access's `kagi.ts` (MIT).
 */
import { clip, ProviderError, request, tidy } from "../http.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

/** The first text among `values` that is not blank. */
function first(...values: unknown[]): string {
    return (values.find((value) => typeof value === "string" && value.trim() !== "") as string | undefined)?.trim() ?? "";
}

/** The results in Kagi's `data` (or `data.search`), which may nest lists. */
function collect(value: unknown, into: SearchResult[]): SearchResult[] {
    if (Array.isArray(value)) {
        for (const item of value) {
            collect(item, into);
        }
    } else if (typeof value === "object" && value !== null) {
        const item = value as Record<string, unknown>;
        const url = first(item.url, item.href, item.link);

        if (url !== "") {
            into.push({
                title: clip(first(item.title, item.name) || url, 200),
                url,
                snippet: clip(first(item.snippet, item.description, item.summary, item.content, item.markdown, item.text)),
            });
        }
    }

    return into;
}

const provider: SearchProvider = {
    id: "kagi",
    name: "Kagi",
    site: "https://kagi.com/settings?p=api",
    key: { kind: "secret", secret: "KAGI_API_KEY" },
    async search(search, { key }) {
        if (search.recency || (search.domains ?? []).length > 0) {
            throw new ProviderError("Kagi", "its Search API takes no recency or domain filter; search again without them");
        }

        const answer = (await request("Kagi", "https://kagi.com/api/v1/search", {
            body: { query: search.query, limit: search.numResults },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { data?: unknown; errors?: unknown; error?: unknown };

        if (typeof answer !== "object" || answer === null || Array.isArray(answer)) {
            throw new ProviderError("Kagi", "answered something that is not an object");
        }

        // A 200 may still carry `errors: [{ message }]`.
        const errors = answer.errors ?? answer.error;

        if (Array.isArray(errors) && errors.length > 0) {
            throw new ProviderError(
                "Kagi",
                errors
                    .map((entry: unknown) => (typeof entry === "object" && entry !== null ? first((entry as Record<string, unknown>).message, (entry as Record<string, unknown>).msg, (entry as Record<string, unknown>).code) || JSON.stringify(entry) : String(entry)))
                    .join("; ")
                    .slice(0, 300),
            );
        }

        const data = answer.data;
        const items = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as { search?: unknown }).search : data;

        return { results: tidy(collect(items, []), search.numResults) };
    },
};

export default provider;
