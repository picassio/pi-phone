/**
 * Images in a model request kept within 2000 pixels a side, the limit Anthropic holds every image to once a request
 * carries more than 20 ("At least one of the image dimensions exceed max allowed size for many-image requests"). One
 * bigger image anywhere in a conversation (a tall screenshot from a tool, an image a tool returned as it was) would
 * otherwise fail every request after it, for good. Each image's size is read from its header; only those over the limit
 * are decoded and scaled down (Photon, as Pi's read tool does), just for the request: the conversation keeps its own.
 *
 * The whole history goes with every request, so the same big images come again and again (PP-198: a session with 15
 * of them scaled all 15 on every request, a memory and CPU spike each time on a phone). Each image scaled is kept by its
 * content (a SHA-256 of its base64) in a small LRU (`ImageCache`, bounded by bytes and count): scaled once per process.
 * Images are scaled one at a time, so at most one is decoded at once. A failure inside the guard (the Photon worker
 * crashing, WebAssembly out of memory) never ends the server or the request: one log line, and the image goes as it
 * was, or, where the provider would refuse it (an Anthropic request with more than 20 images), a short text note
 * takes its place. A failed image is remembered too, so it is not tried again on every request.
 */
import { createHash } from "node:crypto";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

type StreamSimple = ModelRuntime["streamSimple"];

/** The most pixels a side an image in a request may have, for every provider. */
export const MAX_SIDE = 2000;

/** More images than this in an Anthropic request, and each must be within MAX_SIDE (else the request is refused). */
const MANY_IMAGES = 20;

/** What the guard did with one image: scaled (its new data), or could not (`failed`: sent as it was, or dropped). */
type Fitted = { data: string; mimeType: string } | { failed: string };

/**
 * Scaled images by a hash of their content, least recently used first out: at most `maxBytes` of their data and
 * `maxCount` of them. A failure is kept too (a few bytes), so a broken image is not tried again.
 */
export class ImageCache {
    readonly #items = new Map<string, Fitted>();
    readonly #maxBytes: number;
    readonly #maxCount: number;
    #bytes = 0;

    constructor(maxBytes = 32 * 1024 * 1024, maxCount = 128) {
        this.#maxBytes = maxBytes;
        this.#maxCount = maxCount;
    }

    static key(data: string, mimeType: string): string {
        return `${mimeType}:${createHash("sha256").update(data).digest("base64url")}`;
    }

    static #size(fitted: Fitted): number {
        return "data" in fitted ? fitted.data.length : fitted.failed.length;
    }

    get(key: string): Fitted | undefined {
        const found = this.#items.get(key);

        if (found !== undefined) {
            // The newest again.
            this.#items.delete(key);
            this.#items.set(key, found);
        }

        return found;
    }

    set(key: string, fitted: Fitted): void {
        const size = ImageCache.#size(fitted);

        if (size > this.#maxBytes) {
            return;
        }

        const before = this.#items.get(key);

        if (before !== undefined) {
            this.#items.delete(key);
            this.#bytes -= ImageCache.#size(before);
        }

        this.#items.set(key, fitted);
        this.#bytes += size;

        for (const [oldest, value] of this.#items) {
            if (this.#bytes <= this.#maxBytes && this.#items.size <= this.#maxCount) {
                break;
            }

            this.#items.delete(oldest);
            this.#bytes -= ImageCache.#size(value);
        }
    }

    get size(): number {
        return this.#items.size;
    }

    get bytes(): number {
        return this.#bytes;
    }
}

/** An image's size from the start of its base64: enough for its header, without decoding the whole image. */
function sizeOf(data: string): { width: number; height: number } | undefined {
    // 256 KB of image (a JPEG's frame header can come after a large EXIF block); the whole when that is not enough.
    const head = imageSize(new Uint8Array(Buffer.from(data.slice(0, 349_528), "base64")));

    return head ?? (data.length > 349_528 ? imageSize(new Uint8Array(Buffer.from(data, "base64"))) : undefined);
}

