/**
 * Brave's Search API (https://api-dashboard.search.brave.com/app/documentation/web-search): its own index, `GET
 * /res/v1/web/search` with the key in `X-Subscription-Token`. Recency is `freshness` (`pd`, `pw`, `pm`, `py`). Domains
 * go in the query as `site:` (OR-ed) and `NOT site:`; Brave honours them loosely, so with domains it is asked for 20
 * and the answer is kept to them. Titles and descriptions mark matches with tags and HTML entities, which are taken
 * out. Ported from pi-web-access's `brave.ts` (MIT), without its rate-limit queue and its retry after a 429.
 */
import { clip, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" };

const ENTITIES: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " ",
    "&mdash;": "—", "&ndash;": "–", "&hellip;": "…", "&rsquo;": "’", "&lsquo;": "‘",
    "&rdquo;": "”", "&ldquo;": "“", "&middot;": "·", "&bull;": "•", "&deg;": "°",
};

/** `value` without tags and with its entities decoded. */
function plain(value: unknown): string {
    return typeof value !== "string"
        ? ""
        : value.replace(/<[^>]*>/g, "").replace(/&(?:#(x?)([0-9a-f]+)|[a-z]+);/gi, (entity, hex: string | undefined, digits: string | undefined) => {
              if (digits === undefined) {
                  return ENTITIES[entity.toLowerCase()] ?? entity;
              }

              const code = Number.parseInt(digits, hex ? 16 : 10);

              return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
          });
}

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

const provider: SearchProvider = {
    id: "brave",
    name: "Brave Search",
    site: "https://brave.com/search/api/",
    key: { kind: "secret", secret: "BRAVE_API_KEY" },
    async search(search, { key }) {
        const { include, exclude } = splitDomains(search.domains);
        const query = [search.query, include.map((domain) => `site:${domain}`).join(" OR "), ...exclude.map((domain) => `NOT site:${domain}`)]
            .filter((part) => part !== "")
            .join(" ");
        const params = new URLSearchParams({ q: query, count: String(include.length + exclude.length > 0 ? 20 : search.numResults) });

        if (search.recency) {
            params.set("freshness", FRESHNESS[search.recency]);
        }

        const answer = (await request("Brave Search", `https://api.search.brave.com/res/v1/web/search?${params}`, {
            headers: { "x-subscription-token": `${key}` },
            signal: search.signal,
            key,
        })) as { web?: { results?: { title?: unknown; url?: unknown; description?: unknown; page_age?: unknown }[] } };

        return {
            results: tidy(
                (answer.web?.results ?? [])
                    .map((result) => ({
                        url: String(result.url ?? ""),
                        title: clip(plain(result.title), 200) || String(result.url ?? ""),
                        snippet: clip(plain(result.description)),
                        ...(typeof result.page_age === "string" ? { date: result.page_age } : {}),
                    }))
                    .filter((result) => within(result.url, include, exclude)),
                search.numResults,
            ),
        };
    },
};

export default provider;
