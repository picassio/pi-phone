/**
 * Jina Search (https://s.jina.ai, docs at https://jina.ai/reader#apiform): `GET https://s.jina.ai/<query>` with a
 * Jina key, SERP results only (`X-Respond-With: no-content`). Domains to keep to go as `site` parameters; domains to
 * leave out (`-site:`) and recency ("published in the past week") go in the query, and every domain filter is applied
 * again to what comes back. Ported from pi-web-access's `jina-search.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

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
    id: "jina",
    name: "Jina Search",
    site: "https://jina.ai/api-dashboard",
    key: { kind: "secret", secret: "JINA_API_KEY" },
    async search(search, { key }) {
        const domains = splitDomains(search.domains);
        const query = [search.query.trim(), ...domains.exclude.map((domain) => `-site:${domain}`), search.recency ? `published in the past ${search.recency}` : ""]
            .filter((part) => part !== "")
            .join(" ");
        const url = new URL(encodeURIComponent(query), "https://s.jina.ai/");

        url.searchParams.set("count", String(search.numResults));

        for (const domain of domains.include) {
            url.searchParams.append("site", domain);
        }

        const answer = await request("Jina", url.toString(), {
            headers: { authorization: `Bearer ${key}`, "user-agent": "pi-phone", "x-respond-with": "no-content", "x-retain-images": "none" },
            signal: search.signal,
            key,
        });
        // Jina answers `{ code, data: [...] }`, or the bare list.
        const envelope = answer as { code?: unknown; data?: unknown };

        if (typeof envelope.code === "number" && envelope.code !== 200) {
            throw new ProviderError("Jina", `answered code ${envelope.code}`);
        }

        const items = Array.isArray(answer) ? answer : envelope.data;

        if (!Array.isArray(items)) {
            throw new ProviderError("Jina", "answered without a list of results");
        }

        return {
            results: tidy(
                (items as { title?: unknown; url?: unknown; description?: unknown }[])
                    .map((item, index) => ({
                        title: clip(item.title, 200) || `Source ${index + 1}`,
                        url: typeof item.url === "string" ? item.url.trim() : "",
                        snippet: clip(item.description),
                    }))
                    .filter((result) => inDomains(result.url, domains)),
                search.numResults,
            ),
        };
    },
};

export default provider;
