// Web search providers, batch C (OpenAI to TinyFish): each one's request as its API wants it, and its answer read
// into results, against a stubbed fetch with answers shaped as the API gives them. A failure names the provider and
// never shows the key.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProviderError, since } from "../src/server/web/http.ts";
import openai from "../src/server/web/providers/openai.ts";
import parallelMcp from "../src/server/web/providers/parallel-mcp.ts";
import parallel from "../src/server/web/providers/parallel.ts";
import perplexity from "../src/server/web/providers/perplexity.ts";
import querit from "../src/server/web/providers/querit.ts";
import search1api from "../src/server/web/providers/search1api.ts";
import searchinfinity from "../src/server/web/providers/searchinfinity.ts";
import searxng from "../src/server/web/providers/searxng.ts";
import serpapi from "../src/server/web/providers/serpapi.ts";
import serpbase from "../src/server/web/providers/serpbase.ts";
import serpdive from "../src/server/web/providers/serpdive.ts";
import serper from "../src/server/web/providers/serper.ts";
import serply from "../src/server/web/providers/serply.ts";
import tavily from "../src/server/web/providers/tavily.ts";
import tinyfish from "../src/server/web/providers/tinyfish.ts";
import type { Credentials, SearchProvider, SearchRequest } from "../src/server/web/types.ts";

const KEY = "sk-test-0123456789abcdef";
const realFetch = globalThis.fetch;

interface Sent {
    url: URL;
    method: string;
    headers: Headers;
    body: Record<string, unknown> | undefined;
}

/** fetch answers `answers` in turn (the last one again after that) and keeps what was sent. */
function stub(...answers: (() => Response)[]): Sent[] {
    const sent: Sent[] = [];

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
        sent.push({
            url: new URL(String(input)),
            method: init?.method ?? "GET",
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
        });

        return answers[Math.min(sent.length - 1, answers.length - 1)]!();
    };

    return sent;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => () =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

