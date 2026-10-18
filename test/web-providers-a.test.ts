// Web search providers ported from pi-web-access (anysearch … zai): each sends the request its API documents, with
// the key where the API wants it, reads that API's answer into results, and fails with an error that names the
// provider and never shows the key. fetch is stubbed; no request leaves the machine.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { ProviderError, since } from "../src/server/web/http.ts";
import anysearch from "../src/server/web/providers/anysearch.ts";
import baizhi from "../src/server/web/providers/baizhi.ts";
import bocha from "../src/server/web/providers/bocha.ts";
import brave from "../src/server/web/providers/brave.ts";
import ceramic from "../src/server/web/providers/ceramic.ts";
import degoog from "../src/server/web/providers/degoog.ts";
import duckduckgo from "../src/server/web/providers/duckduckgo.ts";
import exa from "../src/server/web/providers/exa.ts";
import firecrawl from "../src/server/web/providers/firecrawl.ts";
import valyu from "../src/server/web/providers/valyu.ts";
import you from "../src/server/web/providers/you.ts";
import zai from "../src/server/web/providers/zai.ts";
import type { SearchProvider, SearchRequest } from "../src/server/web/types.ts";

const KEY = "sk-test-0123456789abcdef";
const realFetch = globalThis.fetch;

interface Call {
    url: string;
    method: string;
    headers: Headers;
    body: unknown;
}

/** Stubs fetch: each request is recorded and answered by `answer`, which sees the calls so far. */
function stub(answer: (call: Call, index: number) => Response): Call[] {
    const calls: Call[] = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const call = {
            url: String(input),
            method: init?.method ?? "GET",
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        };

        calls.push(call);

        return answer(call, calls.length - 1);
    }) as typeof fetch;

    return calls;
}

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", ...headers } });

/** An MCP answer as an event stream, the way streamable-HTTP servers send it. */
const sse = (id: number, result: unknown) =>
    new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
        status: 200,
        headers: { "content-type": "text/event-stream", "mcp-session-id": "session-1" },
    });

const ask = (overrides: Partial<SearchRequest> = {}): SearchRequest => ({ query: "node test runner", numResults: 5, signal: new AbortController().signal, ...overrides });

/** A non-2xx answer that echoes the key becomes a ProviderError naming the provider, without the key. */
async function refuses(provider: SearchProvider, name: string, credentials: { key?: string; endpoint?: string }, answer: (call: Call, index: number) => Response) {
    stub(answer);

    await assert.rejects(provider.search(ask(), credentials), (error: unknown) => {
        assert.ok(error instanceof ProviderError, String(error));
        assert.ok(error.message.startsWith(`${name}: `), error.message);
        assert.ok(!error.message.includes(KEY), error.message);

        return true;
    });
}

const echo = (status: number) => () => json({ error: { message: `invalid key ${KEY}` } }, status);

afterEach(() => {
    globalThis.fetch = realFetch;
});

test("AnySearch posts the query and count, with the key when there is one, and reads data.results", async () => {
    const calls = stub(() =>
        json({ code: 0, data: { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module.", content: "…" }], metadata: {} } }),
    );
    const answer = await anysearch.search(ask({ numResults: 3 }), { key: KEY });

    assert.equal(calls[0]!.url, "https://api.anysearch.com/v1/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0]!.body, { query: "node test runner", max_results: 3 });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module." }] });

    // Without a key it asks anonymously; an envelope with another code is a failure.
    const anonymous = stub(() => json({ code: 1, message: "busy" }));

    await assert.rejects(anysearch.search(ask(), {}), /AnySearch: answered without results \(code 1\)/);
    assert.equal(anonymous[0]!.headers.get("authorization"), null);
});

test("AnySearch failures name it and hide the key", () => refuses(anysearch, "AnySearch", { key: KEY }, echo(401)));

