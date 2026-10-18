/**
 * Baizhi Cloud Agent Toolkit (https://baizhi.cloud/landing/agent-toolkit): its `websearch_search` tool over
 * streamable-HTTP MCP at agent-toolkit.app.baizhi.cloud, with the key as a Bearer header. The tool publishes no output
 * schema, so its text is the answer and there are no result cards (as in pi-web-access). Domains go in its `filter`
 * object; recency is its `time_range`, which is `month` when none is asked for (the tool's documented default);
 * generated summaries are off. Ported from pi-web-access's `baizhi.ts` (MIT).
 */
import { mcpCall, ProviderError, splitDomains } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const MCP_URL = "https://agent-toolkit.app.baizhi.cloud/mcp";

const provider: SearchProvider = {
    id: "baizhi",
    name: "Baizhi",
    site: "https://agent-toolkit.app.baizhi.cloud/",
    key: { kind: "secret", secret: "BAIZHI_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const args = {
            query: search.query.trim(),
            count: search.numResults,
            need_summary: false,
            time_range: search.recency ?? "month",
            ...(include.length > 0 || exclude.length > 0
                ? { filter: { ...(include.length > 0 ? { domains: include } : {}), ...(exclude.length > 0 ? { exclude_domains: exclude } : {}) } }
                : {}),
        };
        let text: string;

        try {
            text = await mcpCall("Baizhi", MCP_URL, "websearch_search", args, search.signal, { authorization: `Bearer ${key}` });
        } catch (error) {
            // mcpCall quotes what the server said; that may echo the key, which it does not know to hide.
            if (error instanceof ProviderError && key !== undefined && error.message.includes(key)) {
                throw new ProviderError("Baizhi", error.message.replace(/^Baizhi: /, "").split(key).join("[key]"), error.status);
            }

            throw error;
        }

        if (text.trim() === "") {
            throw new ProviderError("Baizhi", "the search tool answered nothing");
        }

        return { answer: key === undefined ? text : text.split(key).join("[key]"), results: [] };
    },
};

export default provider;