const ask = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({
    query: "node test runner",
    numResults: 3,
    signal: new AbortController().signal,
    ...overrides,
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

test("openai: the Responses API with the web_search tool, cited pages and the sources it looked at", async () => {
    const events = [
        {
            type: "response.output_item.done",
            item: {
                type: "web_search_call",
                id: "ws_1",
                status: "completed",
                action: {
                    type: "search",
                    query: "node test runner",
                    sources: [
                        { type: "url", url: "https://nodejs.org/api/test.html" },
                        { type: "url", url: "https://nodejs.org/en/learn/test-runner" },
                    ],
                },
            },
        },
        {
            type: "response.output_item.done",
            item: {
                type: "message",
                role: "assistant",
                content: [
                    {
                        type: "output_text",
                        text: "Node has a built-in test runner, node:test ([Test runner | Node.js](https://nodejs.org/api/test.html?utm_source=openai)).",
                        annotations: [
                            {
                                type: "url_citation",
                                start_index: 44,
                                end_index: 120,
                                url: "https://nodejs.org/api/test.html?utm_source=openai",
                                title: "Test runner | Node.js",
                            },
                        ],
                    },
                ],
            },
        },
        { type: "response.completed", response: { id: "resp_1", status: "completed", output: [] } },
    ];
    const sent = stub(() => new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } }));
    const answer = await openai.search(ask({ recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(sent.length, 1);
    assert.equal(url.href, "https://api.openai.com/v1/responses");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(body?.model, "gpt-6-luna");
    assert.equal(body?.stream, true);
    assert.equal(body?.tool_choice, "required");
    assert.deepEqual(body?.input, [{ role: "user", content: [{ type: "input_text", text: "node test runner" }] }]);
    assert.deepEqual(body?.tools, [{ type: "web_search", filters: { allowed_domains: ["nodejs.org"], blocked_domains: ["reddit.com"] } }]);
    assert.deepEqual(body?.include, ["web_search_call.action.sources"]);
    assert.match(String(body?.instructions), /past week/);
    assert.match(String(body?.instructions), /around 3 distinct sources/);
    assert.match(String(body?.instructions), /Only use sources from: nodejs\.org\./);

    assert.match(answer.answer ?? "", /^Node has a built-in test runner/);
    assert.deepEqual(
        answer.results.map((result) => [result.title, result.url]),
        [
            ["Test runner | Node.js", "https://nodejs.org/api/test.html"],
            ["https://nodejs.org/en/learn/test-runner", "https://nodejs.org/en/learn/test-runner"],
        ],
    );
    assert.match(answer.results[0]!.snippet, /built-in test runner/);
    assert.doesNotMatch(answer.results[0]!.snippet, /\]\(/);
});

test("openai: an error inside a 200 stream, and an answer that never searched, fail", async () => {
    stub(() => new Response(`data: ${JSON.stringify({ type: "error", error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota" } })}\n\n`));
    await assert.rejects(openai.search(ask(), { key: KEY }), (error: Error) => error instanceof ProviderError && /^OpenAI: insufficient_quota\/insufficient_quota: You exceeded/.test(error.message));

    stub(() =>
        new Response(
            `data: ${JSON.stringify({ type: "response.completed", response: { output: [{ type: "message", content: [{ type: "output_text", text: "From memory.", annotations: [] }] }] } })}\n\n`,
        ),
    );
    await assert.rejects(openai.search(ask(), { key: KEY }), /OpenAI: the model answered without searching/);
});

test("parallel: objective, query, max_results, and the source policy; excerpts are the snippet", async () => {
    const sent = stub(
        json({
            search_id: "search_1",
            results: [
                { url: "https://nodejs.org/api/test.html", title: "Test runner | Node.js", publish_date: "2025-01-02", excerpts: ["The node:test module", "facilitates tests."] },
                { url: "https://nodejs.org/en/learn", title: null, publish_date: null, excerpts: [] },
            ],
        }),
    );
    const answer = await parallel.search(ask({ recency: "month", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.parallel.ai/v1/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("x-api-key"), KEY);
    assert.deepEqual(body, {
        objective: "node test runner",
        search_queries: ["node test runner"],
        advanced_settings: { max_results: 3, source_policy: { include_domains: ["nodejs.org"], exclude_domains: ["reddit.com"], after_date: since("month") } },
    });
    assert.deepEqual(answer, {
        results: [
            { title: "Test runner | Node.js", url: "https://nodejs.org/api/test.html", snippet: "The node:test module facilitates tests.", date: "2025-01-02" },
            { title: "https://nodejs.org/en/learn", url: "https://nodejs.org/en/learn", snippet: "" },
        ],
    });
});

test("parallel-mcp: web_search over MCP, filters in the query and checked again, the key as an optional bearer", async () => {
    const payload = {
        search_id: "search_2",
        results: [
            { url: "https://www.reddit.com/r/node/1", title: "Reddit", publish_date: null, excerpts: ["no"] },
            { url: "https://nodejs.org/api/test.html", title: "Test runner", publish_date: "2025-02-03", excerpts: ["node:test runs tests."] },
            { url: "https://example.com/elsewhere", title: "Elsewhere", excerpts: ["off-domain"] },
        ],
    };
    const sent = stub(
        json({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "Parallel" } } }, 200, { "mcp-session-id": "s1" }),
        () => new Response(null, { status: 202 }),
        json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } }),
    );
    const answer = await parallelMcp.search(ask({ recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const call = sent[2]!;

    assert.equal(sent.length, 3);
    assert.equal(call.url.href, "https://search.parallel.ai/mcp");
    assert.equal(call.method, "POST");
    assert.equal(call.headers.get("authorization"), `Bearer ${KEY}`);
    assert.equal(call.headers.get("user-agent"), "pi-phone");
    assert.equal(call.headers.get("mcp-session-id"), "s1");
    assert.deepEqual(call.body?.params, {
        name: "web_search",
        arguments: { objective: "node test runner", search_queries: ["node test runner site:nodejs.org -site:reddit.com past week"] },
    });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test runs tests.", date: "2025-02-03" }] });

    // Without a key, and the text form of the answer.
    const keyless = stub(
        json({ jsonrpc: "2.0", id: 1, result: {} }),
        () => new Response(null, { status: 202 }),
        json({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "Title: One\nURL: https://a.example/1\nText: First page.\n---\nTitle: Two\nURL: https://b.example/2\nText: Second page.\n---" }] } }),
    );
    const plain = await parallelMcp.search(ask({ numResults: 1 }), {});

    assert.equal(keyless[2]!.headers.get("authorization"), null);
    assert.deepEqual(plain.results, [{ title: "One", url: "https://a.example/1", snippet: "First page." }]);
});

