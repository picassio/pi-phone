/**
 * xAI's Agent Tools API (https://docs.x.ai/docs/guides/tools/search-tools): the hosted `web_search` tool on the
 * Responses endpoint `POST https://api.x.ai/v1/responses`, on `grok-4.5`, with the xAI key of the Pi sign-in. Grok
 * writes the answer; the sources are its `url_citation` annotations (with the text around them as the snippet), then
 * the search calls' sources, then the response's `citations`. Recency, the count, and domains are asked for in the
 * prompt: xAI's filter fields are not verified, and an unknown one fails the search. (The older Live Search,
 * `search_parameters` on chat completions, answers 410.) Ported from pi-web-access's `xai-search.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

const MODEL = "grok-4.5";

const RECENCY_LABEL = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" } as const;

type Item = Record<string, unknown>;

const isItem = (value: unknown): value is Item => typeof value === "object" && value !== null && !Array.isArray(value);

/** The text around a citation, `start`–`end` with 100 characters each side, links reduced to their text. */
function around(text: string, start: unknown, end: unknown): string {
    if (typeof start !== "number" || typeof end !== "number" || text === "") {
        return "";
    }

    return clip(text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), 300);
}

/** A source as xAI lists it: a link, or `{ url | source_website_url, title | caption }`. */
function source(value: unknown): SearchResult | undefined {
    if (typeof value === "string") {
        return { title: value, url: value, snippet: "" };
    }

    if (!isItem(value)) {
        return undefined;
    }

    const url = value.url ?? value.source_website_url;

    return typeof url === "string" && url.trim() !== "" ? { title: clip(value.title ?? value.caption, 200) || url, url, snippet: "" } : undefined;
}

const provider: SearchProvider = {
    id: "xai",
    name: "xAI Grok web search",
    site: "https://console.x.ai",
    key: { kind: "pi", provider: "xai" },
    async search(search, { key }) {
        const domains = splitDomains(search.domains);
        const instructions = [
            "Search the web and answer using only what the web results say.",
            "Cite your sources inline.",
            search.recency ? `Prefer sources from the ${RECENCY_LABEL[search.recency]}.` : "",
            `Prefer around ${search.numResults} distinct sources.`,
            domains.include.length === 0 ? "" : `Only use sources from: ${domains.include.slice(0, 100).join(", ")}.`,
            domains.exclude.length === 0 ? "" : `Do not use sources from: ${domains.exclude.slice(0, 100).join(", ")}.`,
        ]
            .filter((line) => line !== "")
            .join(" ");
        const answer = (await request("xAI", "https://api.x.ai/v1/responses", {
            body: { model: MODEL, input: `${instructions}\n\n${search.query}`, tools: [{ type: "web_search" }] },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { output?: unknown; citations?: unknown };
        const output = (Array.isArray(answer.output) ? answer.output : []).filter(isItem);
        const parts = output.filter((item) => item.type === "message").flatMap((item) => (Array.isArray(item.content) ? item.content.filter(isItem) : []));
        const written = parts
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter((text) => text.trim() !== "")
            .join("\n")
            .trim();
        // Annotations first: they carry titles and the text they back, and win when a link comes twice.
        const cited = parts.flatMap((part) => {
            const text = typeof part.text === "string" ? part.text : "";

            return (Array.isArray(part.annotations) ? part.annotations.filter(isItem) : [])
                .filter((annotation) => annotation.type === "url_citation" && typeof annotation.url === "string" && annotation.url.trim() !== "")
                .map((annotation) => ({
                    title: clip(annotation.title, 200) || String(annotation.url),
                    url: String(annotation.url),
                    snippet: around(text, annotation.start_index, annotation.end_index),
                }));
        });
        const searched = output
            .filter((item) => item.type === "web_search_call")
            .flatMap((item) => [isItem(item.action) ? item.action.sources : undefined, item.sources, item.results])
            .flatMap((group) => (Array.isArray(group) ? group : []));
        const listed = Array.isArray(answer.citations) ? answer.citations : [];
        const results = tidy(
            [...cited, ...[...searched, ...listed].map(source).filter((result): result is SearchResult => result !== undefined)],
            search.numResults,
        );

        if (written === "" && results.length === 0) {
            throw new ProviderError("xAI", "answered with neither text nor sources");
        }

        return { answer: written, results };
    },
};

export default provider;
