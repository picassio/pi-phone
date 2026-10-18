/**
 * DuckDuckGo's HTML search (https://html.duckduckgo.com/html/): keyless, a results page read for its `.result`
 * blocks; ads are skipped and its `/l/?uddg=` redirect links are opened to the page they lead to. Domains are kept to
 * after the answer (as in pi-web-access). Recency is its `df` parameter (`d`, `w`, `m`, `y`), which pi-web-access does
 * not send. DuckDuckGo meets too many requests with a bot check, which is reported as such. Ported from pi-web-access's
 * `duckduckgo.ts` (MIT), with a small reader of its markup in place of linkedom.
 */
import { clip, ProviderError, request, splitDomains, tidy } from "../http.ts";
import type { SearchProvider } from "../types.ts";

const SEARCH_URL = "https://html.duckduckgo.com/html/";
const DF = { day: "d", week: "w", month: "m", year: "y" };
const USER_AGENT = "Mozilla/5.0 (compatible; pi-phone/1.0; +https://github.com/nicobailon/pi-web-access)";

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Markup as text: tags out, entities decoded. */
function text(html: string): string {
    return html
        .replace(/<[^>]*>/g, "")
        .replace(/&(?:#(x?)([0-9a-f]+)|([a-z]+));/gi, (entity, hex: string | undefined, digits: string | undefined, name: string | undefined) => {
            if (digits === undefined) {
                return ENTITIES[(name ?? "").toLowerCase()] ?? entity;
            }

            const code = Number.parseInt(digits, hex ? 16 : 10);

            return code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : entity;
        })
        .trim();
}

/** The page a result link leads to: DuckDuckGo's `uddg` target, or the link itself; only http(s). */
function destination(href: string): string | undefined {
    try {
        const link = new URL(text(href), SEARCH_URL);
        const url = new URL(link.searchParams.get("uddg") ?? link.href);

        return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
    } catch {
        return undefined;
    }
}

/** Whether `url`'s host is one of `include` (when any) and none of `exclude`, subdomains included. */
function within(url: string, include: readonly string[], exclude: readonly string[]): boolean {
    const host = new URL(url).hostname.toLowerCase();
    const matches = (domain: string) => host === domain || host.endsWith(`.${domain}`);

    return !exclude.some(matches) && (include.length === 0 || include.some(matches));
}

const provider: SearchProvider = {
    id: "duckduckgo",
    name: "DuckDuckGo",
    site: "https://duckduckgo.com",
    key: { kind: "none" },
    price: "Free, no key",
    async search(search) {
        const params = new URLSearchParams({ q: search.query });

        if (search.recency) {
            params.set("df", DF[search.recency]);
        }

        const html = (await request("DuckDuckGo", `${SEARCH_URL}?${params}`, {
            headers: { accept: "text/html", "user-agent": USER_AGENT },
            signal: search.signal,
            text: true,
        })) as string;

        if (/class="[^"]*(?:anomaly-modal__box)|id="challenge-form"/.test(html)) {
            throw new ProviderError("DuckDuckGo", "it answered with a bot check (too many requests); try again later or pick another provider");
        }

        const { include, exclude } = splitDomains(search.domains);
        const found: { title: string; url: string; snippet: string }[] = [];
        let readable = 0;

        // Each result is a `<div class="result …">` up to the next one.
        for (const block of html.split(/(?=<div class="result[\s"])/).slice(1)) {
            const classes = /^<div class="([^"]*)"/.exec(block)?.[1] ?? "";

            if (classes.split(/\s+/).includes("result--ad")) {
                continue;
            }

            const anchor = /<a\b[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/.exec(block);
            const href = anchor === null ? undefined : /\bhref="([^"]*)"/.exec(anchor[0])?.[1];
            const title = anchor === null ? "" : text(anchor[1] ?? "");
            const url = href === undefined ? undefined : destination(href);

            if (title === "" || url === undefined) {
                continue;
            }

            readable += 1;

            if (within(url, include, exclude)) {
                const snippet = /<(a|div|td|span)\b[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/\1>/.exec(block)?.[2] ?? "";

                found.push({ title: clip(title, 200), url, snippet: clip(text(snippet)) });
            }
        }

        if (readable === 0 && !html.includes("no-results__message")) {
            throw new ProviderError("DuckDuckGo", "answered a page with no results to read");
        }

        return { results: tidy(found, search.numResults) };
    },
};

export default provider;
