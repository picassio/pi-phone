/**
 * BytePlus Searchinfinity web search (https://docs.byteplus.com/api/docs/searchinfinity/Searchinfinity_API_Reference),
 * the Global edition of Volcengine's 豆包搜索, with a Searchinfinity API key. Each result has a model-written
 * `Summary`, preferred over its `Snippet`. It takes the count, up to 5 domains to keep to and 5 to leave out, and a
 * time range; it answers HTTP 200 with `ResponseMetadata.Error` when a search fails, and gives up after 30 s itself.
 * Ported from pi-web-access's `searchinfinity.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider } from "../types.ts";

const TIME_RANGE: Record<Recency, string> = { day: "OneDay", week: "OneWeek", month: "OneMonth", year: "OneYear" };
const MAX_DOMAINS = 5;

const provider: SearchProvider = {
    id: "searchinfinity",
    name: "Searchinfinity",
    site: "https://console.byteplus.com/search-infinity/api-key",
    key: { kind: "secret", secret: "SEARCHINFINITY_API_KEY" },
    price: "Monthly free search quota",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);

        if (include.length > MAX_DOMAINS || exclude.length > MAX_DOMAINS) {
            throw new ProviderError("Searchinfinity", `it takes at most ${MAX_DOMAINS} domains to keep to and ${MAX_DOMAINS} to leave out`);
        }

        const filter = {
            ...(include.length > 0 ? { Sites: include.join("|") } : {}),
            ...(exclude.length > 0 ? { BlockHosts: exclude.join("|") } : {}),
        };
        const answer = (await request("Searchinfinity", "https://torchlight.byteintlapi.com/search_api/web_search", {
            body: {
                Query: search.query,
                Count: search.numResults,
                ...(Object.keys(filter).length > 0 ? { Filter: filter } : {}),
                ...(search.recency ? { TimeRange: TIME_RANGE[search.recency] } : {}),
            },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as {
            ResponseMetadata?: { Error?: { CodeN?: unknown; Code?: unknown; Message?: unknown } | null };
            Result?: { WebResults?: unknown } | null;
        };
        const error = answer.ResponseMetadata?.Error;

        if (error && (error.Code || error.Message)) {
            const code = [error.CodeN, error.Code].filter((part) => part !== undefined && part !== "").join(" ");

            throw new ProviderError("Searchinfinity", `${typeof error.Message === "string" && error.Message !== "" ? error.Message : "the search failed"}${code === "" ? "" : ` (code ${code})`}`);
        }

        if (!Array.isArray(answer.Result?.WebResults)) {
            throw new ProviderError("Searchinfinity", "answered without a result list");
        }

        return {
            results: tidy(
                (answer.Result.WebResults as { Title?: unknown; Url?: unknown; Snippet?: unknown; Summary?: unknown; PublishTime?: unknown }[]).map(
                    (result) => ({
                        title: clip(result.Title, 200) || String(result.Url ?? "").trim(),
                        url: String(result.Url ?? "").trim(),
                        snippet: clip(result.Summary, 800) || clip(result.Snippet),
                        ...(typeof result.PublishTime === "string" && result.PublishTime !== "" ? { date: result.PublishTime } : {}),
                    }),
                ),
                search.numResults,
            ),
        };
    },
};

export default provider;