test("Baizhi calls websearch_search over MCP with the Bearer key, filters, and time range, and answers its text", async () => {
    const calls = stub((call, index) =>
        index === 0 ? sse(1, { protocolVersion: "2025-03-26", capabilities: {} }) : index === 1 ? new Response(null, { status: 202 }) : sse(2, { content: [{ type: "text", text: "1. Test runner — https://nodejs.org/api/test.html" }] }),
    );
    const answer = await baizhi.search(ask({ recency: "week", domains: ["nodejs.org", "-medium.com"] }), { key: KEY });

    assert.equal(calls.length, 3);
    assert.ok(calls.every((call) => call.url === "https://agent-toolkit.app.baizhi.cloud/mcp" && call.headers.get("authorization") === `Bearer ${KEY}`));
    assert.equal(calls[2]!.headers.get("mcp-session-id"), "session-1");
    assert.deepEqual((calls[2]!.body as { params: unknown }).params, {
        name: "websearch_search",
        arguments: { query: "node test runner", count: 5, need_summary: false, time_range: "week", filter: { domains: ["nodejs.org"], exclude_domains: ["medium.com"] } },
    });
    assert.deepEqual(answer, { answer: "1. Test runner — https://nodejs.org/api/test.html", results: [] });

    // No recency asks for the tool's default, a month.
    const plain = stub((call, index) => (index === 0 ? sse(1, {}) : index === 1 ? new Response(null, { status: 202 }) : sse(2, { content: [{ type: "text", text: "x" }] })));

    await baizhi.search(ask(), { key: KEY });
    assert.equal((plain[2]!.body as { params: { arguments: { time_range: string } } }).params.arguments.time_range, "month");
});

test("Baizhi failures name it and hide the key", () => refuses(baizhi, "Baizhi", { key: KEY }, () => new Response(`unauthorized: ${KEY}`, { status: 401 })));

