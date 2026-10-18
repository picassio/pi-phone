/**
 * Parallel's Search MCP server (https://docs.parallel.ai/integrations/mcp/search-mcp): its `web_search` tool over
 * streamable HTTP, free without a key, with higher limits for a Parallel API key sent as a bearer token. The tool takes
 * no count, domain, or date: domains go into the query as `site:` operators and are checked again on the answer,
 * recency is a hint in the query ("past week"), and the count is cut here. Ported from pi-web-access's
 * `parallel-mcp.ts` (MIT).
 */
import { clip, mcpCall, ProviderError, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider, SearchResult } from "../types.ts";

const MCP_URL = "https://search.parallel.ai/mcp";

const RECENCY_HINT: Record<Recency, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

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

interface Found {
    url?: unknown;
    title?: unknown;
    excerpts?: unknown;
    publish_date?: unknown;
}

/** The tool's answer: JSON with `results`, or text blocks of `Title:`, `URL:`, and `Text:` lines. */
function parse(text: string): Found[] {
    try {
        const json = JSON.parse(text) as { results?: unknown };

        return Array.isArray(json.results) ? (json.results as Found[]) : [];
    } catch {
        // Not JSON: the text form.
    }

    return text.split(/(?=^Title: )/m).flatMap((block) => {
        const url = block.match(/^URL: (.+)/m)?.[1]?.trim();
        const start = block.indexOf("\nText: ");
        const excerpt = start >= 0 ? block.slice(start + 7).replace(/\n---\s*$/, "").trim() : "";

        return url === undefined ? [] : [{ url, title: block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "", excerpts: excerpt === "" ? [] : [excerpt] }];
    });
}

const provider: SearchProvider = {
    id: "parallel-mcp",
    name: "Parallel Search MCP",
    site: "https://platform.parallel.ai",
    key: { kind: "secret", secret: "PARALLEL_API_KEY", optional: true },
    price: "Free without a key; a key raises the limits",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const query = [
            search.query,
            ...include.map((domain) => `site:${domain}`),
            ...exclude.map((domain) => `-site:${domain}`),
            search.recency ? RECENCY_HINT[search.recency] : "",
        ]
            .filter((part) => part !== "")
            .join(" ");
        let text: string;

        try {
            text = await mcpCall("Parallel Search MCP", MCP_URL, "web_search", { objective: search.query, search_queries: [query] }, search.signal, {
                // Parallel's free tier limits requests that carry Node's default "undici" User-Agent.
                "user-agent": "pi-phone",
                ...(key ? { authorization: `Bearer ${key}` } : {}),
            });
        } catch (error) {
            // `mcpCall` quotes what the server said, which may echo the request.
            if (key && error instanceof ProviderError && error.message.includes(key)) {
                throw new ProviderError("Parallel Search MCP", error.message.replace(/^Parallel Search MCP: /, "").split(key).join("[key]"), error.status);
            }

            throw error;
        }

        const results: SearchResult[] = parse(text)
            .filter((result) => typeof result.url === "string" && within(result.url, include, exclude))
            .map((result) => ({
                title: clip(result.title, 200) || String(result.url),
                url: String(result.url),
                snippet: clip((Array.isArray(result.excerpts) ? result.excerpts : []).filter((excerpt): excerpt is string => typeof excerpt === "string").join(" ")),
                ...(typeof result.publish_date === "string" ? { date: result.publish_date } : {}),
            }));

        return { results: tidy(results, search.numResults) };
    },
};

export default provider;
