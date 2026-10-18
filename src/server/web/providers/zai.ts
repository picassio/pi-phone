/**
 * Z.ai's Web Search MCP server (https://docs.z.ai/devpack/mcp/search-mcp-server): the GLM Coding Plan's
 * `webSearchPrime` tool over streamable-HTTP MCP, with the key of the Pi "zai" sign-in as a Bearer header; searches
 * count against the plan's quota. Keys are issued per site, so the address is api.z.ai's (the default) or
 * open.bigmodel.cn's, and no other. The China server lists the tool as `web_search_prime`, so the name is taken from
 * the server's tool list. Recency is `search_recency_filter`; the tool takes one included domain and no exclusions,
 * so anything else is refused. It has no result count: the answer is cut to the count, and kept to the domain.
 * Ported from pi-web-access's `zai.ts` (MIT), with a small MCP client in place of the MCP SDK.
 */
import { clip, ProviderError, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const GLOBAL = "https://api.z.ai/api/mcp/web_search_prime/mcp";
const CHINA = "https://open.bigmodel.cn/api/mcp/web_search_prime/mcp";
const RECENCY = { day: "oneDay", week: "oneWeek", month: "oneMonth", year: "oneYear" };
const TIMEOUT_MS = 60_000;

/** `text` with the key hidden. */
const hide = (text: string, key: string | undefined) => (key === undefined || key === "" ? text : text.split(key).join("[key]"));

/**
 * An MCP session at `url`: `initialize`, then each `call` one JSON-RPC request (an event stream's last `data:` line,
 * or plain JSON). Redirects are refused, so neither the key nor the session goes elsewhere.
 */
function session(url: string, key: string | undefined, signal: AbortSignal) {
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    let id = 0;
    let sessionId: string | undefined;

    const post = async (body: Record<string, unknown>) => {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json",
                authorization: `Bearer ${key}`,
                ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
            },
            body: JSON.stringify(body),
            redirect: "error",
            signal: deadline,
        }).catch((error: unknown) => {
            if (signal.aborted) {
                throw error;
            }

            throw new ProviderError("Z.ai", deadline.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `could not reach it: ${hide(error instanceof Error ? error.message : String(error), key)}`);
        });
        const text = await response.text();

        if (!response.ok) {
            const what = response.status === 401 || response.status === 403 ? "the key was refused" : response.status === 429 ? "too many requests, or out of plan quota" : `HTTP ${response.status}`;

            throw new ProviderError("Z.ai", `${what}: ${hide(text.trim(), key).slice(0, 300)}`, response.status);
        }

        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        const json = response.headers.get("content-type")?.includes("text/event-stream")
            ? (text
                  .split("\n")
                  .filter((line) => line.startsWith("data:"))
                  .map((line) => line.slice(5).trim())
                  .filter((line) => line !== "")
                  .at(-1) ?? "")
            : text;

        try {
            return json === "" ? {} : (JSON.parse(json) as { result?: unknown; error?: { message?: string } });
        } catch {
            throw new ProviderError("Z.ai", `answered something that is not JSON: ${hide(json, key).slice(0, 200)}`);
        }
    };

    const call = async (method: string, params: Record<string, unknown>) => {
        id += 1;
        const answer = await post({ jsonrpc: "2.0", id, method, params });

        if (answer.error) {
            throw new ProviderError("Z.ai", hide(answer.error.message ?? `${method} failed`, key));
        }

        return answer.result;
    };

    return {
        async open() {
            await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-phone", version: "1" } });
            await post({ jsonrpc: "2.0", method: "notifications/initialized" });
        },
        call,
    };
}

const provider: SearchProvider = {
    id: "zai",
    name: "Z.ai (GLM Coding Plan)",
    site: "https://docs.z.ai/devpack/mcp/search-mcp-server",
    key: { kind: "pi", provider: "zai" },
    endpoint: { label: `Z.ai search address (${CHINA} for bigmodel.cn keys)`, default: GLOBAL },
    price: "Counts against the GLM Coding Plan's quota",
    async search(search, { key, endpoint }) {
        const url = (endpoint ?? GLOBAL).trim();

        if (url !== GLOBAL && url !== CHINA) {
            throw new ProviderError("Z.ai", `the address must be ${GLOBAL} or ${CHINA}; set it in Settings › Web access`);
        }

        const { include, exclude } = splitDomains(search.domains);

        if (include.length > 1 || exclude.length > 0) {
            throw new ProviderError("Z.ai", "it can keep to one domain only, and cannot leave domains out");
        }

        const domain = include[0];
        const mcp = session(url, key, search.signal);

        await mcp.open();
        const listed = (await mcp.call("tools/list", {})) as { tools?: { name?: unknown }[] } | undefined;
        const tool = listed?.tools?.find((entry) => entry.name === "web_search_prime" || entry.name === "webSearchPrime")?.name;

        if (typeof tool !== "string") {
            throw new ProviderError("Z.ai", "the server lists no web search tool");
        }

        const called = (await mcp.call("tools/call", {
            name: tool,
            arguments: {
                search_query: search.query.trim(),
                ...(search.recency ? { search_recency_filter: RECENCY[search.recency] } : {}),
                ...(domain === undefined ? {} : { search_domain_filter: domain }),
            },
        })) as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
        const text = called?.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text;

        if (called?.isError) {
            throw new ProviderError("Z.ai", hide(text ?? "the search tool failed", key).slice(0, 300));
        }

        if (text === undefined) {
            throw new ProviderError("Z.ai", "the search tool answered no text");
        }

        // The result list is JSON text, sometimes encoded twice.
        let list: unknown;

        try {
            list = JSON.parse(text);
            list = typeof list === "string" ? JSON.parse(list) : list;
        } catch {
            throw new ProviderError("Z.ai", `the search tool answered something that is not a result list: ${hide(text, key).slice(0, 200)}`);
        }

        if (!Array.isArray(list)) {
            throw new ProviderError("Z.ai", "the search tool answered something that is not a result list");
        }

        return {
            results: tidy(
                (list as { link?: unknown; title?: unknown; content?: unknown }[])
                    .map((entry, index) => ({
                        title: clip(entry.title, 200) || `Source ${index + 1}`,
                        url: typeof entry.link === "string" ? entry.link : "",
                        snippet: clip(entry.content),
                    }))
                    .filter((result) => {
                        // The remote domain filter is undocumented, so it is kept to here too.
                        if (domain === undefined) {
                            return true;
                        }

                        try {
                            const host = new URL(result.url).hostname.toLowerCase().replace(/\.+$/, "");

                            return host === domain || host.endsWith(`.${domain}`);
                        } catch {
                            return false;
                        }
                    }),
                search.numResults,
            ),
        };
    },
};

export default provider;
