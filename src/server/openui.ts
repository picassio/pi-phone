/**
 * What Open Intelligent UI's components fetch from their own server (`/api/wiki`, `/api/image-search`,
 * `/api/street-route`), ported from its route handlers (MIT, thesysdev/open-intelligent-ui, `src/app/api/`), with the
 * same caches and limits. The frame that draws an answer has an opaque origin and no sign-in: it asks the app's page,
 * which asks here (`GET /api/openui/<name>`), signed in.
 *
 * - `wiki`: a Wikipedia article's lead photos and coordinates, by title.
 * - `image-search`: photos for a description: matching Wikipedia lead images, then Wikimedia Commons files.
 * - `street-route`: street geometry between stops, from the public OSRM demo server (a driving overview).
 *
 * Also what people typed and picked in interactive answers (`OpenUiStateDoc`).
 */
import type { JsonValue } from "@earendil-works/chord";
import { defineDoc } from "@earendil-works/pi-durable";

/** What a route answers: its status and JSON, as the component expects them. */
export type OpenUiAnswer = { status: number; body: unknown };

/**
 * What people typed and picked in a conversation's interactive answers, by answer (a key the page makes from the
 * program, or the artifact's address): the renderer's form state and `$` bindings, so an answer shows them again when
 * the conversation opens again, on any device. The newest `MAX_ANSWER_STATES` are kept.
 */
export const OpenUiStateDoc = defineDoc<{ items: Record<string, { state: { [key: string]: JsonValue }; at: number }> }>({
    kind: "pocket.openui-state",
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "current",
    initial: () => ({ items: {} }),
});

export const MAX_ANSWER_STATES = 200;
/** One answer's state, as JSON. */
export const MAX_ANSWER_STATE_BYTES = 64 * 1024;
export const ANSWER_KEY = /^[a-z0-9-]{1,64}$/;

const AGENT = { "User-Agent": "pi-phone (https://github.com/picassio/pi-phone), with open-intelligent-ui's components" };
const failed = (message: string, status = 502): OpenUiAnswer => ({ status, body: { error: { message } } });

/** A cache that forgets its oldest entry past `size`. */
function bounded<T>(size: number) {
    const entries = new Map<string, T>();

    return {
        get: (key: string) => entries.get(key),
        set: (key: string, value: T) => {
            if (entries.size >= size) {
                entries.delete(entries.keys().next().value!);
            }

            entries.set(key, value);
        },
    };
}

// ─── wiki ─────────────────────────────────────────────────────────────────────────────────────────────────────────

type WikiInfo = { lat?: number; lng?: number; photos: string[] };
const wikiCache = bounded<WikiInfo>(500);

// A missing article is an answer (cached); any other failure is tried again next time.
async function wikiGet(url: string): Promise<Record<string, unknown>> {
    const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(8000) });

    if (response.status === 404) {
        return {};
    }

    if (!response.ok) {
        throw new Error(`Wikipedia ${response.status}`);
    }

    return (await response.json()) as Record<string, unknown>;
}

export async function wiki(title: string | null): Promise<OpenUiAnswer> {
    const name = title?.trim();

    if (!name || name.length > 200) {
        return failed("title is required", 400);
    }

    let info = wikiCache.get(name);

    if (info === undefined) {
        const t = encodeURIComponent(name.replace(/ /g, "_"));

        try {
            const [summary, media] = (await Promise.all([
                wikiGet(`https://en.wikipedia.org/api/rest_v1/page/summary/${t}`),
                wikiGet(`https://en.wikipedia.org/api/rest_v1/page/media-list/${t}`),
            ])) as [
                { thumbnail?: { source?: string }; coordinates?: { lat?: number; lon?: number } },
                { items?: { type?: string; srcset?: { src: string }[] }[] },
            ];
            // Lead image first, then up to two more photos; no maps, logos, flags, or SVGs.
            const photos: string[] = [];
            const key = (url: string) => decodeURIComponent(url.split("?")[0]!.split("/").slice(-1)[0]!).replace(/^\d+px-/, "");

            if (summary.thumbnail?.source) {
                photos.push(summary.thumbnail.source);
            }

            for (const item of media.items ?? []) {
                if (item.type !== "image" || !item.srcset?.length) {
                    continue;
                }

                const src = item.srcset[0]!.src;

                if (/\.svg|icon|logo|map|flag|seal/i.test(src)) {
                    continue;
                }

                const url = src.startsWith("//") ? `https:${src}` : src;

                if (!photos.some((photo) => key(photo) === key(url))) {
                    photos.push(url);
                }

                if (photos.length >= 3) {
                    break;
                }
            }

            info = {
                ...(summary.coordinates?.lat === undefined ? {} : { lat: summary.coordinates.lat }),
                ...(summary.coordinates?.lon === undefined ? {} : { lng: summary.coordinates.lon }),
                photos,
            };
            wikiCache.set(name, info);
        } catch {
            return failed("Wikipedia unavailable");
        }
    }

    return { status: 200, body: info };
}

// ─── image-search ─────────────────────────────────────────────────────────────────────────────────────────────────

