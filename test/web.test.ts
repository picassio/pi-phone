// Web access: web_search with the provider the owner picked (its key from the one place it lives, no fallback), and
// fetch_content for pages (Readability), documents (markit), and long text saved for Pi to read on. Requests go to a
// stubbed fetch: no network.
import { type App, cleanUp, context, lastText, modelTexts, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, test } from "node:test";
import type { FauxResponseStep } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { blockedInPlanMode } from "../src/server/extensions/plan.ts";
import { ConfigStore } from "../src/server/config.ts";
import { Secrets } from "../src/server/secrets.ts";
import { WebSearch } from "../src/server/web/access.ts";
import { PROVIDERS } from "../src/server/web/providers/index.ts";
import { MAX_INLINE, pageMarkdown } from "../src/server/web/fetch.ts";
import type { SearchProvider } from "../src/server/web/types.ts";

const realFetch = globalThis.fetch;
const ARTICLE = `<!doctype html><html><head><title>Durable agents</title></head><body>
<nav>Home · About · Login</nav>
<article><h1>Durable agents</h1>${"<p>A durable harness keeps every step of an agent's work, so a restart picks up where it was. ".repeat(6)}</p>
<p>It writes intent before each tool call.</p></article><footer>© 2026</footer></body></html>`;

const route: FauxResponseStep = (request) => {
    const { role, text } = lastText(request as never);

    if (role === "user" && text.endsWith("search it")) {
        return fauxAssistantMessage([fauxToolCall("web_search", { queries: ["durable agents", "pi phone"], numResults: 2, domainFilter: ["example.com"] })], { stopReason: "toolUse" });
    }

    if (role === "user" && text.endsWith("read it")) {
        return fauxAssistantMessage([fauxToolCall("fetch_content", { urls: ["https://example.com/article", "https://example.com/long.txt", "https://example.com/missing"] })], { stopReason: "toolUse" });
    }

    return fauxAssistantMessage([fauxText(role === "toolResult" ? `tool said: ${text}` : "ok")]);
};

let app: App;

before(async () => {
    app = await openApp(scriptedModel(route));
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

after(async () => {
    await app?.close();
    cleanUp();
});

/** A fetch that answers `routes` by URL prefix, and records what it was asked. */
function stubFetch(routes: Record<string, (url: URL) => Response>): URL[] {
    const asked: URL[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
        const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);

        asked.push(url);

        for (const [prefix, answer] of Object.entries(routes)) {
            if (url.href.startsWith(prefix)) {
                const response = answer(url);

                Object.defineProperty(response, "url", { value: url.href });

                return response;
            }
        }

        return new Response("not found", { status: 404 });
    }) as typeof fetch;

    return asked;
}

async function turn(id: Parameters<App["commands"]["submit"]>[0], text: string): Promise<string> {
    const { submissionId } = await app.commands.submit(id, owner(app), { text, requestId: crypto.randomUUID() });

    await (await app.harness.submission(submissionId, context))!.wait(context);
    await app.harness.waitForIdle(context);

    return (await modelTexts(app, id)).at(-1)!;
}

