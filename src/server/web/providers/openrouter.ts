/**
 * OpenRouter's web plugin (https://openrouter.ai/docs/guides/features/web-search): a chat completion with
 * `plugins: [{ id: "web" }]` searches with Exa and attaches the results, which come back as `url_citation` annotations.
 * The model only has to answer something, so it is told to say OK. It runs on a small model (gpt-oss-20b, a few cents per million tokens), with
 * the OpenRouter key of the Pi sign-in. Domain filters are the plugin's own; recency it does not take, so it is asked
 * for in the prompt. Not in pi-web-access: pi-phone's own.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const MODEL = "openai/gpt-oss-20b";
const RECENT = { day: "the last day", week: "the last week", month: "the last month", year: "the last year" };

const provider: SearchProvider = {
    id: "openrouter",
    name: "OpenRouter (Exa)",
    site: "https://openrouter.ai/settings/keys",
    key: { kind: "pi", provider: "openrouter" },
    price: "Exa's $4 per 1,000 results, plus a little for gpt-oss-20b",
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const answer = (await request("OpenRouter", "https://openrouter.ai/api/v1/chat/completions", {
            body: {
                model: MODEL,
                messages: [
                    {
                        role: "user",
                        content: `${search.query}${search.recency ? ` (from ${RECENT[search.recency]})` : ""}\nReply with OK.`,
                    },
                ],
                plugins: [
                    {
                        id: "web",
                        engine: "exa",
                        max_results: search.numResults,
                        ...(include.length === 0 ? {} : { include_domains: include }),
                        ...(exclude.length === 0 ? {} : { exclude_domains: exclude }),
                    },
                ],
                // The results are the plugin's annotations, not the model's words: it says as little as it may.
                max_tokens: 16,
            },
            headers: { authorization: `Bearer ${key}`, "x-title": "pi-phone" },
            signal: search.signal,
            key,
        })) as {
            choices?: {
                message?: {
                    content?: unknown;
                    annotations?: { type?: string; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }[];
                };
            }[];
        };
        const message = answer.choices?.[0]?.message;

        if (message === undefined) {
            throw new ProviderError("OpenRouter", "answered without a message");
        }

        return {
            results: tidy(
                (message.annotations ?? [])
                    .filter((annotation) => annotation.type === "url_citation")
                    .map(({ url_citation: citation }) => ({
                        title: clip(citation?.title, 200),
                        url: String(citation?.url ?? ""),
                        snippet: clip(citation?.content),
                    })),
                search.numResults,
            ),
        };
    },
};

export default provider;
