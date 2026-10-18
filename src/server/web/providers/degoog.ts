/**
 * degoog (https://degoog.org): a self-hostable metasearch front end, `POST <address>/api/search` with `{ query, type:
 * "web", page: 1 }`. The public instance at https://degoog.org is the default address; a private one may protect its
 * search routes with a key, sent as a Bearer header. Recency is its `time`; domains go in the query as `site:` (grouped
 * with OR in parentheses) and `-site:`, and the answer is kept to them too. Ported from pi-web-access's `degoog.ts`
 * (MIT), without its engine list and extra-header settings and its SSRF guard (the address is the person's choice).
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const DEFAULT_ADDRESS = "https://degoog.org";

/** Whether `url`'s host is one of `include` (when any) and none of `exclude`, subdomains included. */
function within(url: string, include: readonly string[], exclude: readonly string[]): boolean {
    let host: string;

    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return false;
    }

    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return !exclude.some(matches) && (include.length === 0 || include.some(matches));
}

/** The instance's base address, without a trailing slash, query, or credentials; only http(s). */
function base(address: string): string {
    let url: URL;

    try {
        url = new URL(address.trim());
    } catch {
        throw new ProviderError("degoog", `the address "${address}" is not a URL; set an http(s) address in Settings › Web access`);
    }

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username !== "" || url.password !== "") {
        throw new ProviderError("degoog", "the address must be http(s), without a user name or password; set it in Settings › Web access");
    }

    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const provider: SearchProvider = {
    id: "degoog",
    name: "degoog",
    site: "https://degoog.org",
    key: { kind: "secret", secret: "DEGOOG_API_KEY", optional: true },
    endpoint: { label: "degoog address", default: DEFAULT_ADDRESS },
    price: "Free; the public instance needs no key",
    async search(search, { key, endpoint }) {
        const { include, exclude } = splitDomains(search.domains);
        const sites = include.map((domain) => `site:${domain}`);
        const query = [search.query, sites.length === 0 ? "" : sites.length === 1 ? sites[0] : `(${sites.join(" OR ")})`, ...exclude.map((domain) => `-site:${domain}`)]
            .filter((part) => part !== "")
            .join(" ");
        const answer = (await request("degoog", `${base(endpoint ?? DEFAULT_ADDRESS)}/api/search`, {
            body: { query, type: "web", page: 1, ...(search.recency ? { time: search.recency } : {}) },
            headers: key === undefined ? {} : { authorization: `Bearer ${key}` },
            signal: search.signal,
            key,
        }).catch((error: unknown) => {
            // Without a key, a 401 means the instance protects its search routes.
            if (error instanceof ProviderError && error.status === 401 && key === undefined) {
                throw new ProviderError("degoog", "this instance protects its search; add its key as DEGOOG_API_KEY in Settings › Secrets", 401);
            }

            throw error;
        })) as { results?: unknown };

        if (!Array.isArray(answer.results)) {
            throw new ProviderError("degoog", "answered without a results list");
        }

        return {
            results: tidy(
                (answer.results as { title?: unknown; url?: unknown; snippet?: unknown; content?: unknown }[])
                    .map((result) => {
                        const url = typeof result.url === "string" ? result.url.trim() : "";

                        return { title: clip(result.title, 200) || url, url, snippet: clip(result.snippet) || clip(result.content) };
                    })
                    .filter((result) => within(result.url, include, exclude)),
                search.numResults,
            ),
        };
    },
};

export default provider;
