// Web search providers, batch b (Gemini, Jina, Kagi, Keenable, Kimi, Mistral, Ollama, xAI, XCrawl): each sends the
// request its API wants, with the key, query, count, recency, and domains, and reads the answer pi-web-access reads.
// A refusal names the provider and never the key. `fetch` is stubbed; nothing goes out.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProviderError, since } from "../src/server/web/http.ts";
import gemini from "../src/server/web/providers/gemini.ts";
import jina from "../src/server/web/providers/jina.ts";
import kagi from "../src/server/web/providers/kagi.ts";
import keenable from "../src/server/web/providers/keenable.ts";
import kimi from "../src/server/web/providers/kimi.ts";
import mistral from "../src/server/web/providers/mistral.ts";
import ollama from "../src/server/web/providers/ollama.ts";
import xai from "../src/server/web/providers/xai.ts";
import xcrawl from "../src/server/web/providers/xcrawl.ts";
import type { SearchProvider, SearchRequest } from "../src/server/web/types.ts";

const KEY = "sk-test-secret-1234";
const realFetch = globalThis.fetch;

interface Sent {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
}

/** Stub `fetch`: each call is recorded and answered by `answer` (JSON, or a Response as is). */
function stub(answer: (sent: Sent) => unknown, status = 200): Sent[] {
    const sent: Sent[] = [];

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        const call: Sent = {
            url: String(input),
            method: init?.method ?? "GET",
            headers: Object.fromEntries(new Headers(init?.headers).entries()),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };

        sent.push(call);
        const reply = answer(call);

        return reply instanceof Response ? reply : new Response(JSON.stringify(reply), { status, headers: { "content-type": "application/json" } });
    };

    return sent;
}

afterEach(() => {
    globalThis.fetch = realFetch;
});

const ask = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({ query: "node test runner", numResults: 3, signal: new AbortController().signal, ...overrides });

/** A refusal is a ProviderError that names `name` and quotes the answer, without the key. */
async function refuses(provider: SearchProvider, name: string, request: SearchRequest = ask()) {
    stub(() => ({ error: { message: `invalid key ${KEY}` } }), 401);

    await assert.rejects(provider.search(request, { key: KEY }), (error: unknown) => {
        assert.ok(error instanceof ProviderError, String(error));
        assert.match(error.message, new RegExp(`^${name}: `));
        assert.match(error.message, /refused/);
        assert.doesNotMatch(error.message, new RegExp(KEY));
        assert.equal(error.status, 401);
        return true;
    });
}

