/**
 * A SearXNG instance's JSON search (https://docs.searxng.org/dev/search_api.html), at the address the person sets, with
 * no key. The instance must allow the `json` format (`search.formats` in its settings.yml). Domains go into the query as
 * `site:` operators and are checked again on the answer; recency is its `time_range`; the count is cut here, as it
 * takes none. The instance's own `answers` become the answer. Ported from pi-web-access's `searxng.ts` (MIT), without
 * its extra request headers.
 */
import { clip, ProviderError, request, splitDomains, tidy, withSiteOperators } from "../http.ts";
import type { SearchProvider } from "../types.ts";

/** Whether `url`'s host is one of `include` (when there are any) and none of `exclude`, subdomains included. */
function within(url: string, include: string[], exclude: string[]): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return (include.length === 0 || include.some(matches)) && !exclude.some(matches);
}

/** The instance's address without a trailing slash, query, or fragment; only http(s), and no user or password in it. */
function baseUrl(endpoint: string | undefined): string {
    let url: URL;

    try {
        url = new URL((endpoint ?? "").trim());
    } catch {
        throw new ProviderError("SearXNG", "set the address of your SearXNG instance in Settings › Web access");
    }

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
        throw new ProviderError("SearXNG", "its address in Settings › Web access must be an http(s) address without a user or password");
    }

    url.search = "";
    url.hash = "";

    return url.toString().replace(/\/+$/, "");
}

const provider: SearchProvider = {
    id: "searxng",
    name: "SearXNG",
    site: "https://docs.searxng.org",
    key: { kind: "none" },
    endpoint: { label: "SearXNG address" },
    price: "Free, self-hosted",
    async search(search, { endpoint }) {
        const { include, exclude } = splitDomains(search.domains);
        const url = new URL(`${baseUrl(endpoint)}/search`);

        url.searchParams.set("q", withSiteOperators(search.query, search.domains));
        url.searchParams.set("format", "json");

        if (search.recency) {
            url.searchParams.set("time_range", search.recency);
        }

        const body = (await request("SearXNG", url.toString(), { headers: { accept: "application/json" }, signal: search.signal, text: true })) as string;
        let answer: { results?: { title?: unknown; url?: unknown; content?: unknown; publishedDate?: unknown }[]; answers?: unknown[] };

        try {
            answer = JSON.parse(body) as typeof answer;
        } catch {
            // An instance without the format answers its HTML page (or a bot check) instead.
            throw new ProviderError("SearXNG", `did not answer JSON; the instance must allow the json format (search.formats in its settings.yml): ${clip(body, 120)}`);
        }
        // Answers are text in older SearXNG and `{ answer, url }` in newer.
        const answers = (answer.answers ?? [])
            .map((item) => (typeof item === "string" ? item : typeof item === "object" && item !== null ? (item as { answer?: unknown }).answer : undefined))
            .filter((item): item is string => typeof item === "string" && item.trim() !== "")
            .map((item) => item.trim());

        return {
            ...(answers.length === 0 ? {} : { answer: answers.join("\n\n") }),
            results: tidy(
                (answer.results ?? [])
                    .filter((result) => typeof result.url === "string" && within(result.url, include, exclude))
                    .map((result) => ({
                        title: clip(result.title, 200) || String(result.url),
                        url: String(result.url),
                        snippet: clip(result.content),
                        ...(typeof result.publishedDate === "string" ? { date: result.publishedDate } : {}),
                    })),
                search.numResults,
            ),
        };
    },
};

export default provider;