type Page = { index?: number; title?: string; thumbnail?: { source?: string }; imageinfo?: { thumburl?: string; url?: string; mime?: string }[] };
const imageCache = bounded<string[]>(500);
const SKIP = /\.svg|icon|logo|map|flag|seal|coat_of_arms|signature|diagram/i;
const WIDTH = 960;

async function mediaQuery(host: string, params: Record<string, string>): Promise<Page[]> {
    const url = `https://${host}/w/api.php?${new URLSearchParams({ action: "query", format: "json", formatversion: "2", ...params })}`;
    const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(8000) });

    if (!response.ok) {
        throw new Error(`${host} ${response.status}`);
    }

    const data = (await response.json()) as { error?: unknown; query?: { pages?: Page[] } };

    // A rate limit comes back as 200 with an error: thrown, so "no photos" is not cached.
    if (data.error) {
        throw new Error(`${host} error`);
    }

    return (data.query?.pages ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

/** Words that say what a photo shows; an article must share one with the query. */
const words = (text: string) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3);

async function findImages(q: string): Promise<string[]> {
    const images: string[] = [];
    const add = (url: string | undefined) => {
        if (url && url.startsWith("https://") && !SKIP.test(url) && !images.includes(url)) {
            images.push(url);
        }
    };
    const wanted = new Set(words(q));
    // Wikipedia articles first, only those whose title is about the query.
    const articles = await mediaQuery("en.wikipedia.org", {
        generator: "search",
        gsrsearch: q,
        gsrlimit: "6",
        prop: "pageimages",
        piprop: "thumbnail",
        pithumbsize: String(WIDTH),
    });

    articles.filter((page) => words(page.title ?? "").some((word) => wanted.has(word))).forEach((page) => add(page.thumbnail?.source));

    // Then Commons files, dropping trailing words when a long description finds nothing.
    const terms = q.split(/\s+/);

    for (const term of [...new Set([terms.join(" "), terms.slice(0, 3).join(" "), terms.slice(0, 2).join(" ")])]) {
        if (images.length >= 3) {
            break;
        }

        const files = await mediaQuery("commons.wikimedia.org", {
            generator: "search",
            gsrsearch: `${term} filetype:bitmap`,
            gsrnamespace: "6",
            gsrlimit: "6",
            prop: "imageinfo",
            iiprop: "url|mime",
            iiurlwidth: String(WIDTH),
        });

        for (const page of files) {
            const info = page.imageinfo?.[0];

            if (info?.mime?.startsWith("image/")) {
                add(info.thumburl ?? info.url);
            }
        }
    }

    return images.slice(0, 4);
}

export async function imageSearch(raw: string | null): Promise<OpenUiAnswer> {
    const q = raw?.replace(/\s+/g, " ").trim();

    if (!q || q.length < 2 || q.length > 200) {
        return failed("q must be 2 to 200 characters", 400);
    }

    let images = imageCache.get(q);

    if (images === undefined) {
        try {
            images = await findImages(q);
        } catch {
            return failed("Image search unavailable");
        }

        imageCache.set(q, images);
    }

    return { status: 200, body: { images } };
}

// ─── street-route ─────────────────────────────────────────────────────────────────────────────────────────────────

const routeCache = bounded<[number, number][]>(200);
const MAX_STOPS = 25;

export async function streetRoute(coords: string | null): Promise<OpenUiAnswer> {
    // "lng,lat;lng,lat;…", at least two valid points.
    const points = (coords ?? "").split(";").map((pair) => pair.split(",").map(Number));
    const valid =
        points.length >= 2 &&
        points.length <= MAX_STOPS &&
        points.every(([lng, lat, ...rest]) => rest.length === 0 && Math.abs(lng!) <= 180 && Math.abs(lat!) <= 90);

    if (!valid) {
        return failed(`coords must be 2–${MAX_STOPS} lng,lat pairs`, 400);
    }

    const key = points.map((point) => point.join(",")).join(";");
    let route = routeCache.get(key);

    if (route === undefined) {
        try {
            const response = await fetch(
                `https://router.project-osrm.org/route/v1/driving/${key}?overview=full&geometries=geojson&steps=false`,
                { headers: AGENT, signal: AbortSignal.timeout(10_000) },
            );

            if (!response.ok) {
                throw new Error(`OSRM ${response.status}`);
            }

            const data = (await response.json()) as { code?: string; routes?: { geometry?: { coordinates?: [number, number][] } }[] };
            const coordinates = data.routes?.[0]?.geometry?.coordinates ?? [];

            if (data.code !== "Ok" || coordinates.length < 2) {
                throw new Error("No street route");
            }

            route = coordinates.map(([lng, lat]) => [lat, lng] as [number, number]);
            routeCache.set(key, route);
        } catch {
            return failed("Street routing unavailable");
        }
    }

    return { status: 200, body: { points: route } };
}

/** The route a frame asked for, by name. */
export function openUiRoute(name: string, query: URLSearchParams): Promise<OpenUiAnswer> | undefined {
    switch (name) {
        case "wiki":
            return wiki(query.get("title"));
        case "image-search":
            return imageSearch(query.get("q"));
        case "street-route":
            return streetRoute(query.get("coords"));
        default:
            return undefined;
    }
}