/** An image's width and height from its first bytes (PNG, JPEG, GIF, WebP), or undefined for another format. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | undefined {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    if (bytes.length >= 24 && view.getUint32(0) === 0x89504e47) {
        return { width: view.getUint32(16), height: view.getUint32(20) };
    }

    if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }

    if (bytes.length >= 30 && view.getUint32(0) === 0x52494646 && view.getUint32(8) === 0x57454250) {
        const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);

        if (chunk === "VP8 ") {
            return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }

        if (chunk === "VP8L") {
            const bits = view.getUint32(21, true);

            return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
        }

        if (chunk === "VP8X") {
            return { width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)), height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)) };
        }

        return undefined;
    }

    if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let at = 2;

        while (at + 9 < bytes.length) {
            if (bytes[at] !== 0xff) {
                return undefined;
            }

            const marker = bytes[at + 1]!;
            const length = view.getUint16(at + 2);

            // The frame headers (SOF0 to SOF15, but not DHT, JPG, or DAC) hold the size.
            if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                return { width: view.getUint16(at + 7), height: view.getUint16(at + 5) };
            }

            at += 2 + length;
        }
    }

    return undefined;
}

/** An image block of a request as Anthropic's API writes it (tool results hold them too). */
type AnthropicImage = { type: "image"; source: { type: "base64"; media_type: string; data: string } };

const isAnthropicImage = (value: unknown): value is AnthropicImage => {
    const block = value as AnthropicImage | null;

    return typeof block === "object" && block !== null && block.type === "image" && block.source?.type === "base64" && typeof block.source.data === "string";
};

/** A data URL of an image (OpenAI's `image_url.url` and `input_image.image_url`). */
const DATA_URL = /^data:(image\/[a-z+.-]+);base64,(.*)$/s;

/** What one pass of the guard did: images scaled now, taken from the cache, and that could not be scaled. */
export type FitReport = { scaled: number; cached: number; failed: number; dropped: number };

/** Count the images of a payload: Anthropic's image blocks (tool results' too) and image data URLs. */
function countImages(value: unknown): number {
    if (Array.isArray(value)) {
        return value.reduce<number>((sum, each) => sum + countImages(each), 0);
    }

    if (typeof value !== "object" || value === null) {
        return 0;
    }

    if (isAnthropicImage(value)) {
        return 1;
    }

    let count = 0;

    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
        count += typeof inner === "string" ? (DATA_URL.test(inner) && (key === "url" || key === "image_url") ? 1 : 0) : countImages(inner);
    }

    return count;
}

/**
 * Scale down, in place, every image in `payload` bigger than MAX_SIDE a side: Anthropic's image blocks and data URLs,
 * anywhere in it, one at a time. With `cache`, an image scaled (or failed) before is taken from it. One that cannot be
 * scaled is sent as it was, or, in an Anthropic request with more than 20 images (which the provider refuses), it is
 * replaced by a short text note. `log` hears each failure once.
 */
