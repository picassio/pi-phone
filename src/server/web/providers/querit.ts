/**
 * Querit's Search API (https://www.querit.ai/en/docs): its own index, with a Querit API key. The count, domains
 * (`filters.sites`), and recency (`filters.timeRange.date`: `d1`, `w1`, `m1`, `y1`) follow the official querit-python
 * models. It answers HTTP 200 with its own `error_code`, 200 when it worked. Ported from pi-web-access's `querit.ts`
 * (MIT), search only.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider } from "../types.ts";

const TIME_RANGE: Record<Recency, string> = { day: "d1", week: "w1", month: "m1", year: "y1" };

const provider: SearchProvider = {
    id: "querit",
    name: "Querit",
    site: "https://www.querit.ai/en/dashboard/api-keys",
    key: { kind: "secret", secret: "QUERIT_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const filters = {
            ...(include.length + exclude.length > 0
                ? { sites: { ...(include.length > 0 ? { include } : {}), ...(exclude.length > 0 ? { exclude } : {}) } }
                : {}),
            ...(search.recency ? { timeRange: { date: TIME_RANGE[search.recency] } } : {}),
        };
        const answer = (await request("Querit", "https://api.querit.ai/v1/search", {
            body: { query: search.query, count: search.numResults, ...(Object.keys(filters).length > 0 ? { filters } : {}) },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as {
            error_code?: unknown;
            error_msg?: unknown;
            results?: { result?: { url?: unknown; title?: unknown; snippet?: unknown; page_age?: unknown }[] };
        };

        if (Number(answer.error_code) !== 200) {
            throw new ProviderError(
                "Querit",
                `error ${answer.error_code === undefined ? "unknown" : String(answer.error_code)}${typeof answer.error_msg === "string" && answer.error_msg.trim() !== "" ? `: ${answer.error_msg.trim()}` : ""}`,
            );
        }

        if (!Array.isArray(answer.results?.result)) {
            throw new ProviderError("Querit", "answered without a result list");
        }

        return {
            results: tidy(
                answer.results.result.map((result) => ({
                    title: clip(result.title, 200) || String(result.url ?? "").trim(),
                    url: String(result.url ?? "").trim(),
                    snippet: clip(result.snippet),
                    ...(typeof result.page_age === "string" ? { date: result.page_age } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