test("gemini: generateContent with Google Search grounding, the key in x-goog-api-key, redirects resolved", async () => {
    const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc";
    const sent = stub((call) =>
        call.url === redirect
            ? new Response(null, { status: 302, headers: { location: "https://nodejs.org/api/test.html" } })
            : {
                  candidates: [
                      {
                          content: { parts: [{ text: "Node has a built-in test runner." }, { text: "Run it with node --test." }] },
                          groundingMetadata: {
                              groundingChunks: [
                                  { web: { uri: redirect, title: "nodejs.org" } },
                                  { web: { uri: "https://example.com/a", title: "Example" } },
                                  { retrievedContext: {} },
                                  { web: { uri: "https://example.com/b", title: "B" } },
                                  { web: { uri: "https://example.com/c", title: "C" } },
                              ],
                          },
                      },
                  ],
              },
    );
    const answer = await gemini.search(ask({ recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const call = sent[0]!;

    assert.equal(call.url, "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent");
    assert.equal(call.method, "POST");
    assert.equal(call.headers["x-goog-api-key"], KEY);
    assert.doesNotMatch(call.url, /key=/);
    assert.deepEqual((call.body as { tools: unknown }).tools, [{ google_search: {} }]);
    const prompt = (call.body as { contents: { parts: { text: string }[] }[] }).contents[0]!.parts[0]!.text;
    assert.match(prompt, /^node test runner/);
    assert.match(prompt, /past week/);
    assert.match(prompt, /Only cite sources from: nodejs\.org/);
    assert.match(prompt, /Do not cite sources from: reddit\.com/);
    assert.equal(sent[1]!.method, "HEAD");
    assert.equal(answer.answer, "Node has a built-in test runner.\nRun it with node --test.");
    assert.deepEqual(answer.results, [
        { title: "nodejs.org", url: "https://nodejs.org/api/test.html", snippet: "" },
        { title: "Example", url: "https://example.com/a", snippet: "" },
        { title: "B", url: "https://example.com/b", snippet: "" },
    ]);
});

test("gemini: a refusal names Gemini, not the key", () => refuses(gemini, "Gemini"));

test("jina: GET s.jina.ai/<query> with count and site, exclusions and recency in the query, filtered again", async () => {
    const sent = stub(() => ({
        code: 200,
        data: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", description: "The node:test module  facilitates\ncreating tests." },
            { title: "Off domain", url: "https://reddit.com/r/node", description: "no" },
            { title: "", url: "https://docs.nodejs.org/x", description: "Docs" },
        ],
    }));
    const answer = await jina.search(ask({ recency: "month", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const url = new URL(sent[0]!.url);

    assert.equal(url.origin, "https://s.jina.ai");
    assert.equal(decodeURIComponent(url.pathname.slice(1)), "node test runner -site:reddit.com published in the past month");
    assert.equal(url.searchParams.get("count"), "3");
    assert.deepEqual(url.searchParams.getAll("site"), ["nodejs.org"]);
    assert.equal(sent[0]!.method, "GET");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.equal(sent[0]!.headers["x-respond-with"], "no-content");
    assert.equal(answer.answer, undefined);
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module facilitates creating tests." },
        { title: "Source 3", url: "https://docs.nodejs.org/x", snippet: "Docs" },
    ]);
});

test("jina: a failing envelope code is an error", async () => {
    stub(() => ({ code: 422, data: null }));
    await assert.rejects(jina.search(ask(), { key: KEY }), /^ProviderError: Jina: answered code 422/);
});

test("jina: a refusal names Jina, not the key", () => refuses(jina, "Jina"));

test("kagi: POST /api/v1/search with { query, limit }, results from data.search", async () => {
    const sent = stub(() => ({
        meta: { id: "x" },
        data: {
            search: [
                { url: "https://nodejs.org/api/test.html", title: "Test runner", snippet: "node:test" },
                [{ href: "https://example.com/n", name: "Nested", description: "nested list" }],
                { title: "no link" },
            ],
        },
    }));
    const answer = await kagi.search(ask(), { key: KEY });

    assert.equal(sent[0]!.url, "https://kagi.com/api/v1/search");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(sent[0]!.body, { query: "node test runner", limit: 3 });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test" },
        { title: "Nested", url: "https://example.com/n", snippet: "nested list" },
    ]);
});

test("kagi: errors in a 200 answer, and filters it does not take, are errors", async () => {
    stub(() => ({ errors: [{ code: 1, msg: "Insufficient credit" }] }));
    await assert.rejects(kagi.search(ask(), { key: KEY }), /Kagi: Insufficient credit/);
    await assert.rejects(kagi.search(ask({ recency: "day" }), { key: KEY }), /Kagi: .*no recency or domain filter/);
    await assert.rejects(kagi.search(ask({ domains: ["nodejs.org"] }), { key: KEY }), /Kagi: .*no recency or domain filter/);
});

test("kagi: a refusal names Kagi, not the key", () => refuses(kagi, "Kagi"));

test("keenable: keyed search with X-API-Key, one domain as site, recency as published_after", async () => {
    const sent = stub(() => ({
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The test runner", description: "" },
            { title: "Elsewhere", url: "https://example.com/", snippet: "filtered out" },
        ],
    }));
    const answer = await keenable.search(ask({ recency: "week", domains: ["nodejs.org"] }), { key: KEY });

    assert.equal(sent[0]!.url, "https://api.keenable.ai/v1/search");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers["x-api-key"], KEY);
    assert.equal(sent[0]!.headers["x-keenable-title"], "pi-phone");
    assert.deepEqual(sent[0]!.body, { query: "node test runner", max_results: 3, snippet_max_length: 500, site: "nodejs.org", published_after: since("week") });
    assert.deepEqual(answer.results, [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The test runner" }]);
});

test("keenable: without a key, the public endpoint; several domains and exclusions go in the query", async () => {
    const sent = stub(() => ({ results: [{ title: "A", url: "https://github.com/a", snippet: "", description: "desc" }] }));
    const answer = await keenable.search(ask({ domains: ["github.com", "gitlab.com", "-reddit.com"] }), {});

    assert.equal(sent[0]!.url, "https://api.keenable.ai/v1/search/public");
    assert.equal(sent[0]!.headers["x-api-key"], undefined);
    assert.deepEqual(sent[0]!.body, { query: "node test runner (site:github.com OR site:gitlab.com) -site:reddit.com", max_results: 8, snippet_max_length: 500 });
    assert.deepEqual(answer.results, [{ title: "A", url: "https://github.com/a", snippet: "desc" }]);

    stub(() => ({ message: "slow down" }), 429);
    await assert.rejects(keenable.search(ask(), {}), /^ProviderError: Keenable: too many requests.*KEENABLE_API_KEY in Settings › Secrets/);
});

test("keenable: a refusal names Keenable, not the key", () => refuses(keenable, "Keenable"));

test("kimi: POST /coding/v1/search with text_query and the Kimi Code token; count and domains applied here", async () => {
    const sent = stub(() => ({
        search_results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test docs" },
            { title: "Reddit", url: "https://www.reddit.com/r/node", snippet: "excluded" },
            { title: "", url: "https://example.com/1", snippet: "" },
            { title: "Two", url: "https://example.com/2", snippet: "" },
            { title: "Three", url: "https://example.com/3", snippet: "" },
        ],
    }));
    const answer = await kimi.search(ask({ domains: ["-reddit.com"] }), { key: KEY });

    assert.equal(sent[0]!.url, "https://api.kimi.com/coding/v1/search");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.match(sent[0]!.headers["x-msh-tool-call-id"]!, /^[0-9a-f-]{36}$/);
    assert.deepEqual(sent[0]!.body, { text_query: "node test runner" });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test docs" },
        { title: "https://example.com/1", url: "https://example.com/1", snippet: "" },
        { title: "Two", url: "https://example.com/2", snippet: "" },
    ]);
    await assert.rejects(kimi.search(ask({ recency: "day" }), { key: KEY }), /Kimi: .*no recency filter/);
});