test("perplexity: the Search API with max_results, recency, and a domain filter where -domain leaves one out", async () => {
    const sent = stub(
        json({
            id: "p1",
            results: [{ title: "Test runner | Node.js", url: "https://nodejs.org/api/test.html", snippet: "The node:test module…", date: "2025-03-01", last_updated: "2025-04-01" }],
        }),
    );
    const answer = await perplexity.search(ask({ recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.perplexity.ai/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, {
        query: "node test runner",
        max_results: 3,
        search_type: "fast",
        search_context_size: "medium",
        search_recency_filter: "week",
        search_domain_filter: ["nodejs.org", "-reddit.com"],
    });
    assert.deepEqual(answer, { results: [{ title: "Test runner | Node.js", url: "https://nodejs.org/api/test.html", snippet: "The node:test module…", date: "2025-03-01" }] });
});

test("querit: count, filters.sites, and filters.timeRange; its own error_code is checked", async () => {
    const sent = stub(
        json({
            error_code: 200,
            error_msg: "",
            search_id: 7,
            results: { result: [{ url: "https://nodejs.org/api/test.html", title: "Test runner", snippet: "node:test  runs\ntests", page_age: "2025-01-05", site_name: "Node.js" }] },
        }),
    );
    const answer = await querit.search(ask({ recency: "day", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.querit.ai/v1/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, { query: "node test runner", count: 3, filters: { sites: { include: ["nodejs.org"], exclude: ["reddit.com"] }, timeRange: { date: "d1" } } });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "node:test runs tests", date: "2025-01-05" }] });

    stub(json({ error_code: 401, error_msg: "invalid api key" }));
    await assert.rejects(querit.search(ask(), { key: KEY }), /^ProviderError: Querit: error 401: invalid api key$|Querit: error 401: invalid api key/);
});

