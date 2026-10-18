// DeepSeek's search: its own engine, the Pi sign-in's key, and its links' chunk numbers dropped so a page is listed once.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import deepseek from "../src/server/web/providers/deepseek.ts";

const realFetch = globalThis.fetch;

afterEach(() => {
    globalThis.fetch = realFetch;
});

test("DeepSeek searches with its filters as operators, and lists each page once", async () => {
    let sent: { url: string; body: { query: string; count: number }; auth: string | null } | undefined;

    globalThis.fetch = (async (url: string, init: RequestInit) => {
        sent = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") };

        return Response.json({
            results: [
                { title: "Pi Durable", url: "https://www.npmjs.com/package/@earendil-works/pi-durable#1", summary: "A durable harness.", date: "2026-09-30T00:00:00+00:00" },
                { title: "Pi Durable", url: "https://www.npmjs.com/package/@earendil-works/pi-durable#2", snippet: "More of it." },
                { title: "Pi", url: "https://pi.dev/", snippet: "The agent." },
            ],
        });
    }) as typeof fetch;

    const { results } = await deepseek.search(
        { query: "pi durable", numResults: 5, recency: "year", domains: ["npmjs.com", "-reddit.com"], signal: new AbortController().signal },
        { key: "sk-test-123456" },
    );

    assert.equal(sent?.url, "https://api.deepseek.com/v1/tools/search");
    assert.equal(sent?.auth, "Bearer sk-test-123456");
    assert.match(sent!.body.query, /^pi durable site:npmjs\.com -site:reddit\.com after:\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(results.map((result) => result.url), ["https://www.npmjs.com/package/@earendil-works/pi-durable", "https://pi.dev/"]);
    assert.equal(results[0]!.snippet, "A durable harness.", "the summary written for models");
    assert.equal(results[0]!.date, "2026-09-30T00:00:00+00:00");
});
