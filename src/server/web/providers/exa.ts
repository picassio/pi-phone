/**
 * Exa (https://exa.ai, docs https://docs.exa.ai): neural web search. Without a key it runs through Exa's hosted MCP
 * server (https://mcp.exa.ai/mcp), which is free and rate-limited; with EXA_API_KEY in Settings › Secrets it calls
 * `POST api.exa.ai/search` on the account. Which one is a matter of the key, not a fallback. Recency is
 * `startPublishedDate`, domains are `includeDomains` / `excludeDomains`, and the snippet is Exa's highlights.
 * Without a key, a search with recency or domains needs the MCP server's `web_search_advanced_exa` tool (it takes
 * the API's arguments); a plain one uses `web_search_exa`. Ported from pi-web-access's `exa.ts` (MIT), without its
 * retry of a failed advanced search as a basic one with the filters written into the query.
 */
import { clip, mcpCall, ProviderError, request, RECENCY_DAYS, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchRequest, SearchResult } from "../types.ts";

const API_URL = "https://api.exa.ai/search";
const MCP_URL = "https://mcp.exa.ai/mcp";

interface ExaResult {
    title?: unknown;
    url?: unknown;
    publishedDate?: unknown;
    text?: unknown;
    highlights?: unknown;
}

/** The search arguments the API and the advanced MCP tool share. */
function args(search: SearchRequest): Record<string, unknown> {
    const { include, exclude } = splitDomains(search.domains);

    return {
        query: search.query,
        type: "auto",
        numResults: search.numResults,
        ...(include.length > 0 ? { includeDomains: include } : {}),
        ...(exclude.length > 0 ? { excludeDomains: exclude } : {}),
        ...(search.recency ? { startPublishedDate: new Date(Date.now() - RECENCY_DAYS[search.recency] * 86_400_000).toISOString() } : {}),
    };
}

/** The host of `url`, or "Source n" for a result without a title. */
function label(url: string, index: number): string {
    try {
        return new URL(url).hostname || `Source ${index + 1}`;
    } catch {
        return `Source ${index + 1}`;
    }
}

/** Results in the API's JSON shape: highlights for the snippet, else the start of the text. */
function fromJson(results: readonly ExaResult[]): SearchResult[] {
    return results.map((result, index) => {
        const url = typeof result.url === "string" ? result.url : "";
        const highlights = Array.isArray(result.highlights) ? result.highlights.filter((item): item is string => typeof item === "string" && item.trim() !== "") : [];

        return {
            title: clip(result.title, 200) || label(url, index),
            url,
            snippet: clip(highlights.length > 0 ? highlights.join(" ") : result.text, 800),
            ...(typeof result.publishedDate === "string" ? { date: result.publishedDate } : {}),
        };
    });
}

/** The basic MCP tool's text: blocks of `Title:`, `URL:`, `Published:` (`N/A` when unknown), and `Text:` or `Highlights:`. */
function fromText(text: string): SearchResult[] {
    return text
        .split(/(?=^Title: )/m)
        .map((block, index) => {
            const url = /^URL: (.+)/m.exec(block)?.[1]?.trim() ?? "";
            const date = /^Published(?: Date)?: (.+)/m.exec(block)?.[1]?.trim();
            const textStart = block.indexOf("\nText: ");
            const highlights = /\nHighlights:\s*\n/.exec(block);
            const content = textStart >= 0 ? block.slice(textStart + 7) : highlights === null ? "" : block.slice(highlights.index + highlights[0].length);

            return {
                title: clip(/^Title: (.+)/m.exec(block)?.[1], 200) || label(url, index),
                url,
                snippet: clip(content.replace(/\n---\s*$/, ""), 500),
                ...(date !== undefined && date !== "" && date !== "N/A" ? { date } : {}),
            };
        });
}

/** What an MCP tool answered: the API's JSON when it is that, else the text blocks. */
function fromMcp(text: string): SearchResult[] {
    try {
        const parsed = JSON.parse(text) as { results?: unknown };

        if (Array.isArray(parsed.results)) {
            return fromJson(parsed.results as ExaResult[]);
        }
    } catch {}

    return fromText(text);
}

const provider: SearchProvider = {
    id: "exa",
    name: "Exa",
    site: "https://dashboard.exa.ai/api-keys",
    key: { kind: "secret", secret: "EXA_API_KEY", optional: true },
    price: "Free without a key (rate-limited); with a key, Exa's own pricing",
    async search(search, { key }) {
        if (key !== undefined) {
            const answer = (await request("Exa", API_URL, {
                body: { ...args(search), contents: { highlights: true } },
                headers: { "x-api-key": key, "x-exa-integration": "pi-phone" },
                signal: search.signal,
                key,
            })) as { results?: ExaResult[] };

            return { results: tidy(fromJson(answer.results ?? []), search.numResults) };
        }

        const filtered = search.recency !== undefined || (search.domains ?? []).length > 0;
        const tool = filtered ? "web_search_advanced_exa" : "web_search_exa";
        const text = await mcpCall(
            "Exa",
            `${MCP_URL}?tools=${tool}`,
            tool,
            filtered ? { ...args(search), enableHighlights: true, textMaxCharacters: 3000 } : { query: search.query, numResults: search.numResults },
            search.signal,
            { "x-exa-source": "pi-phone" },
        ).catch((error: unknown) => {
            if (error instanceof ProviderError && error.status === 429) {
                throw new ProviderError("Exa", "the free MCP search is rate-limited; add an Exa key as EXA_API_KEY in Settings › Secrets", 429);
            }

            throw error;
        });

        return { results: tidy(fromMcp(text), search.numResults) };
    },
};

export default provider;