test("search1api: max_results, include/exclude sites, and time_range, never a deep search", async () => {
    const sent = stub(
        json({
            searchParameters: { query: "node test runner", max_results: 3 },
            results: [{ title: "Test runner", link: "https://nodejs.org/api/test.html", snippet: "The node:test module", content: "" }],
        }),
    );
    const answer = await search1api.search(ask({ recency: "year", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.search1api.com/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, { query: "node test runner", max_results: 3, crawl_results: 0, include_sites: ["nodejs.org"], exclude_sites: ["reddit.com"], time_range: "year" });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module" }] });
});

test("searchinfinity: Count, Filter, TimeRange; the Summary over the Snippet; its business errors and domain limit", async () => {
    const sent = stub(
        json({
            ResponseMetadata: { RequestId: "r1" },
            Result: {
                ResultCount: 2,
                WebResults: [
                    { Id: "1", SortId: 1, Title: "Test runner", SiteName: "Node.js", Url: "https://nodejs.org/api/test.html", Snippet: "snippet", Summary: "A summary for models.", PublishTime: "2025-01-02T03:04:05+08:00" },
                    { Id: "2", SortId: 2, Title: "Deno test", Url: "https://deno.com/test", Snippet: "Deno snippet", Summary: "", PublishTime: "" },
                ],
                SearchContext: { OriginQuery: "node test runner", SearchType: "web" },
            },
        }),
    );
    const answer = await searchinfinity.search(ask({ recency: "week", domains: ["nodejs.org", "deno.com", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://torchlight.byteintlapi.com/search_api/web_search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, { Query: "node test runner", Count: 3, Filter: { Sites: "nodejs.org|deno.com", BlockHosts: "reddit.com" }, TimeRange: "OneWeek" });
    assert.deepEqual(answer, {
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "A summary for models.", date: "2025-01-02T03:04:05+08:00" },
            { title: "Deno test", url: "https://deno.com/test", snippet: "Deno snippet" },
        ],
    });

    stub(json({ ResponseMetadata: { RequestId: "r2", Error: { CodeN: 700901, Code: "invalid_api_key", Message: "Invalid API key" } }, Result: null }));
    await assert.rejects(searchinfinity.search(ask(), { key: KEY }), /Searchinfinity: Invalid API key \(code 700901 invalid_api_key\)/);

    const none = stub(json({}));
    await assert.rejects(searchinfinity.search(ask({ domains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"] }), { key: KEY }), /Searchinfinity: it takes at most 5/);
    assert.equal(none.length, 0);
});

test("searxng: the instance's JSON search, site operators checked again, its answers, and a clear error without the address or the format", async () => {
    const sent = stub(
        json({
            query: "node test runner",
            number_of_results: 0,
            results: [
                { url: "https://www.reddit.com/r/node", title: "Reddit", content: "no", engine: "google" },
                { url: "https://nodejs.org/api/test.html", title: "Test runner", content: "The node:test module", publishedDate: "2025-01-02T00:00:00", engine: "google" },
                { url: "https://nodejs.org/en/learn", title: "Learn", content: "Learn Node", engine: "bing" },
                { url: "https://docs.nodejs.org/x", title: "Docs", content: "More", engine: "bing" },
            ],
            answers: ["Node 18 added node:test.", { answer: "Stable since Node 20.", url: "https://nodejs.org" }],
        }),
    );
    const answer = await searxng.search(ask({ numResults: 2, recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { endpoint: "http://192.168.1.50:8080/" });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.origin + url.pathname, "http://192.168.1.50:8080/search");
    assert.equal(method, "GET");
    assert.equal(body, undefined);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("accept"), "application/json");
    assert.equal(url.searchParams.get("q"), "node test runner site:nodejs.org -site:reddit.com");
    assert.equal(url.searchParams.get("format"), "json");
    assert.equal(url.searchParams.get("time_range"), "week");
    assert.deepEqual(answer, {
        answer: "Node 18 added node:test.\n\nStable since Node 20.",
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module", date: "2025-01-02T00:00:00" },
            { title: "Learn", url: "https://nodejs.org/en/learn", snippet: "Learn Node" },
        ],
    });

    await assert.rejects(searxng.search(ask(), {}), /SearXNG: set the address of your SearXNG instance in Settings › Web access/);
    stub(() => new Response("<!doctype html><html>SearXNG</html>", { headers: { "content-type": "text/html" } }));
    await assert.rejects(searxng.search(ask(), { endpoint: "https://search.example.com" }), /SearXNG: did not answer JSON; the instance must allow the json format/);
});

test("serpapi: Google with site operators, 5 extra results to filter, tbs, and api_key in the query", async () => {
    const sent = stub(
        json({
            search_metadata: { status: "Success" },
            organic_results: [
                { position: 1, title: "Test runner", link: "https://nodejs.org/api/test.html", snippet: "The node:test module", date: "Jan 2, 2025" },
                { position: 2, title: "Deno", link: "https://docs.deno.com/runtime/test", snippet: "Deno test" },
                { position: 3, title: "Elsewhere", link: "https://example.com/x", snippet: "off-domain" },
            ],
        }),
    );
    const answer = await serpapi.search(ask({ recency: "month", domains: ["nodejs.org", "deno.com", "-reddit.com"] }), { key: KEY });
    const { url, method } = sent[0]!;

    assert.equal(url.origin + url.pathname, "https://serpapi.com/search.json");
    assert.equal(method, "GET");
    assert.equal(url.searchParams.get("engine"), "google");
    assert.equal(url.searchParams.get("q"), "node test runner (site:nodejs.org OR site:deno.com) -site:reddit.com");
    assert.equal(url.searchParams.get("api_key"), KEY);
    assert.equal(url.searchParams.get("num"), "8");
    assert.equal(url.searchParams.get("tbs"), "qdr:m");
    assert.deepEqual(answer, {
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module", date: "Jan 2, 2025" },
            { title: "Deno", url: "https://docs.deno.com/runtime/test", snippet: "Deno test" },
        ],
    });

    stub(json({ search_metadata: { status: "Success" }, error: "Google hasn't returned any results for this query." }));
    await assert.rejects(serpapi.search(ask(), { key: KEY }), /SerpApi: Google hasn't returned any results/);
});

test("serpbase: Google with site operators, tbs, api_key in the query; organic results in either naming", async () => {
    const sent = stub(
        json({
            status: 200,
            organic_results: [
                { position: 1, title: "Test runner", link: "https://nodejs.org/api/test.html", snippet: "The node:test module" },
                { position: 2, title: "Learn", url: "https://nodejs.org/en/learn", description: "Learn Node" },
                { position: 3, title: "Reddit", link: "https://www.reddit.com/r/node", snippet: "no" },
            ],
        }),
    );
    const answer = await serpbase.search(ask({ recency: "day", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method } = sent[0]!;

    assert.equal(url.origin + url.pathname, "https://api.serpbase.dev/google/search");
    assert.equal(method, "GET");
    assert.equal(url.searchParams.get("q"), "node test runner site:nodejs.org -site:reddit.com");
    assert.equal(url.searchParams.get("api_key"), KEY);
    assert.equal(url.searchParams.get("num"), "3");
    assert.equal(url.searchParams.get("tbs"), "qdr:d");
    assert.deepEqual(answer, {
        results: [
            { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module" },
            { title: "Learn", url: "https://nodejs.org/en/learn", snippet: "Learn Node" },
        ],
    });

    stub(json({ organic: [{ title: "Serper-style", link: "https://a.example/1", snippet: "s" }] }));
    assert.deepEqual((await serpbase.search(ask(), { key: KEY })).results, [{ title: "Serper-style", url: "https://a.example/1", snippet: "s" }]);
});

test("serpdive: the free krill depth, recency as a hint, at most 10, domains checked on the answer", async () => {
    const sent = stub(
        json({
            query: "node test runner past week",
            model: "krill",
            answer: null,
            results: [
                { url: "https://nodejs.org/api/test.html", title: "Test runner", date: "2025-01-02", content: "The node:test  module\nruns tests." },
                { url: "https://www.reddit.com/r/node", title: "Reddit", content: "no" },
            ],
        }),
    );
    const answer = await serpdive.search(ask({ numResults: 15, recency: "week", domains: ["-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.serpdive.com/v1/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, { query: "node test runner past week", model: "krill", max_results: 10 });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module runs tests.", date: "2025-01-02" }] });

    stub(json({ model: "mako", answer: "node:test is built in.", results: [] }));
    assert.equal((await serpdive.search(ask(), { key: KEY })).answer, "node:test is built in.");
});

test("serper: X-API-KEY, q with site operators, 5 extra results to filter, and tbs", async () => {
    const sent = stub(
        json({
            searchParameters: { q: "node test runner site:nodejs.org", type: "search" },
            organic: [
                { title: "Test runner", link: "https://nodejs.org/api/test.html", snippet: "The node:test module", date: "Jan 2, 2025", position: 1 },
                { title: "Elsewhere", link: "https://example.com/x", snippet: "off-domain", position: 2 },
            ],
        }),
    );
    const answer = await serper.search(ask({ recency: "year", domains: ["nodejs.org"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://google.serper.dev/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("x-api-key"), KEY);
    assert.deepEqual(body, { q: "node test runner site:nodejs.org", num: 8, tbs: "qdr:y" });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module", date: "Jan 2, 2025" }] });
});

test("serply: X-Api-Key, q with site operators, num, and tbs in the query; description is the snippet", async () => {
    const sent = stub(
        json({
            results: [
                { title: "Test runner", link: "https://nodejs.org/api/test.html", description: "The node:test module" },
                { title: "Reddit", link: "https://old.reddit.com/r/node", description: "no" },
            ],
            total: 2,
        }),
    );
    const answer = await serply.search(ask({ numResults: 5, recency: "week", domains: ["-reddit.com"] }), { key: KEY });
    const { url, method, headers } = sent[0]!;

    assert.equal(url.origin + url.pathname, "https://api.serply.io/v1/search");
    assert.equal(method, "GET");
    assert.equal(headers.get("x-api-key"), KEY);
    assert.equal(url.searchParams.get("q"), "node test runner -site:reddit.com");
    assert.equal(url.searchParams.get("num"), "10");
    assert.equal(url.searchParams.get("tbs"), "qdr:w");
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module" }] });

    stub(json({ detail: "Not enough credits" }));
    await assert.rejects(serply.search(ask(), { key: KEY }), /Serply: Not enough credits/);
});

test("tavily: basic depth with a basic answer, max_results, time_range, and domains", async () => {
    const sent = stub(
        json({
            query: "node test runner",
            answer: "Node ships node:test.",
            results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", content: "The node:test module", score: 0.91, raw_content: null }],
            response_time: 1.2,
        }),
    );
    const answer = await tavily.search(ask({ recency: "day", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const { url, method, headers, body } = sent[0]!;

    assert.equal(url.href, "https://api.tavily.com/search");
    assert.equal(method, "POST");
    assert.equal(headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(body, {
        query: "node test runner",
        search_depth: "basic",
        max_results: 3,
        include_answer: "basic",
        include_raw_content: false,
        time_range: "day",
        include_domains: ["nodejs.org"],
        exclude_domains: ["reddit.com"],
    });
    assert.deepEqual(answer, { answer: "Node ships node:test.", results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module" }] });
});

test("tinyfish: a GET with domains and recency in minutes, a second page past 10 results, each link once", async () => {
    const page = (from: number, count: number) =>
        json({
            query: "node test runner",
            results: Array.from({ length: count }, (_, index) => ({
                position: from + index,
                site_name: "Example",
                title: `Result ${from + index}`,
                snippet: `Snippet ${from + index}`,
                url: `https://example.com/${from + index}`,
                date: from + index === 1 ? "2025-01-02" : null,
            })),
            total_results: 100,
            page: from === 1 ? 0 : 1,
        });
    const sent = stub(page(1, 10), page(10, 4));
    const answer = await tinyfish.search(ask({ numResults: 12, recency: "week", domains: ["example.com", "-reddit.com"] }), { key: KEY });

    assert.equal(sent.length, 2);
    assert.equal(sent[0]!.url.origin, "https://api.search.tinyfish.ai");
    assert.equal(sent[0]!.method, "GET");
    assert.equal(sent[0]!.headers.get("x-api-key"), KEY);
    assert.equal(sent[0]!.url.searchParams.get("query"), "node test runner");
    assert.equal(sent[0]!.url.searchParams.get("include_domains"), "example.com");
    assert.equal(sent[0]!.url.searchParams.get("exclude_domains"), "reddit.com");
    assert.equal(sent[0]!.url.searchParams.get("recency_minutes"), "10080");
    assert.equal(sent[0]!.url.searchParams.get("page"), null);
    assert.equal(sent[1]!.url.searchParams.get("page"), "1");
    assert.equal(answer.results.length, 12);
    assert.deepEqual(answer.results[0], { title: "Result 1", url: "https://example.com/1", snippet: "Snippet 1", date: "2025-01-02" });
    assert.deepEqual(
        answer.results.map((result) => result.url).slice(9),
        ["https://example.com/10", "https://example.com/11", "https://example.com/12"],
    );

    // A short first page is the last.
    const short = stub(page(1, 4));
    await tinyfish.search(ask({ numResults: 12 }), { key: KEY });
    assert.equal(short.length, 1);
});

const failing: [SearchProvider, Credentials][] = [
    [openai, { key: KEY }],
    [parallel, { key: KEY }],
    [parallelMcp, { key: KEY }],
    [perplexity, { key: KEY }],
    [querit, { key: KEY }],
    [search1api, { key: KEY }],
    [searchinfinity, { key: KEY }],
    [searxng, { endpoint: "http://127.0.0.1:8888" }],
    [serpapi, { key: KEY }],
    [serpbase, { key: KEY }],
    [serpdive, { key: KEY }],
    [serper, { key: KEY }],
    [serply, { key: KEY }],
    [tavily, { key: KEY }],
    [tinyfish, { key: KEY }],
];

for (const [provider, credentials] of failing) {
    test(`${provider.id}: a refused request is a ProviderError that names it and hides the key`, async () => {
        stub(json({ error: { message: `Incorrect API key provided: ${credentials.key ?? "none"}` } }, credentials.key === undefined ? 500 : 401));

        await assert.rejects(provider.search(ask(), credentials), (error: Error) => {
            assert.ok(error instanceof ProviderError, String(error));
            assert.ok(error.message.startsWith(`${provider.name}: `), error.message);
            assert.ok(!error.message.includes(KEY), error.message);
            assert.equal(error.status, credentials.key === undefined ? 500 : 401);

            return true;
        });
    });
}

test("every provider in the batch says where its key comes from", () => {
    assert.deepEqual(
        Object.fromEntries(failing.map(([provider]) => [provider.id, provider.key])),
        {
            openai: { kind: "pi", provider: "openai" },
            parallel: { kind: "secret", secret: "PARALLEL_API_KEY" },
            "parallel-mcp": { kind: "secret", secret: "PARALLEL_API_KEY", optional: true },
            perplexity: { kind: "secret", secret: "PERPLEXITY_API_KEY" },
            querit: { kind: "secret", secret: "QUERIT_API_KEY" },
            search1api: { kind: "secret", secret: "SEARCH1API_KEY" },
            searchinfinity: { kind: "secret", secret: "SEARCHINFINITY_API_KEY" },
            searxng: { kind: "none" },
            serpapi: { kind: "secret", secret: "SERPAPI_KEY" },
            serpbase: { kind: "secret", secret: "SERPBASE_API_KEY" },
            serpdive: { kind: "secret", secret: "SERPDIVE_API_KEY" },
            serper: { kind: "secret", secret: "SERPER_API_KEY" },
            serply: { kind: "secret", secret: "SERPLY_API_KEY" },
            tavily: { kind: "secret", secret: "TAVILY_API_KEY" },
            tinyfish: { kind: "secret", secret: "TINYFISH_API_KEY" },
        },
    );
    assert.deepEqual(searxng.endpoint, { label: "SearXNG address" });
});
