/**
 * Bocha's Web Search API (https://open.bochaai.com, `POST api.bochaai.com/v1/web-search`): a Chinese web index with
 * per-result summaries (`summary: true`). Recency is its `freshness` (`oneDay` … `oneYear`, else `noLimit`). The API
 * takes no domain filter, so domains are kept to after the answer (as in pi-web-access), and a filtered search can come
 * back with fewer results. The envelope's `code` is 200 when it worked. Ported from pi-web-access's `bocha.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const FRESHNESS = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };

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

/** The first non-blank text among `values`. */
const first = (...values: unknown[]) => values.find((value): value is string => typeof value === "string" && value.trim() !== "");

const provider: SearchProvider = {
    id: "bocha",
    name: "Bocha",
    site: "https://open.bochaai.com/",
    key: { kind: "secret", secret: "BOCHA_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("Bocha", "https://api.bochaai.com/v1/web-search", {
            body: { query: search.query, count: search.numResults, freshness: search.recency ? FRESHNESS[search.recency] : "noLimit", summary: true },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { code?: unknown; msg?: unknown; data?: { webPages?: { value?: unknown } } };

        if (answer.code !== undefined && Number(answer.code) !== 200) {
            throw new ProviderError("Bocha", `code ${String(answer.code)}: ${first(answer.msg) ?? "no message"}`);
        }

        const pages = answer.data?.webPages?.value;

        if (!Array.isArray(pages)) {
            throw new ProviderError("Bocha", "answered without data.webPages.value");
        }

        return {
            results: tidy(
                (pages as Record<string, unknown>[])
                    .map((page) => {
                        const url = first(page.url, page.link, page.href)?.trim() ?? "";

                        return {
                            title: clip(first(page.title, page.name) ?? url, 200),
                            url,
                            snippet: clip(first(page.summary, page.snippet, page.description, page.content)),
                        };
                    })
                    .filter((result) => within(result.url, include, exclude)),
                search.numResults,
            ),
        };
    },
};

export default provider;
