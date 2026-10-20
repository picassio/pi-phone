// No image over 2000 px a side reaches a model (src/server/image-guard.ts): sizes read from PNG, JPEG, GIF, and WebP
// headers; in a request, an Anthropic image block or a data URL over the limit is scaled, anywhere (inside a tool
// result too), and images within it are left as they are.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fitImages, imageSize } from "../src/server/image-guard.ts";

/** A PNG's first bytes: its signature and IHDR, with the size. */
const png = (width: number, height: number) => {
    const bytes = Buffer.alloc(33);

    bytes.writeUInt32BE(0x89504e47, 0);
    bytes.writeUInt32BE(0x0d0a1a0a, 4);
    bytes.writeUInt32BE(13, 8);
    bytes.write("IHDR", 12, "latin1");
    bytes.writeUInt32BE(width, 16);
    bytes.writeUInt32BE(height, 20);

    return bytes;
};

/** A JPEG's first bytes: SOI, an APP0 segment, and a baseline frame header with the size. */
const jpeg = (width: number, height: number) => {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const sof = Buffer.alloc(19);

    sof.writeUInt16BE(0xffc0, 0);
    sof.writeUInt16BE(17, 2);
    sof[4] = 8;
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);

    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
};

test("an image's size comes from its header", () => {
    assert.deepEqual(imageSize(png(900, 4000)), { width: 900, height: 4000 });
    assert.deepEqual(imageSize(jpeg(1082, 2258)), { width: 1082, height: 2258 });

    const gif = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x20, 0x03, 0x58, 0x02]);

    assert.deepEqual(imageSize(gif), { width: 800, height: 600 });
    assert.equal(imageSize(Buffer.from("not an image")), undefined);
});

test("a request's images over 2000 px a side are scaled, anywhere in it; smaller ones stay as they are", async () => {
    const asked: string[] = [];
    const images = {
        prepare: async (bytes: Uint8Array, mimeType: string, limits: { maxWidth: number; maxHeight: number }) => {
            asked.push(`${mimeType} ${imageSize(bytes)?.height} → ${limits.maxHeight}`);

            return { data: "U01BTEw=", mimeType: "image/jpeg" };
        },
    };
    const small = png(400, 800).toString("base64");
    const payload = {
        messages: [
            { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: small } }] },
            {
                role: "user",
                content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "a page" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg(900, 4000).toString("base64") } }] }],
            },
            { role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png(3000, 1000).toString("base64")}` } }] },
        ],
    };

    assert.equal(await fitImages(payload, images), 2);
    assert.deepEqual(asked, ["image/jpeg 4000 → 2000", "image/png 1000 → 2000"]);
    assert.equal((payload.messages[0]!.content[0] as { source: { data: string } }).source.data, small, "within the limit: as it was");
    assert.equal((payload.messages[1]!.content[0] as { content: { source?: { data: string } }[] }).content[1]!.source!.data, "U01BTEw=");
    assert.equal((payload.messages[2]!.content[0] as { image_url: { url: string } }).image_url.url, "data:image/jpeg;base64,U01BTEw=");
});
