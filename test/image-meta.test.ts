// Images for documents (PP-49): the type by bytes, and each of PNG, JPEG, WebP and GIF without its metadata: a JPEG
// keeps its orientation and colour profile; whatever is not one of the four, or is over 10 MB, is refused.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanImage, imageType, MAX_IMAGE_BYTES } from "../src/server/image-meta.ts";

const bytes = (...parts: (number[] | string | Uint8Array)[]) =>
    new Uint8Array(parts.flatMap((part) => (typeof part === "string" ? [...Buffer.from(part, "latin1")] : [...part])));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u32le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255];
const has = (data: Uint8Array, text: string) => Buffer.from(data).includes(Buffer.from(text, "latin1"));
const SECRET = "GPS 13.7563N 100.5018E";

test("types by their bytes, not their names", () => {
    assert.equal(imageType(bytes([0x89], "PNG\r\n\x1a\n")), "image/png");
    assert.equal(imageType(bytes([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
    assert.equal(imageType(bytes("RIFF", u32le(4), "WEBP")), "image/webp");
    assert.equal(imageType(bytes("GIF89a")), "image/gif");
    assert.equal(imageType(bytes("<svg>")), undefined);
    assert.throws(() => cleanImage(bytes("<svg onload=x>")), /Only PNG, JPEG, WebP and GIF/);
    assert.throws(() => cleanImage(new Uint8Array(MAX_IMAGE_BYTES + 1)), /10 MB at most/);
});

test("PNG: text, time and EXIF chunks go; the image stays", () => {
    const chunk = (type: string, data: string) => bytes(u32(data.length), type, data, [0, 0, 0, 0]);
    const image = bytes([0x89], "PNG\r\n\x1a\n", chunk("IHDR", "x".repeat(13)), chunk("tEXt", `Comment\0${SECRET}`), chunk("eXIf", SECRET), chunk("tIME", "1234567"), chunk("IDAT", "pixels"), chunk("IEND", ""));
    const { mime, bytes: clean } = cleanImage(image);

    assert.equal(mime, "image/png");
    assert.ok(!has(clean, SECRET) && !has(clean, "tIME"));
    assert.ok(has(clean, "IHDR") && has(clean, "pixels") && has(clean, "IEND"));
});

test("JPEG: EXIF, XMP and comments go; orientation and the colour profile stay", () => {
    // An Exif APP1: little-endian TIFF, IFD0 with orientation 6 and a GPS-ish string after it.
    const tiff = [0x49, 0x49, 0x2a, 0, ...u32le(8), 1, 0, 0x12, 0x01, 3, 0, ...u32le(1), 6, 0, 0, 0, ...u32le(0)];
    const exif = bytes("Exif\0\0", tiff, SECRET);
    const segment = (marker: number, body: Uint8Array) => bytes([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255], body);
    const image = bytes(
        [0xff, 0xd8],
        segment(0xe0, bytes("JFIF\0", [1, 1, 0, 0, 1, 0, 1, 0, 0])),
        segment(0xe1, exif),
        segment(0xe1, bytes("http://ns.adobe.com/xap/1.0/\0", SECRET)),
        segment(0xe2, bytes("ICC_PROFILE\0", [1, 1], "profile")),
        segment(0xfe, bytes(SECRET)),
        segment(0xdb, bytes("q".repeat(65))),
        segment(0xda, bytes([1, 1, 0, 0, 63, 0])),
        bytes("scan data", [0xff, 0x00], "more", [0xff, 0xd9]),
    );
    const { mime, bytes: clean } = cleanImage(image);

    assert.equal(mime, "image/jpeg");
    assert.ok(!has(clean, SECRET), "no location, XMP or comment");
    assert.ok(has(clean, "JFIF") && has(clean, "ICC_PROFILE") && has(clean, "scan data") && has(clean, "more"));
    assert.deepEqual([...clean.subarray(clean.length - 2)], [0xff, 0xd9]);
    // The orientation alone, right after SOI: Exif, big-endian TIFF, tag 0x0112 = 6.
    assert.deepEqual([...clean.subarray(0, 4)], [0xff, 0xd8, 0xff, 0xe1]);
    assert.ok(has(clean.subarray(0, 40), "Exif\0\0MM"));
    assert.deepEqual([...clean.subarray(22, 28)], [0x01, 0x12, 0, 3, 0, 0]);
    assert.equal(clean[31], 6);
    // Upright already: no Exif at all.
    const upright = image.slice();

    upright[upright.indexOf(6, 30)] = 1;
    assert.ok(!has(cleanImage(upright).bytes, "Exif"));
});

test("WebP: EXIF and XMP chunks go, and VP8X stops saying they are there", () => {
    const chunk = (type: string, data: Uint8Array) => bytes(type, u32le(data.length), data, data.length % 2 ? [0] : []);
    const body = bytes("WEBP", chunk("VP8X", bytes([0x0c | 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0])), chunk("VP8 ", bytes("frame")), chunk("EXIF", bytes(SECRET)), chunk("XMP ", bytes(SECRET)));
    const image = bytes("RIFF", u32le(body.length), body);
    const { mime, bytes: clean } = cleanImage(image);
    const view = new DataView(clean.buffer, clean.byteOffset);

    assert.equal(mime, "image/webp");
    assert.ok(!has(clean, SECRET) && has(clean, "frame"));
    assert.equal(view.getUint32(4, true), clean.length - 8, "RIFF size fixed");
    assert.equal(clean[20], 0x10, "only the alpha flag left");
});

test("GIF: comments and XMP go; looping stays", () => {
    const sub = (data: string) => bytes([data.length], data, [0]);
    const image = bytes(
        "GIF89a",
        [1, 0, 1, 0, 0x80, 0, 0],
        [0, 0, 0, 255, 255, 255],
        [0x21, 0xfe],
        sub(SECRET),
        [0x21, 0xff, 11],
        "NETSCAPE2.0",
        [3, 1, 0, 0, 0],
        [0x21, 0xff, 11],
        "XMP DataXMP",
        sub(SECRET),
        [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2],
        sub("px"),
        [0x3b],
    );
    const { mime, bytes: clean } = cleanImage(image);

    assert.equal(mime, "image/gif");
    assert.ok(!has(clean, SECRET) && !has(clean, "XMP"));
    assert.ok(has(clean, "NETSCAPE2.0") && has(clean, "px"));
    assert.equal(clean.at(-1), 0x3b);
});
