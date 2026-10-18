/**
 * Web access for Pi, pi-web-access's tools made native (`web/`): `web_search` with the provider the owner picked in
 * Settings › Web access, and `fetch_content` for pages, documents (markit), GitHub, and images. Same names and
 * arguments as pi-web-access, so prompts written for it work here. Both only read, so plan mode allows them.
 */
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { PocketHost } from "../host.ts";
import { fetchContent, inline } from "../web/fetch.ts";
import type { Recency, SearchResult } from "../web/types.ts";

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const text = (value: string): Part => ({ type: "text", text: value });
const MAX_QUERIES = 5;
const MAX_URLS = 10;

/** One query's results, as the model reads them. */
function listed(query: string, provider: string, answer: string | undefined, results: readonly SearchResult[]): string {
    const lines = results.map(
        (result, index) => `${index + 1}. ${result.title || result.url}\n   ${result.url}${result.date ? ` (${result.date.slice(0, 10)})` : ""}${result.snippet ? `\n   ${result.snippet}` : ""}`,
    );

    return [`## ${query} (${provider}, ${results.length} result${results.length === 1 ? "" : "s"})`, ...(answer ? ["", answer] : []), "", ...(lines.length === 0 ? ["No results."] : lines)].join("\n");
}

export default function createWeb(host: PocketHost) {
    const search = defineTool({
        name: "web_search",
        description:
            "Search the web with the search provider the person picked in Settings › Web access. Returns titles, links, dates, and snippets (and an answer, for providers that write one). Read a result whole with fetch_content.",
        parameters: Type.Object({
            query: Type.Optional(Type.String({ description: "What to search for" })),
            queries: Type.Optional(Type.Array(Type.String(), { description: `Several searches at once (at most ${MAX_QUERIES})` })),
            numResults: Type.Optional(Type.Number({ description: "Results per query, 1 to 20 (default 5)" })),
            recencyFilter: Type.Optional(
                Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")], {
                    description: "Only results from the last day, week, month, or year",
                }),
            ),
            domainFilter: Type.Optional(
                Type.Array(Type.String(), { description: 'Domains to keep to; prefix with "-" to leave one out ("-reddit.com")' }),
            ),
            provider: Type.Optional(Type.String({ description: "Another set-up provider by its id, only when the person asks for it" })),
        }),
        replay: "safe",
        execute: async (args, _api, context) => {
            const signal = context.abortSignal ?? new AbortController().signal;
            const queries = [...(args.query === undefined ? [] : [args.query]), ...(args.queries ?? [])]
                .map((query) => query.trim())
                .filter((query) => query !== "");

            if (queries.length === 0) {
                return { output: [text("Give query or queries.")], isError: true };
            }

            if (queries.length > MAX_QUERIES) {
                return { output: [text(`At most ${MAX_QUERIES} queries at once.`)], isError: true };
            }

            const settled = await Promise.allSettled(
                queries.map((query) =>
                    host.web.search(query, {
                        numResults: args.numResults ?? 5,
                        ...(args.recencyFilter === undefined ? {} : { recency: args.recencyFilter as Recency }),
                        ...(args.domainFilter === undefined ? {} : { domains: args.domainFilter }),
                        ...(args.provider === undefined ? {} : { provider: args.provider }),
                        signal,
                    }),
                ),
            );
            const parts = settled.map((outcome, index) =>
                outcome.status === "fulfilled"
                    ? listed(queries[index]!, outcome.value.provider.name, outcome.value.response.answer, outcome.value.response.results)
                    : `## ${queries[index]}\n\n${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`,
            );
            const failed = settled.every((outcome) => outcome.status === "rejected");

            return {
                output: [text(parts.join("\n\n"))],
                details: {
                    queries: settled.map((outcome, index) => ({
                        query: queries[index]!,
                        ...(outcome.status === "fulfilled"
                            ? { provider: outcome.value.provider.id, results: outcome.value.response.results.map(({ title, url }) => ({ title, url })) }
                            : { error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }),
                    })),
                },
                ...(failed ? { isError: true } : {}),
            };
        },
    });

    const fetchTool = defineTool({
        name: "fetch_content",
        description:
            "Read web addresses: a page as Markdown (its main text), a document (PDF, Word, PowerPoint, Excel, EPUB, notebook, CSV, RSS) as Markdown, a GitHub repository cloned where this session works (its path, README, and files), a GitHub issue or pull request with its comments, a file on GitHub as text, an image as an image. Long text comes as its start and a file holding the rest.",
        parameters: Type.Object({
            url: Type.Optional(Type.String({ description: "An http:// or https:// address" })),
            urls: Type.Optional(Type.Array(Type.String(), { description: `Several at once (at most ${MAX_URLS})` })),
        }),
        replay: "safe",
        execute: async (args, api, context) => {
            const urls = [...(args.url === undefined ? [] : [args.url]), ...(args.urls ?? [])].map((url) => url.trim()).filter((url) => url !== "");

            if (urls.length === 0 || urls.length > MAX_URLS) {
                return { output: [text(`Give url, or urls (1 to ${MAX_URLS}).`)], isError: true };
            }

            const signal = context.abortSignal ?? new AbortController().signal;
            const cwd = (await api.agent(context)).cwd ?? "";
            const env = host.envOf(cwd);
            const output: Part[] = [];
            const details: { url: string; title?: string; how?: string; size?: number; error?: string }[] = [];

            for (const url of urls) {
                try {
                    const fetched = await fetchContent(url, env, signal, context);

                    if (fetched.kind === "image") {
                        output.push(text(`Image: ${fetched.url}`), { type: "image", data: fetched.data, mimeType: fetched.mimeType });
                        details.push({ url: fetched.url, how: "image", size: Math.round((fetched.data.length * 3) / 4) });
                    } else {
                        output.push(text(await inline(fetched, env, context, urls.length)));
                        details.push({ url: fetched.url, title: fetched.title, how: fetched.how, size: fetched.text.length });
                    }
                } catch (error) {
                    if (signal.aborted) {
                        throw error;
                    }

                    const message = error instanceof Error ? error.message : String(error);

                    output.push(text(`Could not read ${message}`));
                    details.push({ url, error: message });
                }
            }

            return { output, details: { urls: details }, ...(details.every((each) => each.error !== undefined) ? { isError: true } : {}) };
        },
    });

    return defineExtension({ name: "pocket-web", tools: [search, fetchTool] });
}