test("Bocha posts count, freshness, and summary with the Bearer key, reads data.webPages.value, and keeps to the domains", async () => {
    const calls = stub(() =>
        json({
            code: 200,
            msg: null,
            data: {
                webPages: {
                    value: [
                        { name: "Node.js 测试", url: "https://nodejs.org/api/test.html", snippet: "short", summary: "The summary." },
                        { name: "Elsewhere", url: "https://example.com/x", snippet: "drop me" },
                        { name: "Docs", url: "https://docs.nodejs.org/y", snippet: "Only a snippet." },
                    ],
                },
            },
        }),
    );
    const answer = await bocha.search(ask({ recency: "month", domains: ["nodejs.org"] }), { key: KEY });

    assert.equal(calls[0]!.url, "https://api.bochaai.com/v1/web-search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0]!.body, { query: "node test runner", count: 5, freshness: "oneMonth", summary: true });
    assert.deepEqual(answer.results, [
        { title: "Node.js 测试", url: "https://nodejs.org/api/test.html", snippet: "The summary." },
        { title: "Docs", url: "https://docs.nodejs.org/y", snippet: "Only a snippet." },
    ]);

    const plain = stub(() => json({ code: 200, data: { webPages: { value: [] } } }));

    await bocha.search(ask(), { key: KEY });
    assert.equal((plain[0]!.body as { freshness: string }).freshness, "noLimit");
    stub(() => json({ code: 403, msg: "余额不足" }));
    await assert.rejects(bocha.search(ask(), { key: KEY }), /Bocha: code 403: 余额不足/);
});

test("Bocha failures name it and hide the key", () => refuses(bocha, "Bocha", { key: KEY }, echo(403)));

test("Brave gets web/search with the subscription token, freshness, site operators, and plain titles", async () => {
    const calls = stub(() =>
        json({
            web: {
                results: [
                    { title: "<strong>Node</strong> &amp; tests", url: "https://nodejs.org/api/test.html", description: "The <strong>test</strong> runner&#39;s docs", page_age: "2026-10-01T00:00:00" },
                    { title: "Reddit", url: "https://www.reddit.com/r/node", description: "left out" },
                    { title: "Other", url: "https://example.com/", description: "not kept to" },
                ],
            },
        }),
    );
    const answer = await brave.search(ask({ recency: "week", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });
    const url = new URL(calls[0]!.url);

    assert.equal(`${url.origin}${url.pathname}`, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(calls[0]!.headers.get("x-subscription-token"), KEY);
    assert.equal(url.searchParams.get("q"), "node test runner site:nodejs.org NOT site:reddit.com");
    assert.equal(url.searchParams.get("count"), "20", "with domains it asks for more, as some are dropped");
    assert.equal(url.searchParams.get("freshness"), "pw");
    assert.deepEqual(answer.results, [{ title: "Node & tests", url: "https://nodejs.org/api/test.html", snippet: "The test runner's docs", date: "2026-10-01T00:00:00" }]);

    const plain = stub(() => json({ web: { results: [] } }));

    await brave.search(ask({ numResults: 7 }), { key: KEY });
    assert.equal(new URL(plain[0]!.url).searchParams.get("count"), "7");
    assert.equal(new URL(plain[0]!.url).searchParams.get("freshness"), null);
});

test("Brave failures name it and hide the key", () => refuses(brave, "Brave Search", { key: KEY }, echo(429)));

test("Ceramic posts site: in parentheses and description length with the Bearer key, and drops excluded domains", async () => {
    const calls = stub(() =>
        json({
            result: {
                results: [
                    { title: "Test runner", url: "https://nodejs.org/api/test.html", description: "x".repeat(900) },
                    { title: "", url: "https://deno.land/manual/testing", description: "Deno testing." },
                    { title: "Medium", url: "https://medium.com/a", description: "excluded" },
                ],
            },
        }),
    );
    const answer = await ceramic.search(ask({ recency: "day", domains: ["nodejs.org", "deno.land", "-medium.com"] }), { key: KEY });

    assert.equal(calls[0]!.url, "https://api.ceramic.ai/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0]!.body, { query: "node test runner (site:nodejs.org OR site:deno.land)", maxResults: 10, maxDescriptionLength: 1000 }, "no recency: Ceramic has none");
    assert.equal(answer.results.length, 2);
    assert.equal(answer.results[0]!.snippet.length, 500);
    assert.deepEqual(answer.results[1], { title: "Source 2", url: "https://deno.land/manual/testing", snippet: "Deno testing." });

    stub(() => json({ results: [] }));
    await assert.rejects(ceramic.search(ask(), { key: KEY }), /Ceramic: answered without result\.results/);
});

test("Ceramic failures name it and hide the key", () =>
    refuses(ceramic, "Ceramic", { key: KEY }, () => json({ title: "Unauthorized", status: 401, detail: `key ${KEY} is not valid` }, 401)));

test("degoog posts to the address's /api/search with time and site operators, the key only when set", async () => {
    const calls = stub(() =>
        json({
            results: [
                { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "", content: "From content." },
                { title: "Twice", url: "https://nodejs.org/api/test.html", snippet: "duplicate" },
                { title: "Bun", url: "https://bun.sh/docs/test", snippet: "Bun test." },
                { title: "Reddit", url: "https://reddit.com/r/node", snippet: "excluded" },
                { title: "Relative", url: "/local", snippet: "not a link" },
            ],
        }),
    );
    const answer = await degoog.search(ask({ recency: "year", domains: ["nodejs.org", "bun.sh", "-reddit.com"] }), { key: KEY, endpoint: "https://search.example.com/degoog/" });

    assert.equal(calls[0]!.url, "https://search.example.com/degoog/api/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0]!.body, { query: "node test runner (site:nodejs.org OR site:bun.sh) -site:reddit.com", type: "web", page: 1, time: "year" });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "From content." },
        { title: "Bun", url: "https://bun.sh/docs/test", snippet: "Bun test." },
    ]);

    // The public instance is the documented default, asked without a key; a 401 there says the key is missing.
    const open = stub(() => json({ results: [] }));

    await degoog.search(ask(), {});
    assert.equal(open[0]!.url, "https://degoog.org/api/search");
    assert.equal(open[0]!.headers.get("authorization"), null);
    stub(() => json({ error: "unauthorized" }, 401));
    await assert.rejects(degoog.search(ask(), {}), /degoog: this instance protects its search; add its key as DEGOOG_API_KEY/);
    await assert.rejects(degoog.search(ask(), { endpoint: "ftp://x" }), /degoog: the address must be http\(s\)/);
});

test("degoog failures name it and hide the key", () => refuses(degoog, "degoog", { key: KEY }, echo(500)));

const DDG_PAGE = `<html><body>
<div class="result results_links results_links_deep result--ad ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad&amp;rut=1">An ad</a></h2>
  <a class="result__snippet" href="#">Buy now</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fnodejs.org%2Fapi%2Ftest.html&amp;rut=2">Test runner | Node.js &amp; you</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The <b>node:test</b> module facilitates&#x2026;</a>
</div>
<div class="result results_links results_links_deep web-result ">
  <h2 class="result__title"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F&amp;rut=3">Elsewhere</a></h2>
  <a class="result__snippet" href="#">Not kept to</a>
</div>
</body></html>`;

test("DuckDuckGo gets the HTML page with df, skips ads, opens redirect links, and keeps to the domains", async () => {
    const calls = stub(() => new Response(DDG_PAGE, { status: 200, headers: { "content-type": "text/html" } }));
    const answer = await duckduckgo.search(ask({ recency: "month", domains: ["nodejs.org"] }), {});
    const url = new URL(calls[0]!.url);

    assert.equal(`${url.origin}${url.pathname}`, "https://html.duckduckgo.com/html/");
    assert.equal(calls[0]!.method, "GET");
    assert.equal(url.searchParams.get("q"), "node test runner");
    assert.equal(url.searchParams.get("df"), "m");
    assert.match(calls[0]!.headers.get("user-agent") ?? "", /^Mozilla\/5\.0/);
    assert.deepEqual(answer, { results: [{ title: "Test runner | Node.js & you", url: "https://nodejs.org/api/test.html", snippet: "The node:test module facilitates…" }] });

    stub(() => new Response('<div class="anomaly-modal__box">Unfortunately, bots use DuckDuckGo too.</div>', { status: 202 }));
    await assert.rejects(duckduckgo.search(ask(), {}), /DuckDuckGo: it answered with a bot check/);
    stub(() => new Response('<div class="no-results__message">No results.</div>', { status: 200 }));
    assert.deepEqual(await duckduckgo.search(ask(), {}), { results: [] });
    stub(() => new Response("<html>something else</html>", { status: 200 }));
    await assert.rejects(duckduckgo.search(ask(), {}), /DuckDuckGo: answered a page with no results to read/);
});

test("DuckDuckGo failures name it", async () => {
    stub(() => new Response("Service Unavailable", { status: 503 }));
    await assert.rejects(duckduckgo.search(ask(), {}), (error: unknown) => error instanceof ProviderError && /^DuckDuckGo: HTTP 503/.test(error.message));
});

test("Exa with a key posts the API's arguments with x-api-key and reads highlights and dates", async () => {
    const before = Date.now();
    const calls = stub(() =>
        json({
            results: [
                { title: "Test runner", url: "https://nodejs.org/api/test.html", publishedDate: "2026-09-01T00:00:00.000Z", highlights: ["The node:test module", "runs tests."], text: "ignored" },
                { url: "https://bun.sh/docs/test", text: "Bun's test runner." },
            ],
        }),
    );
    const answer = await exa.search(ask({ numResults: 4, recency: "week", domains: ["nodejs.org", "bun.sh", "-reddit.com"] }), { key: KEY });
    const body = calls[0]!.body as Record<string, unknown>;

    assert.equal(calls[0]!.url, "https://api.exa.ai/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("x-api-key"), KEY);
    assert.deepEqual({ ...body, startPublishedDate: undefined }, {
        query: "node test runner",
        type: "auto",
        numResults: 4,
        includeDomains: ["nodejs.org", "bun.sh"],
        excludeDomains: ["reddit.com"],
        startPublishedDate: undefined,
        contents: { highlights: true },
    });
    const start = Date.parse(String(body.startPublishedDate));

    assert.ok(Math.abs(start - (before - 7 * 86_400_000)) < 60_000, String(body.startPublishedDate));
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module runs tests.", date: "2026-09-01T00:00:00.000Z" },
        { title: "bun.sh", url: "https://bun.sh/docs/test", snippet: "Bun's test runner." },
    ]);
});

test("Exa without a key searches through its MCP server: the basic tool for plain searches, the advanced one for filters", async () => {
    const text = [
        "Title: Test runner | Node.js Documentation\nURL: https://nodejs.org/api/test.html\nPublished: 2026-08-01T00:00:00.000Z\nAuthor: N/A\nHighlights:\nThe node:test module\nfacilitates tests.\n---\n",
        "Title: Bun test\nURL: https://bun.sh/docs/test\nPublished: N/A\nText: Bun ships a test runner.",
    ].join("\n");
    const calls = stub((call, index) => (index === 0 ? sse(1, {}) : index === 1 ? new Response(null, { status: 202 }) : sse(2, { content: [{ type: "text", text }] })));
    const answer = await exa.search(ask({ numResults: 2 }), {});

    assert.equal(calls[0]!.url, "https://mcp.exa.ai/mcp?tools=web_search_exa");
    assert.equal(calls[0]!.headers.get("x-api-key"), null);
    assert.deepEqual((calls[2]!.body as { params: unknown }).params, { name: "web_search_exa", arguments: { query: "node test runner", numResults: 2 } });
    assert.deepEqual(answer.results, [
        { title: "Test runner | Node.js Documentation", url: "https://nodejs.org/api/test.html", snippet: "The node:test module facilitates tests.", date: "2026-08-01T00:00:00.000Z" },
        { title: "Bun test", url: "https://bun.sh/docs/test", snippet: "Bun ships a test runner." },
    ]);

    const advanced = stub((call, index) =>
        index === 0 ? sse(1, {}) : index === 1 ? new Response(null, { status: 202 }) : sse(2, { content: [{ type: "text", text: JSON.stringify({ results: [{ title: "Docs", url: "https://nodejs.org/learn", highlights: ["Learn."], publishedDate: "2026-10-01" }] }) }] }),
    );
    const filtered = await exa.search(ask({ domains: ["nodejs.org"], recency: "day" }), {});
    const args = (advanced[2]!.body as { params: { name: string; arguments: Record<string, unknown> } }).params;

    assert.equal(advanced[0]!.url, "https://mcp.exa.ai/mcp?tools=web_search_advanced_exa");
    assert.equal(args.name, "web_search_advanced_exa");
    assert.deepEqual(args.arguments.includeDomains, ["nodejs.org"]);
    assert.equal(args.arguments.enableHighlights, true);
    assert.equal(args.arguments.textMaxCharacters, 3000);
    assert.equal(typeof args.arguments.startPublishedDate, "string");
    assert.deepEqual(filtered.results, [{ title: "Docs", url: "https://nodejs.org/learn", snippet: "Learn.", date: "2026-10-01" }]);

    stub(() => new Response("Too Many Requests", { status: 429 }));
    await assert.rejects(exa.search(ask(), {}), /Exa: the free MCP search is rate-limited; add an Exa key as EXA_API_KEY/);
});

test("Exa failures name it and hide the key", () => refuses(exa, "Exa", { key: KEY }, echo(401)));

test("Firecrawl posts v2/search at the set address with limit, tbs, and domains, and needs success", async () => {
    const calls = stub(() =>
        json({
            success: true,
            data: {
                web: [
                    { url: "https://nodejs.org/api/test.html", title: "Test runner", description: "The node:test module." },
                    { metadata: { sourceURL: "https://docs.nodejs.org/z", title: "Meta title", description: "Meta description." } },
                    { url: "https://example.com/", title: "Elsewhere", description: "dropped" },
                ],
            },
        }),
    );
    const answer = await firecrawl.search(ask({ numResults: 3, recency: "year", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY, endpoint: "https://api.firecrawl.dev/" });

    assert.equal(calls[0]!.url, "https://api.firecrawl.dev/v2/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("authorization"), `Bearer ${KEY}`);
    assert.deepEqual(calls[0]!.body, { query: "node test runner", limit: 3, sources: ["web"], includeDomains: ["nodejs.org"], tbs: "qdr:y" });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module." },
        { title: "Meta title", url: "https://docs.nodejs.org/z", snippet: "Meta description." },
    ]);

    const excluding = stub(() => json({ success: true, data: { web: [] } }));

    await firecrawl.search(ask({ domains: ["-reddit.com"] }), { endpoint: "http://localhost:3002" });
    assert.equal(excluding[0]!.url, "http://localhost:3002/v2/search");
    assert.equal(excluding[0]!.headers.get("authorization"), null);
    assert.deepEqual((excluding[0]!.body as { excludeDomains: unknown }).excludeDomains, ["reddit.com"]);
    stub(() => json({ success: false, error: "Insufficient credits" }));
    await assert.rejects(firecrawl.search(ask(), { endpoint: "https://api.firecrawl.dev" }), /Firecrawl: the search did not succeed: Insufficient credits/);
    await assert.rejects(firecrawl.search(ask(), {}), /Firecrawl: no address is set/);
});

test("Firecrawl failures name it and hide the key", () => refuses(firecrawl, "Firecrawl", { key: KEY, endpoint: "https://api.firecrawl.dev" }, echo(402)));

test("Valyu posts max_num_results, sources, and start_date with x-api-key, and reads content as the snippet", async () => {
    const calls = stub(() =>
        json({
            success: true,
            results: [
                { title: "Test runner", url: "https://nodejs.org/api/test.html", content: "Full page content about node:test.", description: "desc" },
                { title: "", url: "https://arxiv.org/abs/1", description: "Only a description." },
            ],
        }),
    );
    const answer = await valyu.search(ask({ recency: "month", domains: ["nodejs.org", "-reddit.com"] }), { key: KEY });

    assert.equal(calls[0]!.url, "https://api.valyu.ai/v1/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("x-api-key"), KEY);
    assert.deepEqual(calls[0]!.body, { query: "node test runner", max_num_results: 5, included_sources: ["nodejs.org"], excluded_sources: ["reddit.com"], start_date: since("month") });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "Full page content about node:test." },
        { title: "Source 2", url: "https://arxiv.org/abs/1", snippet: "Only a description." },
    ]);

    stub(() => json({ success: false, error: "Insufficient credits", results: [] }));
    await assert.rejects(valyu.search(ask(), { key: KEY }), /Valyu: the search did not succeed: Insufficient credits/);
});

