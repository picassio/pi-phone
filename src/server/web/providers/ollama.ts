/**
 * Ollama's hosted Web Search API (https://docs.ollama.com/capabilities/web-search): `POST
 * https://ollama.com/api/web_search` with an ollama.com account key, `{ query, max_results }`, at most 10 results. It
 * runs at ollama.com, not on a local Ollama. It takes no recency or domain filter, and pi-web-access sends none, so a
 * search with one fails rather than quietly ignoring it. Ported from pi-web-access's `ollama.ts` (MIT).
 */
import { clip, ProviderError, request, tidy } from "../http.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

const MAX_RESULTS = 10;

const provider: SearchProvider = {
    id: "ollama",
    name: "Ollama Web Search",
    site: "https://ollama.com/settings/keys",
    key: { kind: "secret", secret: "OLLAMA_API_KEY" },
    async search(search, { key }) {
        if (search.recency || (search.domains ?? []).length > 0) {
            throw new ProviderError("Ollama", "its Web Search API takes no recency or domain filter; search again without them");
        }

        const count = Math.min(search.numResults, MAX_RESULTS);
        const answer = (await request("Ollama", "https://ollama.com/api/web_search", {
            body: { query: search.query, max_results: count },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { results?: unknown };

        if (!Array.isArray(answer.results)) {
            throw new ProviderError("Ollama", "answered without a list of results");
        }

        // Each result is `{ title, url, content }`, all text; anything else is a changed API.
        const results: SearchResult[] = (answer.results as Record<string, unknown>[]).map((result, index) => {
            if (typeof result?.title !== "string" || typeof result.url !== "string" || result.url === "" || typeof result.content !== "string") {
                throw new ProviderError("Ollama", `result ${index + 1} is not { title, url, content }`);
            }

            return { title: clip(result.title, 200), url: result.url, snippet: clip(result.content) };
        });

        return { results: tidy(results, count) };
    },
};

export default provider;