test("kimi: a refusal names Kimi, not the key", () => refuses(kimi, "Kimi"));

test("mistral: Conversations with the web_search tool; text is the answer, tool_reference chunks the sources", async () => {
    const sent = stub(() => ({
        conversation_id: "c1",
        outputs: [
            { type: "tool.execution", name: "web_search" },
            {
                type: "message.output",
                content: [
                    { type: "text", text: "Node ships a test runner." },
                    { type: "tool_reference", tool: "web_search", title: "Test runner", url: "https://nodejs.org/api/test.html", description: "node:test" },
                    { type: "tool_reference", tool: "web_search", title: "Reddit", url: "https://reddit.com/r/node" },
                    { type: "text", text: "Use node --test." },
                ],
            },
        ],
    }));
    const answer = await mistral.search(ask({ recency: "year", domains: ["-reddit.com"] }), { key: KEY });

    assert.equal(sent[0]!.url, "https://api.mistral.ai/v1/conversations");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    const body = sent[0]!.body as { inputs: { role: string; content: string }[]; stream: boolean; model: string; tools: unknown };
    assert.equal(body.model, "mistral-small-latest");
    assert.equal(body.stream, false);
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.equal(body.inputs[0]!.content, "Prefer sources from the past year. Prefer up to 3 distinct sources. Do not use sources from: reddit.com.\n\nnode test runner");
    assert.equal(answer.answer, "Node ships a test runner.\nUse node --test.");
    assert.deepEqual(answer.results, [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test" }]);
});

test("mistral: a refusal names Mistral, not the key", () => refuses(mistral, "Mistral"));

test("ollama: POST ollama.com/api/web_search with { query, max_results } at most 10", async () => {
    const sent = stub(() => ({
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", content: "The node:test module\n\nfacilitates tests." },
            { title: "Example", url: "https://example.com/", content: "" },
        ],
    }));
    const answer = await ollama.search(ask({ numResults: 15 }), { key: KEY });

    assert.equal(sent[0]!.url, "https://ollama.com/api/web_search");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(sent[0]!.body, { query: "node test runner", max_results: 10 });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module facilitates tests." },
        { title: "Example", url: "https://example.com/", snippet: "" },
    ]);
    stub(() => ({ results: [{ title: "x", url: "https://x.y" }] }));
    await assert.rejects(ollama.search(ask(), { key: KEY }), /Ollama: result 1 is not/);
    await assert.rejects(ollama.search(ask({ recency: "week" }), { key: KEY }), /Ollama: .*no recency or domain filter/);
});