test("Valyu failures name it and hide the key", () => refuses(valyu, "Valyu", { key: KEY }, echo(401)));

test("You.com posts count, freshness, and domains with X-API-Key, and reads results.web", async () => {
    const calls = stub(() =>
        json({
            results: {
                web: [
                    { url: "https://nodejs.org/api/test.html", title: "Test runner", description: "The node:test module.", snippets: ["first"], page_age: "2026-09-30T12:00:00" },
                    { url: "https://bun.sh/docs/test", title: "Bun", description: "", snippets: ["Bun's runner."] },
                ],
            },
        }),
    );
    const answer = await you.search(ask({ recency: "day", domains: ["nodejs.org", "bun.sh", "-reddit.com"] }), { key: KEY });

    assert.equal(calls[0]!.url, "https://ydc-index.io/v1/search");
    assert.equal(calls[0]!.method, "POST");
    assert.equal(calls[0]!.headers.get("x-api-key"), KEY);
    assert.deepEqual(calls[0]!.body, { query: "node test runner", count: 5, freshness: "day", include_domains: ["nodejs.org", "bun.sh"], exclude_domains: ["reddit.com"] });
    assert.deepEqual(answer.results, [
        { title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module.", date: "2026-09-30T12:00:00" },
        { title: "Bun", url: "https://bun.sh/docs/test", snippet: "Bun's runner." },
    ]);

    stub(() => json({ results: {} }));
    await assert.rejects(you.search(ask(), { key: KEY }), /You\.com: answered without results\.web/);
});

test("You.com failures name it and hide the key", () => refuses(you, "You.com", { key: KEY }, echo(403)));

test("Z.ai lists the server's tools, calls the web search one with recency and one domain, and reads its JSON text", async () => {
    const list = [
        { title: "Test runner", link: "https://nodejs.org/api/test.html", content: "The node:test module.", media: "Node.js" },
        { title: "Off domain", link: "https://example.com/", content: "dropped" },
        { title: "Learn", link: "https://nodejs.org/learn", content: "Learn Node." },
    ];
    const calls = stub((call, index) =>
        index === 0
            ? sse(1, { protocolVersion: "2025-03-26", capabilities: { tools: {} } })
            : index === 1
              ? new Response(null, { status: 202 })
              : index === 2
                ? sse(2, { tools: [{ name: "webSearchPrime" }] })
                : sse(3, { content: [{ type: "text", text: JSON.stringify(JSON.stringify(list)) }] }),
    );
    const answer = await zai.search(ask({ numResults: 1, recency: "week", domains: ["nodejs.org"] }), { key: KEY });

    assert.equal(calls.length, 4);
    assert.ok(calls.every((call) => call.url === "https://api.z.ai/api/mcp/web_search_prime/mcp" && call.method === "POST" && call.headers.get("authorization") === `Bearer ${KEY}`));
    assert.equal(calls[3]!.headers.get("mcp-session-id"), "session-1");
    assert.equal((calls[2]!.body as { method: string }).method, "tools/list");
    assert.deepEqual((calls[3]!.body as { params: unknown }).params, {
        name: "webSearchPrime",
        arguments: { search_query: "node test runner", search_recency_filter: "oneWeek", search_domain_filter: "nodejs.org" },
    });
    assert.deepEqual(answer, { results: [{ title: "Test runner", url: "https://nodejs.org/api/test.html", snippet: "The node:test module." }] });

    // The China address is the other one allowed; its server names the tool web_search_prime.
    const china = stub((call, index) =>
        index === 0 ? sse(1, {}) : index === 1 ? new Response(null, { status: 202 }) : index === 2 ? sse(2, { tools: [{ name: "web_search_prime" }] }) : sse(3, { content: [{ type: "text", text: "[]" }] }),
    );

    assert.deepEqual(await zai.search(ask(), { key: KEY, endpoint: "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp" }), { results: [] });
    assert.equal((china[3]!.body as { params: { name: string } }).params.name, "web_search_prime");
    await assert.rejects(zai.search(ask(), { key: KEY, endpoint: "https://evil.example.com/mcp" }), /Z\.ai: the address must be/);
    await assert.rejects(zai.search(ask({ domains: ["a.com", "b.com"] }), { key: KEY }), /Z\.ai: it can keep to one domain only/);
    await assert.rejects(zai.search(ask({ domains: ["-a.com"] }), { key: KEY }), /Z\.ai: it can keep to one domain only/);
});

test("Z.ai failures name it and hide the key", () => refuses(zai, "Z.ai", { key: KEY }, () => new Response(`{"error":"token ${KEY} expired"}`, { status: 401 })));
