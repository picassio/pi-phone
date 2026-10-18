/**
 * Gemini API with Google Search grounding (https://ai.google.dev/gemini-api/docs/google-search), with the Gemini API
 * key of the Pi sign-in "google", sent only in `x-goog-api-key`. Gemini writes the answer; the sources are the
 * grounding chunks, whose links are Google redirects (`vertexaisearch.cloud.google.com/grounding-api-redirect/…`)
 * resolved here to the page they point at. The grounding tool takes no filters: recency and domains are asked for in
 * the prompt. Ported from pi-web-access's `gemini-search.ts` (MIT); its Gemini Web path (browser cookies), Cloudflare
 * gateway, and Vertex ADC are left out.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider, SearchRequest, SearchResult } from "../types.ts";

const MODEL = "gemini-3.6-flash";
const REDIRECT = "vertexaisearch.cloud.google.com/grounding-api-redirect";
const REDIRECT_TIMEOUT_MS = 5_000;

const RECENCY_LABEL = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" } as const;

interface GeminiAnswer {
    candidates?: {
        content?: { parts?: { text?: unknown }[] };
        groundingMetadata?: { groundingChunks?: { web?: { uri?: unknown; title?: unknown } }[] };
    }[];
}

/** The query, with recency and domains as the sentences pi-web-access asks Gemini for them with. */
function prompt(search: SearchRequest): string {
    const { include, exclude } = splitDomains(search.domains);

    return [
        search.query.trim(),
        search.recency ? `Only include results from the ${RECENCY_LABEL[search.recency]}.` : "",
        include.length === 0 ? "" : `Only cite sources from: ${include.join(", ")}`,
        exclude.length === 0 ? "" : `Do not cite sources from: ${exclude.join(", ")}`,
    ]
        .filter((part) => part !== "")
        .join("\n\n");
}

/**
 * Where a grounding redirect leads: its `location`, read without following it. A redirect that does not answer in
 * 5 s keeps its own link, which still leads to the page.
 */
async function resolve(url: string, signal: AbortSignal): Promise<string> {
    if (!url.includes(REDIRECT)) {
        return url;
    }

    try {
        const response = await fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.any([signal, AbortSignal.timeout(REDIRECT_TIMEOUT_MS)]) });

        return response.headers.get("location") || url;
    } catch (error) {
        if (signal.aborted) {
            throw error;
        }

        return url;
    }
}

const provider: SearchProvider = {
    id: "gemini",
    name: "Gemini (Google Search grounding)",
    site: "https://aistudio.google.com/apikey",
    key: { kind: "pi", provider: "google" },
    async search(search, { key }) {
        const answer = (await request("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
            body: { contents: [{ role: "user", parts: [{ text: prompt(search) }] }], tools: [{ google_search: {} }] },
            headers: { "x-goog-api-key": `${key}` },
            signal: search.signal,
            key,
        })) as GeminiAnswer;
        const candidate = answer.candidates?.[0];
        const text = (candidate?.content?.parts ?? [])
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .filter((part) => part !== "")
            .join("\n");
        const chunks = (candidate?.groundingMetadata?.groundingChunks ?? []).flatMap((chunk) =>
            typeof chunk.web?.uri === "string" && chunk.web.uri !== "" ? [{ title: clip(chunk.web.title, 200), uri: chunk.web.uri }] : [],
        );
        const results: SearchResult[] = await Promise.all(
            chunks.map(async (chunk) => ({ title: chunk.title, url: await resolve(chunk.uri, search.signal), snippet: "" })),
        );

        if (text.trim() === "" && results.length === 0) {
            throw new ProviderError("Gemini", "answered with neither text nor sources");
        }

        return { answer: text.trim(), results: tidy(results, search.numResults) };
    },
};

export default provider;