test("ollama: a refusal names Ollama, not the key", () => refuses(ollama, "Ollama"));

test("xai: Responses with web_search on grok-4.5; citations, then search sources, then the citation list", async () => {
    const text = "Node has a built-in test runner [nodejs.org](https://nodejs.org/api/test.html) since v18.";
    const sent = stub(() => ({
        id: "resp_1",
        output: [
            { type: "web_search_call", status: "completed", action: { type: "search", query: "node test runner", sources: [{ url: "https://example.com/a", title: "A" }] } },
            {
                type: "message",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text,
                        annotations: [{ type: "url_citation", url: "https://nodejs.org/api/test.html", title: "Test runner", start_index: 33, end_index: 77 }],
                    },
                ],
            },
        ],
        citations: ["https://nodejs.org/api/test.html", "https://example.com/b", "https://example.com/c"],
    }));
    const answer = await xai.search(ask({ recency: "day", domains: ["nodejs.org"] }), { key: KEY });

    assert.equal(sent[0]!.url, "https://api.x.ai/v1/responses");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    const body = sent[0]!.body as { model: string; input: string; tools: unknown };
    assert.equal(body.model, "grok-4.5");
    assert.deepEqual(body.tools, [{ type: "web_search" }]);
    assert.match(body.input, /^Search the web .* Prefer sources from the past 24 hours\. Prefer around 3 distinct sources\. Only use sources from: nodejs\.org\.\n\nnode test runner$/);
    assert.equal(answer.answer, text);
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "Node has a built-in test runner nodejs.org since v18." },
        { title: "A", url: "https://example.com/a", snippet: "" },
        { title: "https://example.com/b", url: "https://example.com/b", snippet: "" },
    ]);
});

test("xai: a refusal names xAI, not the key", () => refuses(xai, "xAI"));

test("xcrawl: POST /v1/serp with google_search; relative links made absolute, domains and count applied here", async () => {
    const sent = stub(() => ({
        search_metadata: { status: "completed", id: "s1" },
        organic_results: [
            { position: 1, title: "Test runner", link: "https://nodejs.org/api/test.html", snippet: "node:test" },
            { position: 2, title: null, link: "/goto?url=https%3A%2F%2Fnodejs.org", snippet: null },
            { position: 3, title: "Reddit", link: "https://reddit.com/r/node", snippet: "x" },
        ],
    }));
    const answer = await xcrawl.search(ask({ domains: ["-reddit.com"] }), { key: KEY });

    assert.equal(sent[0]!.url, "https://run.xcrawl.com/v1/serp");
    assert.equal(sent[0]!.method, "POST");
    assert.equal(sent[0]!.headers.authorization, `Bearer ${KEY}`);
    assert.deepEqual(sent[0]!.body, { engine: "google_search", q: "node test runner" });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test" },
        { title: "https://run.xcrawl.com/goto?url=https%3A%2F%2Fnodejs.org", url: "https://run.xcrawl.com/goto?url=https%3A%2F%2Fnodejs.org", snippet: "" },
    ]);
    stub(() => ({ search_metadata: { status: "processing" }, organic_results: [] }));
    await assert.rejects(xcrawl.search(ask(), { key: KEY }), /XCrawl: the search is "processing"/);
    await assert.rejects(xcrawl.search(ask({ recency: "week" }), { key: KEY }), /XCrawl: .*no recency filter/);
});

test("xcrawl: a refusal names XCrawl, not the key", () => refuses(xcrawl, "XCrawl"));

test("every provider says where its key comes from", () => {
    assert.deepEqual(
        [gemini, jina, kagi, keenable, kimi, mistral, ollama, xai, xcrawl].map((provider) => [provider.id, provider.key]),
        [
            ["gemini", { kind: "pi", provider: "google" }],
            ["jina", { kind: "secret", secret: "JINA_API_KEY" }],
            ["kagi", { kind: "secret", secret: "KAGI_API_KEY" }],
            ["keenable", { kind: "secret", secret: "KEENABLE_API_KEY", optional: true }],
            ["kimi", { kind: "pi", provider: "kimi-coding" }],
            ["mistral", { kind: "pi", provider: "mistral" }],
            ["ollama", { kind: "secret", secret: "OLLAMA_API_KEY" }],
            ["xai", { kind: "pi", provider: "xai" }],
            ["xcrawl", { kind: "secret", secret: "XCRAWL_API_KEY" }],
        ],
    );
});
