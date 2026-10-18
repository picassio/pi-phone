/**
 * AnySearch (https://anysearch.com): one search endpoint, `POST /v1/search` with `{ query, max_results }`, that
 * answers anonymously and, with a key in Settings › Secrets, on the account. It takes no time or domain filters, so
 * recency and domains are not sent (as in pi-web-access). Its answer is the envelope `{ code: 0, data: { results,
 * metadata } }`; anything else is refused. Ported from pi-web-access's `anysearch.ts` (MIT).
 */
import { clip, ProviderError, request, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

interface Envelope {
    code?: unknown;
    data?: { results?: unknown; metadata?: unknown };
}

const provider: SearchProvider = {
    id: "anysearch",
    name: "AnySearch",
    site: "https://anysearch.com",
    key: { kind: "secret", secret: "ANYSEARCH_API_KEY", optional: true },
    price: "Free without a key",
    async search(search, { key }) {
        const answer = (await request("AnySearch", "https://api.anysearch.com/v1/search", {
            body: { query: search.query, max_results: search.numResults },
            headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as Envelope;

        // pi-web-access checks the whole envelope: a `code` other than 0 is a failure even with HTTP 200.
        if (answer.code !== 0 || typeof answer.data !== "object" || answer.data === null || !Array.isArray(answer.data.results)) {
            throw new ProviderError("AnySearch", `answered without results (code ${String(answer.code)})`);
        }

        return {
            results: tidy(
                (answer.data.results as { title?: unknown; url?: unknown; snippet?: unknown }[]).map((result) => ({
                    title: clip(result.title, 200),
                    url: String(result.url ?? ""),
                    snippet: clip(result.snippet),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
