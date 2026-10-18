/**
 * DeepSeek's Search API (https://api-docs.deepseek.com/guides/search): its own engine, with the DeepSeek API key of the
 * Pi sign-in. `summary` (600–800 characters) is written for models, `snippet` for screens. Queries are at most 128
 * characters, operators included; `site:`, `-site:`, and `after:` are its filters. Its links end in the matching chunk's
 * number (`#1`), which is dropped, so each page is listed once. Ported from pi-web-access's
 * `deepseek.ts` (MIT).
 */
import { clip, ProviderError, request, since, tidy, withSiteOperators } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const MAX_QUERY = 128;

const provider: SearchProvider = {
    id: "deepseek",
    name: "DeepSeek",
    site: "https://platform.deepseek.com/api_keys",
    key: { kind: "pi", provider: "deepseek" },
    price: "$0.75 per 1,000 searches",
    async search(search, { key }) {
        const query = [withSiteOperators(search.query, search.domains), search.recency ? `after:${since(search.recency)}` : ""]
            .filter((part) => part !== "")
            .join(" ");

        if ([...query].length > MAX_QUERY) {
            throw new ProviderError("DeepSeek", `the query is ${[...query].length} characters with its filters; DeepSeek takes at most ${MAX_QUERY}`);
        }

        const answer = (await request("DeepSeek", "https://api.deepseek.com/v1/tools/search", {
            body: { query, count: search.numResults },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { results?: { title?: unknown; url?: unknown; snippet?: unknown; summary?: unknown; date?: unknown }[] };

        return {
            results: tidy(
                (answer.results ?? []).map((result) => ({
                    title: clip(result.title, 200),
                    // DeepSeek marks which chunk of a page matched (`…#2`): the page is the same, and listed once.
                    url: String(result.url ?? "").replace(/#\d+$/, ""),
                    snippet: clip(result.summary, 800) || clip(result.snippet),
                    ...(typeof result.date === "string" ? { date: result.date } : {}),
                })),
                search.numResults,
            ),
        };
    },
};

export default provider;
