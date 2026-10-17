/**
 * Images through `read`. Pi Durable 1.1.0's read tool refuses image files ("reading images is not supported"); Pi's
 * terminal app reads them. This wraps the installed `read`: a PNG, JPEG, GIF, or WebP is read through the call's
 * execution environment, resized as Pi does (at most 2000 px a side, small enough for providers), and returned as an
 * image block, which the model sees and the transcript shows as a thumbnail (`projection.ts`). Anything else goes to the
 * read tool as it is.
 */
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { defineExtension, wrapTool } from "@earendil-works/pi-durable";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { sniffImage } from "../http/assets.ts";

/** Pi's own cap on an image file it will read. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Enough for any supported image's signature. */
const HEAD_BYTES = 32;
const CHUNK = 1024 * 1024;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export default function createReadImages() {
    const read = createReadTool();

    return defineExtension({
        name: "phone-read-images",
        wraps: [
            wrapTool(read, (tool) => ({
                ...tool,
                description: `${tool.description} Images (PNG, JPEG, GIF, WebP) are returned as images.`,
                async execute(args, api, context) {
                    const env = api.env;

                    if (env === undefined) {
                        return tool.execute(args, api, context);
                    }

                    // As the read tool resolves it: unicode spaces as spaces, a leading @ dropped.
                    const written = args.path.replace(UNICODE_SPACES, " ");
                    const path = getOrThrow(
                        await env.absolutePath(written.startsWith("@") ? written.slice(1) : written, context),
                    );

                    if (!getOrThrow(await env.exists(path, context))) {
                        return tool.execute(args, api, context);
                    }

                    const reader = getOrThrow(await env.openBinaryReader(path, undefined, context));
                    let bytes: Buffer;
                    let mimeType: string | undefined;

                    try {
                        const info = getOrThrow(await reader.info(context));

                        mimeType = sniffImage(Buffer.from(getOrThrow(await reader.read(0, HEAD_BYTES, context))));

                        if (mimeType === undefined) {
                            return tool.execute(args, api, context);
                        }

                        if (info.size > MAX_IMAGE_BYTES) {
                            throw new Error(
                                `${args.path} is an image of ${Math.round(info.size / 1e6)} MB; images up to ${MAX_IMAGE_BYTES / 1e6} MB are read.`,
                            );
                        }

                        const chunks: Uint8Array[] = [];

                        for (let position = 0; position < info.size; ) {
                            const chunk = getOrThrow(
                                await reader.read(position, Math.min(CHUNK, info.size - position), context),
                            );

                            if (chunk.length === 0) {
                                break;
                            }

                            chunks.push(chunk);
                            position += chunk.length;
                        }

                        bytes = Buffer.concat(chunks);
                    } finally {
                        await reader.close(context);
                    }

                    const image = await resizeImage(bytes, mimeType);

                    if (image === null) {
                        throw new Error(`${args.path} could not be made small enough for the model.`);
                    }

                    const note = formatDimensionNote(image);

                    return {
                        content: [
                            { type: "text", text: `Read image file [${image.mimeType}]${note ? `\n${note}` : ""}` },
                            { type: "image", data: image.data, mimeType: image.mimeType },
                        ],
                    };
                },
            })),
        ],
    });
}