test("every provider has an id, a name, a site, and one place its key comes from", () => {
    const ids = new Set<string>();

    for (const provider of PROVIDERS) {
        assert.match(provider.id, /^[a-z0-9-]+$/);
        assert.ok(!ids.has(provider.id), `${provider.id} twice`);
        ids.add(provider.id);
        assert.ok(provider.name !== "" && /^https:\/\//.test(provider.site), provider.id);

        if (provider.key.kind === "secret") {
            assert.match(provider.key.secret, /^[A-Z_][A-Z0-9_]*$/, provider.id);
        }
    }

    for (const id of ["deepseek", "openrouter", "exa", "brave", "duckduckgo", "searxng", "tavily", "perplexity", "gemini", "openai"]) {
        assert.ok(ids.has(id), id);
    }

    assert.equal(PROVIDERS.find((provider) => provider.id === "deepseek")!.key.kind, "pi");
});

test("the picked provider searches with its key from its one place; what is missing names the setting", async () => {
    const dir = mkdtempSync(join(root, "web-"));
    const config = new ConfigStore(dir);
    const secrets = new Secrets(dir);
    const seen: { key?: string; endpoint?: string }[] = [];
    const fake = (id: string, key: SearchProvider["key"], endpoint?: SearchProvider["endpoint"]): SearchProvider => ({
        id,
        name: id.toUpperCase(),
        site: "https://example.com",
        key,
        ...(endpoint === undefined ? {} : { endpoint }),
        search: async (_request, credentials) => {
            seen.push(credentials);

            return { results: [{ title: "T", url: "https://example.com/t", snippet: "s" }] };
        },
    });
    const web = new WebSearch(config, secrets, async (provider) => (provider === "deepseek" ? "pi-key-123456" : undefined), [
        fake("pi", { kind: "pi", provider: "deepseek" }),
        fake("pi-missing", { kind: "pi", provider: "openai" }),
        fake("secret", { kind: "secret", secret: "FAKE_API_KEY" }),
        fake("hosted", { kind: "none" }, { label: "Its address" }),
    ]);
    const signal = new AbortController().signal;

    await assert.rejects(web.search("q", { numResults: 3, signal }), /Web search is off: the person picks a search provider in Settings › Web access/);
    web.set({ provider: "pi" });
    await web.search("q", { numResults: 3, signal });
    assert.deepEqual(seen.at(-1), { key: "pi-key-123456" });

    await assert.rejects(web.search("q", { numResults: 3, provider: "pi-missing", signal }), /sign in to openai in Settings › Providers/);
    await assert.rejects(web.search("q", { numResults: 3, provider: "secret", signal }), /add the secret FAKE_API_KEY in Settings › Secrets/);
    secrets.set("FAKE_API_KEY", { value: "secret-key-987654" });
    await web.search("q", { numResults: 3, provider: "secret", signal });
    assert.deepEqual(seen.at(-1), { key: "secret-key-987654" });

    await assert.rejects(web.search("q", { numResults: 3, provider: "hosted", signal }), /set its Its address in Settings › Web access/);
    assert.throws(() => web.set({ endpoints: { hosted: "not a url" } }), /http:\/\/ or https:\/\//);
    web.set({ endpoints: { hosted: "https://search.example.com/" } });
    await web.search("q", { numResults: 3, provider: "hosted", signal });
    assert.deepEqual(seen.at(-1), { endpoint: "https://search.example.com" });
    assert.throws(() => web.set({ provider: "nope" }), /No search provider nope/);
    assert.equal(new ConfigStore(dir).web.provider, "pi", "the pick is saved");
    assert.ok(!(await web.providers()).some((info) => JSON.stringify(info).includes("987654")), "no key in what the sheet gets");
});

test("Pi searches the web: each query's results, from the picked provider", async () => {
    app.web.set({ provider: "searxng", endpoints: { searxng: "https://searx.test" } });
    const asked = stubFetch({
        "https://searx.test/search": (url) =>
            Response.json({
                results: [
                    { title: `About ${url.searchParams.get("q")}`, url: "https://example.com/a", content: "first snippet", publishedDate: "2026-10-01T00:00:00Z" },
                    { title: "Second", url: "https://example.com/b", content: "second snippet" },
                ],
            }),
    });
    const id = await newSession(app);
    const answer = await turn(id, "search it");

    assert.equal(asked.length, 2, "one request per query");
    assert.match(asked[0]!.searchParams.get("q")!, /site:example\.com/);
    assert.match(answer, /## durable agents \(SearXNG, 2 results\)/);
    assert.match(answer, /1\. About durable agents[^]*https:\/\/example\.com\/a \(2026-10-01\)[^]*first snippet/);
    assert.match(answer, /## pi phone/);
});

test("Pi reads pages as Markdown, and long text is saved whole for it to read on", async () => {
    const long = `${"line of text\n".repeat(Math.ceil((MAX_INLINE + 5000) / 13))}THE END\n`;

    stubFetch({
        "https://example.com/article": () => new Response(ARTICLE, { headers: { "content-type": "text/html; charset=utf-8" } }),
        "https://example.com/long.txt": () => new Response(long, { headers: { "content-type": "text/plain" } }),
    });
    const id = await newSession(app);
    const answer = await turn(id, "read it");

    assert.match(answer, /# Durable agents\\nSource: https:\/\/example\.com\/article \(Readability\)/);
    assert.match(answer, /writes intent before each tool call/);
    assert.doesNotMatch(answer, /Home · About · Login/, "the page's main text, not its menus");
    assert.match(answer, /The whole text is in [^ ]+\.md: read it from line/);
    assert.match(answer, /Could not read https:\/\/example\.com\/missing: HTTP 404/);

    // Saved where the session runs: its shell's $HOME (in tests, this process's own, not the test app's).
    const saved = answer.match(/The whole text is in ([^ ]+\.md):/)![1]!;

    assert.ok(existsSync(saved) && readFileSync(saved, "utf8").includes("THE END"));
    rmSync(saved);
});

test("a page without an article keeps its body; both web tools are allowed in plan mode", () => {
    const { title, markdown } = pageMarkdown("<html><body><p>Just <b>one</b> line.</p></body></html>", "https://example.com/x");

    assert.equal(title, "https://example.com/x");
    assert.equal(markdown, "Just **one** line.");
    assert.equal(blockedInPlanMode("web_search", { query: "x" }), undefined);
    assert.equal(blockedInPlanMode("fetch_content", { url: "https://example.com" }), undefined);
});
