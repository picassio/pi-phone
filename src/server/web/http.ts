/**
 * What every search provider shares: a request that gives up after 30 s or when the call is stopped, an error that
 * names the provider and quotes what it said (without the key), and the filters as each API wants them.
 */
import type { Recency, SearchResult } from "./types.ts";

const TIMEOUT_MS = 30_000;

/** A provider's failure: its name, the HTTP status, and the start of what it answered. */
export class ProviderError extends Error {
    readonly status: number | undefined;

    constructor(provider: string, message: string, status?: number) {
        super(`${provider}: ${message}`);
        this.name = "ProviderError";
        this.status = status;
    }
}

/** `text` with every occurrence of `secret` hidden: errors may echo a request. */
const hide = (text: string, secret: string | undefined) =>
    secret === undefined || secret === "" ? text : text.split(secret).join("[key]");

/**
 * A request to a provider: JSON in when `body` is given, JSON or text out. A status outside 2xx throws, quoting the
 * answer's start; `key` is hidden in any message.
 */
export async function request(
    provider: string,
    url: string,
    options: {
        method?: "GET" | "POST";
        headers?: Record<string, string>;
        body?: unknown;
        signal: AbortSignal;
        key?: string;
        /** Answer as text, not JSON. */
        text?: boolean;
    },
): Promise<unknown> {
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let response: Response;

    try {
        response = await fetch(url, {
            method: options.method ?? (options.body === undefined ? "GET" : "POST"),
            headers: {
                accept: options.text ? "*/*" : "application/json",
                ...(options.body === undefined ? {} : { "content-type": "application/json" }),
                ...options.headers,
            },
            ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
            signal,
        });
    } catch (error) {
        if (options.signal.aborted) {
            throw error;
        }

        const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);

        throw new ProviderError(provider, signal.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `could not reach it: ${hide(cause, options.key)}`);
    }

    const body = await response.text();

    if (!response.ok) {
        let said = body.trim();

        try {
            const parsed = JSON.parse(said) as { error?: unknown; message?: unknown; detail?: unknown };
            const error = parsed.error;

            said = String(
                (typeof error === "object" && error !== null ? (error as { message?: unknown }).message : error) ??
                    parsed.message ??
                    parsed.detail ??
                    said,
            );
        } catch {}

        const what = response.status === 401 || response.status === 403 ? "the key was refused" : response.status === 429 ? "too many requests, or out of quota" : `HTTP ${response.status}`;

        throw new ProviderError(provider, `${what}: ${hide(said, options.key).slice(0, 300)}`, response.status);
    }

    if (options.text) {
        return body;
    }

    try {
        return JSON.parse(body);
    } catch {
        throw new ProviderError(provider, `answered something that is not JSON: ${hide(body, options.key).slice(0, 200)}`);
    }
}

/** Domains to keep to and to leave out, without schemes, paths, or a leading `www.`. */
export function splitDomains(domains: readonly string[] | undefined): { include: string[]; exclude: string[] } {
    const include: string[] = [];
    const exclude: string[] = [];

    for (const raw of domains ?? []) {
        const excluded = raw.trim().startsWith("-");
        const domain = raw
            .trim()
            .replace(/^-/, "")
            .replace(/^[a-z]+:\/\//i, "")
            .replace(/^www\./i, "")
            .replace(/[/?#].*$/, "")
            .toLowerCase();

        if (domain !== "") {
            (excluded ? exclude : include).push(domain);
        }
    }

    return { include: [...new Set(include)], exclude: [...new Set(exclude)] };
}

export const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 30, year: 365 };

/** The date `recency` reaches back to, as `YYYY-MM-DD`. */
export const since = (recency: Recency, now = Date.now()) =>
    new Date(now - RECENCY_DAYS[recency] * 86_400_000).toISOString().slice(0, 10);

/** The query with `site:` and `-site:` operators, for engines that take them. */
export function withSiteOperators(query: string, domains: readonly string[] | undefined): string {
    const { include, exclude } = splitDomains(domains);

    return [
        query.trim(),
        include.length === 0 ? "" : include.map((domain) => `site:${domain}`).join(" OR "),
        ...exclude.map((domain) => `-site:${domain}`),
    ]
        .filter((part) => part !== "")
        .join(" ");
}

/** Text as one line of at most `max` characters, or "" for anything not text. */
export function clip(value: unknown, max = 600): string {
    if (typeof value !== "string") {
        return "";
    }

    const text = value.replace(/\s+/g, " ").trim();

    return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Results with a link, each link once, at most `count`. */
export function tidy(results: readonly SearchResult[], count: number): SearchResult[] {
    const seen = new Set<string>();

    return results
        .filter((result) => /^https?:\/\//i.test(result.url) && !seen.has(result.url) && seen.add(result.url))
        .slice(0, count);
}

/**
 * One tool call to an MCP server over streamable HTTP (JSON-RPC: `initialize`, then `tools/call`), for providers that
 * offer search through MCP without a key (Exa, Parallel). Answers its text content.
 */
export async function mcpCall(
    provider: string,
    url: string,
    tool: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
    headers: Record<string, string> = {},
): Promise<string> {
    // What a server's error quotes may echo the request: no header value (a key) is ever repeated.
    const quiet = (text: string) => Object.values(headers).reduce((result, value) => hide(result, value.replace(/^Bearer\s+/i, "")), text);
    const post = async (body: unknown, session?: string) => {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                ...(session === undefined ? {} : { "mcp-session-id": session }),
                ...headers,
            },
            body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        }).catch((error: unknown) => {
            throw new ProviderError(provider, `could not reach it: ${quiet(error instanceof Error ? error.message : String(error))}`);
        });
        const text = await response.text();

        if (!response.ok) {
            throw new ProviderError(provider, `HTTP ${response.status}: ${quiet(text).slice(0, 300)}`, response.status);
        }

        // An event stream carries the JSON-RPC answer in its `data:` lines.
        const json = response.headers.get("content-type")?.includes("text/event-stream")
            ? text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .filter((line) => line !== "")
                  .at(-1) ?? ""
            : text;

        return { json: json === "" ? {} : (JSON.parse(json) as { result?: unknown; error?: { message?: string } }), session: response.headers.get("mcp-session-id") ?? session };
    };
    const started = await post({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-phone", version: "1" } },
    });

    if (started.json.error) {
        throw new ProviderError(provider, quiet(started.json.error.message ?? "could not start"));
    }

    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, started.session ?? undefined);
    const called = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, started.session ?? undefined);

    if (called.json.error) {
        throw new ProviderError(provider, quiet(called.json.error.message ?? "the call failed"));
    }

    const result = called.json.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    const text = (result?.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");

    if (result?.isError) {
        throw new ProviderError(provider, quiet(text).slice(0, 300) || "the call failed");
    }

    return text;
}
