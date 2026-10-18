/**
 * OpenAI's Responses API with its hosted `web_search` tool (https://platform.openai.com/docs/guides/tools-web-search):
 * a model searches and writes a cited answer, with the key of the Pi "openai" sign-in. The answer's `url_citation`
 * annotations and the call's `sources` are the results. Domains go to the tool's `filters`; count and recency are only
 * asked for in the instructions, as the tool takes neither. Ported from pi-web-access's `openai-search.ts` (MIT), the
 * API-key path only: no ChatGPT/Codex endpoint, no alpha/search, and the model it uses with a bare key.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { Recency, SearchProvider, SearchRequest, SearchResult } from "../types.ts";

const RESPONSES_URL = "https://api.openai.com/v1/responses";
/** pi-web-access's model when only an API key is set: the low-cost "luna" one. */
const MODEL = "gpt-6-luna";
/** The tool takes at most 100 domains of each kind. */
const MAX_DOMAINS = 100;

const RECENCY_LABEL: Record<Recency, string> = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };

type Json = Record<string, unknown>;

const record = (value: unknown): Json | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** What the model is told: search, cite, and the count, recency, and domains the tool cannot take. */
function instructions(search: SearchRequest, include: string[], exclude: string[]): string {
    return [
        "Search the web and return a concise answer grounded only in the web results.",
        "Include clickable source citations in the response text when possible.",
        search.recency ? `Prefer sources from the ${RECENCY_LABEL[search.recency]}.` : "",
        `Prefer around ${search.numResults} distinct sources.`,
        include.length > 0 ? `Only use sources from: ${include.join(", ")}.` : "",
        exclude.length > 0 ? `Do not use sources from: ${exclude.join(", ")}.` : "",
    ]
        .filter((line) => line !== "")
        .join(" ");
}

/**
 * The output items of a streamed answer, and whether it searched at all. The stream can fail after HTTP 200: an
 * `error` event or `response.failed` carries the real error (quota, …), which wins over any partial output.
 */
function readStream(text: string): { output: unknown[]; searched: boolean } {
    const items: unknown[] = [];
    let completed: Json | undefined;
    let searched = false;
    let failure: Json | undefined;

    for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) {
            continue;
        }

        const data = line.slice(6).trim();
        let event: Json | undefined;

        try {
            event = data === "" || data === "[DONE]" ? undefined : record(JSON.parse(data));
        } catch {
            // A line that is not JSON is not an event.
        }

        if (event === undefined) {
            continue;
        }

        const type = typeof event.type === "string" ? event.type : "";

        if (type === "error") {
            failure ??= record(event.error) ?? { code: event.code, message: typeof event.error === "string" ? event.error : event.message };
        }

        if (type.startsWith("response.web_search_call")) {
            searched = true;
        }

        if (type === "response.output_item.done" && event.item !== undefined) {
            items.push(event.item);
            searched ||= record(event.item)?.type === "web_search_call";
        }

        const response = record(event.response);

        if (response && ["response.failed", "response.incomplete", "response.done", "response.completed"].includes(type)) {
            completed = response;
            failure ??= record(response.error);

            if (type === "response.failed") {
                failure ??= { message: "the answer stream failed without saying why" };
            }
        }
    }

    if (failure) {
        const detail = [failure.type, failure.code].filter((part) => typeof part === "string" && part !== "").join("/");
        const message = typeof failure.message === "string" && failure.message.trim() !== "" ? failure.message : "the answer stream failed";

        throw new ProviderError("OpenAI", `${detail === "" ? "" : `${detail}: `}${message}`);
    }

    const finished = list(completed?.output);
    const output = finished.length > 0 ? finished : items;

    if (completed === undefined && items.length === 0) {
        throw new ProviderError("OpenAI", "answered no response output");
    }

    return { output, searched: searched || output.some((item) => record(item)?.type === "web_search_call") };
}

/** The link without the `utm_source=openai` OpenAI adds. */
function cleanUrl(raw: string): string {
    try {
        const url = new URL(raw);

        if (url.searchParams.get("utm_source") === "openai") {
            url.searchParams.delete("utm_source");
        }

        return url.toString();
    } catch {
        return raw.replace(/[?&]utm_source=openai$/, "");
    }
}

/** The answer's text around a citation, Markdown links reduced to their text. */
function around(text: string, start: unknown, end: unknown): string {
    if (typeof start !== "number" || typeof end !== "number") {
        return "";
    }

    return clip(text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100)).replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"), 300);
}

/** The message items' text parts. */
const textParts = (output: unknown[]) =>
    output
        .map(record)
        .filter((item) => item?.type === "message")
        .flatMap((item) => list(item?.content).map(record))
        .filter((part): part is Json => part !== undefined);

/** Cited pages first, with the text around each citation, then the other pages the search looked at. */
function results(output: unknown[]): SearchResult[] {
    const found: SearchResult[] = [];
    const add = (url: unknown, title: unknown, snippet: string) => {
        if (typeof url === "string" && url.trim() !== "") {
            const clean = cleanUrl(url);

            found.push({ title: clip(title, 200) || clean, url: clean, snippet });
        }
    };

    for (const part of textParts(output)) {
        const text = typeof part.text === "string" ? part.text : "";

        for (const annotation of list(part.annotations).map(record)) {
            if (annotation?.type === "url_citation") {
                add(annotation.url, annotation.title, around(text, annotation.start_index, annotation.end_index));
            }
        }
    }

    for (const call of output.map(record).filter((item) => item?.type === "web_search_call")) {
        for (const group of [record(call?.action)?.sources, call?.sources, call?.results]) {
            for (const source of list(group).map(record)) {
                add(source?.url ?? source?.source_website_url, source?.title ?? source?.caption, "");
            }
        }
    }

    return found;
}

const provider: SearchProvider = {
    id: "openai",
    name: "OpenAI",
    site: "https://platform.openai.com/api-keys",
    key: { kind: "pi", provider: "openai" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const allowed = include.slice(0, MAX_DOMAINS);
        const blocked = exclude.slice(0, MAX_DOMAINS);
        const stream = (await request("OpenAI", RESPONSES_URL, {
            body: {
                model: MODEL,
                instructions: instructions(search, allowed, blocked),
                input: [{ role: "user", content: [{ type: "input_text", text: search.query }] }],
                tools: [
                    {
                        type: "web_search",
                        ...(allowed.length + blocked.length === 0
                            ? {}
                            : {
                                  filters: {
                                      ...(allowed.length > 0 ? { allowed_domains: allowed } : {}),
                                      ...(blocked.length > 0 ? { blocked_domains: blocked } : {}),
                                  },
                              }),
                    },
                ],
                include: ["web_search_call.action.sources"],
                store: false,
                stream: true,
                tool_choice: "required",
                parallel_tool_calls: true,
            },
            headers: { authorization: `Bearer ${key}`, "openai-beta": "responses=experimental" },
            signal: search.signal,
            key,
            text: true,
        })) as string;
        const { output, searched } = readStream(stream);

        if (!searched) {
            throw new ProviderError("OpenAI", "the model answered without searching the web");
        }

        const answer = textParts(output)
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter((text) => text.trim() !== "")
            .join("\n")
            .trim();
        const found = tidy(results(output), search.numResults);

        if (answer === "" && found.length === 0) {
            throw new ProviderError("OpenAI", "the search gave no answer and no sources");
        }

        return { ...(answer === "" ? {} : { answer }), results: found };
    },
};

export default provider;
