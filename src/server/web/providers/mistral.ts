/**
 * Mistral's Conversations API with its built-in `web_search` tool (https://docs.mistral.ai/agents/connectors/websearch/):
 * `POST https://api.mistral.ai/v1/conversations` with the Mistral API key of the Pi sign-in, on `mistral-small-latest`.
 * Mistral writes the answer; its `tool_reference` chunks are the sources. The tool takes no filters, so recency, the
 * count, and domains are asked for in the prompt, and the count and domains are applied again to the sources. Ported
 * from pi-web-access's `mistral-search.ts` (MIT).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchResult } from "../types.ts";

const MODEL = "mistral-small-latest";

const RECENCY_LABEL = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" } as const;

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
    id: "mistral",
    name: "Mistral web search",
    site: "https://console.mistral.ai/api-keys",
    key: { kind: "pi", provider: "mistral" },
    async search(search, { key }) {
        const domains = splitDomains(search.domains);
        const guidance = [
            search.recency ? `Prefer sources from the ${RECENCY_LABEL[search.recency]}.` : "",
            `Prefer up to ${search.numResults} distinct sources.`,
            domains.include.length === 0 ? "" : `Only use sources from: ${domains.include.slice(0, 100).join(", ")}.`,
            domains.exclude.length === 0 ? "" : `Do not use sources from: ${domains.exclude.slice(0, 100).join(", ")}.`,
        ]
            .filter((line) => line !== "")
            .join(" ");
        const answer = (await request("Mistral", "https://api.mistral.ai/v1/conversations", {
            body: { inputs: [{ role: "user", content: `${guidance}\n\n${search.query}` }], stream: false, model: MODEL, tools: [{ type: "web_search" }] },
            headers: { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        })) as { outputs?: unknown };

        if (!Array.isArray(answer.outputs)) {
            throw new ProviderError("Mistral", "answered without outputs");
        }

        const text: string[] = [];
        const results: SearchResult[] = [];

        for (const output of answer.outputs as { type?: unknown; content?: unknown }[]) {
            if (output?.type !== "message.output") {
                continue;
            }

            // The content is a string, or chunks of text and references.
            if (typeof output.content === "string") {
                text.push(output.content.trim());
                continue;
            }

            for (const chunk of Array.isArray(output.content) ? (output.content as Record<string, unknown>[]) : []) {
                if (chunk?.type === "text" && typeof chunk.text === "string") {
                    text.push(chunk.text.trim());
                } else if (chunk?.type === "tool_reference" && typeof chunk.url === "string" && inDomains(chunk.url.trim(), domains)) {
                    const url = chunk.url.trim();

                    results.push({ title: clip(chunk.title, 200) || url, url, snippet: clip(chunk.description) });
                }
            }
        }

        const written = text.filter((part) => part !== "").join("\n").trim();
        const sources = tidy(results, search.numResults);

        if (written === "" && sources.length === 0) {
            throw new ProviderError("Mistral", "answered with neither text nor sources");
        }

        return { answer: written, results: sources };
    },
};

export default provider;
