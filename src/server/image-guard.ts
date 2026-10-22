/**
 * Images in a model request kept within 2000 pixels a side, the limit Anthropic holds every image to once a request
 * carries more than 20 ("At least one of the image dimensions exceed max allowed size for many-image requests"). One
 * bigger image anywhere in a conversation (a tall screenshot from a tool, an image a tool returned as it was) would
 * otherwise fail every request after it, for good. Each image's size is read from its header; only those over the limit
 * are decoded and scaled down (Photon, as Pi's read tool does), just for the request: the conversation keeps its own.
 */
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ImageProcessor } from "@earendil-works/pi-durable/tools";

type StreamSimple = ModelRuntime["streamSimple"];

/** The most pixels a side an image in a request may have, for every provider. */
export const MAX_SIDE = 2000;

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

/**
 * Scale down, in place, every image in `payload` bigger than MAX_SIDE a side: Anthropic's image blocks and data URLs,
 * anywhere in it. Answers how many it scaled.
 */
export async function fitImages(payload: unknown, images: ImageProcessor): Promise<number> {
    const limits = { maxWidth: MAX_SIDE, maxHeight: MAX_SIDE, maxBytes: 4.5 * 1024 * 1024 };
    let scaled = 0;
    /** The image as the model may take it, or undefined when it fits as it is (or cannot be read: left to the provider). */
    const fit = async (data: string, mimeType: string): Promise<{ data: string; mimeType: string } | undefined> => {
        // A copy with memory of its own: an image under 4 KB decodes into Node's shared Buffer pool, which the Photon
        // worker cannot be handed ("Cannot transfer object of unsupported type"), as a Buffer's slice is a view.
        const bytes = new Uint8Array(Buffer.from(data, "base64"));
        const size = imageSize(bytes);

        if (size === undefined || (size.width <= MAX_SIDE && size.height <= MAX_SIDE)) {
            return undefined;
        }

        const prepared = await images.prepare(bytes, mimeType, limits);

        if (prepared === undefined) {
            return undefined;
        }

        scaled += 1;

        return { data: prepared.data, mimeType: prepared.mimeType };
    };
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

            if (fitted !== undefined) {
                value.source.data = fitted.data;
                value.source.media_type = fitted.mimeType;
            }

            return;
        }

        const record = value as Record<string, unknown>;

        for (const [key, inner] of Object.entries(record)) {
            const url = typeof inner === "string" ? DATA_URL.exec(inner) : null;

            if (url !== null && (key === "url" || key === "image_url")) {
                const fitted = await fit(url[2]!, url[1]!);

                if (fitted !== undefined) {
                    record[key] = `data:${fitted.mimeType};base64,${fitted.data}`;
                }
            } else if (typeof inner === "object" && inner !== null) {
                await visit(inner);
            }
        }
    };

    await visit(payload);

    return scaled;
}

/** Fit every model request's images (`fitImages`), after the caller's own `onPayload`. */
export function installImageGuard(models: { streamSimple: StreamSimple }, images: ImageProcessor, log: (line: string) => void): void {
    const underlying = models.streamSimple.bind(models);

    models.streamSimple = (model, context, options) =>
        underlying(model, context, {
            ...options,
            onPayload: async (payload, requestModel) => {
                const upstream = options?.onPayload === undefined ? undefined : await options.onPayload(payload, requestModel);
                const sent = upstream ?? payload;
                const scaled = await fitImages(sent, images);

                if (scaled > 0) {
                    log(`image guard: scaled ${scaled} image(s) over ${MAX_SIDE} px for ${requestModel.provider}/${requestModel.id}`);
                }

                return sent;
            },
        });
}