export async function fitImages(
    payload: unknown,
    images: ImageProcessor,
    cache: ImageCache = new ImageCache(),
    log: (line: string) => void = () => {},
): Promise<FitReport> {
    const limits = { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: 4.5 * 1024 * 1024 };
    const report: FitReport = { scaled: 0, cached: 0, failed: 0, dropped: 0 };
    const many = countImages(payload) > MANY_IMAGES;
    /** The image as the model may take it, `failed`, or undefined when it fits as it is (or cannot be read: left to the provider). */
    const fit = async (data: string, mimeType: string): Promise<Fitted | undefined> => {
        // The header first: an image that fits needs no hash.
        const size = sizeOf(data);

        if (size === undefined || (size.width <= MAX_SIDE && size.height <= MAX_SIDE)) {
            return undefined;
        }

        const key = ImageCache.key(data, mimeType);
        const known = cache.get(key);

        if (known !== undefined) {
            report.cached += 1;

            return known;
        }

        let fitted: Fitted;

        try {
            // A copy with memory of its own: an image under 4 KB decodes into Node's shared Buffer pool, which the Photon
            // worker cannot be handed ("Cannot transfer object of unsupported type"), as a Buffer's slice is a view.
            const prepared = await images.prepare(new Uint8Array(Buffer.from(data, "base64")), mimeType, limits);

            fitted = prepared === undefined ? { failed: "it could not be read" } : { data: prepared.data, mimeType: prepared.mimeType };
        } catch (error) {
            fitted = { failed: error instanceof Error ? error.message : String(error) };
        }

        if ("failed" in fitted) {
            log(`image guard: could not scale a ${size.width}×${size.height} image (${fitted.failed.slice(0, 200)}): ${many ? "left out with a note" : "sent as it was"}`);
        } else {
            report.scaled += 1;
        }

        cache.set(key, fitted);

        return fitted;
    };
    /** The text that takes an image's place where the provider would refuse it. */
    const note = (failed: string) => `[An image over ${MAX_SIDE} px was left out of this request: it could not be scaled down (${failed.slice(0, 120)}).]`;
    const visit = async (value: unknown): Promise<void> => {
        if (Array.isArray(value)) {
            for (const each of value) {
                await visit(each);
            }

            return;
        }

        if (typeof value !== "object" || value === null) {
            return;
        }

        if (isAnthropicImage(value)) {
            const fitted = await fit(value.source.data, value.source.media_type);

            if (fitted !== undefined && "data" in fitted) {
                value.source.data = fitted.data;
                value.source.media_type = fitted.mimeType;
            } else if (fitted !== undefined) {
                report.failed += 1;

                if (many) {
                    // Anthropic refuses the whole request for it: a note in its place.
                    const block = value as unknown as Record<string, unknown>;

                    delete block.source;
                    block.type = "text";
                    block.text = note(fitted.failed);
                    report.dropped += 1;
                }
            }

            return;
        }

        const record = value as Record<string, unknown>;

        for (const [key, inner] of Object.entries(record)) {
            const url = typeof inner === "string" ? DATA_URL.exec(inner) : null;

            if (url !== null && (key === "url" || key === "image_url")) {
                const fitted = await fit(url[2]!, url[1]!);

                if (fitted !== undefined && "data" in fitted) {
                    record[key] = `data:${fitted.mimeType};base64,${fitted.data}`;
                } else if (fitted !== undefined) {
                    // Sent as it was: these providers take bigger images.
                    report.failed += 1;
                }
            } else if (typeof inner === "object" && inner !== null) {
                await visit(inner);
            }
        }
    };

    await visit(payload);

    return report;
}

/**
 * Fit every model request's images (`fitImages`), after the caller's own `onPayload`, with one cache for the process.
 * Whatever goes wrong in the guard is logged and the request goes as it was: the guard never fails a request or the
 * server.
 */
export function installImageGuard(
    models: { streamSimple: StreamSimple },
    images: ImageProcessor,
    log: (line: string) => void,
    cache: ImageCache = new ImageCache(),
): void {
    const underlying = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) =>
        underlying(model, context, {
            ...options,
            onPayload: async (payload, requestModel) => {
                const upstream = options?.onPayload === undefined ? undefined : await options.onPayload(payload, requestModel);
                const sent = upstream ?? payload;

                try {
                    const report = await fitImages(sent, images, cache, log);

                    // Only new work is worth a line: images taken from the cache are not.
                    if (report.scaled > 0) {
                        log(`image guard: scaled ${report.scaled} image(s) over ${MAX_SIDE} px for ${requestModel.provider}/${requestModel.id}${report.cached > 0 ? ` (${report.cached} from the cache)` : ""}`);
                    }
                } catch (error) {
                    log(`image guard: failed, the request goes as it was: ${error instanceof Error ? error.message : String(error)}`);
                }

                return sent;
            },
        });
}
