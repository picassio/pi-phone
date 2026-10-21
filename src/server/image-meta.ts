/**
 * Images for documents (PP-49): which of PNG, JPEG, WebP and GIF a file is, by its bytes (never its name), and the same
 * image without what a camera or an editor wrote into it: location, camera, dates, comments, XMP. A JPEG keeps only
 * its orientation (a phone's photo would otherwise show on its side) and its colour profile.
 */
import { HttpError } from "./errors.ts";

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/** The most an image may be, before its metadata goes. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** The image's type, from its first bytes, or undefined for anything else. */
export function imageType(bytes: Uint8Array): ImageMime | undefined {
    const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));

    if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 4) === "PNG") {
        return "image/png";
    }

    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return "image/jpeg";
    }

    if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
        return "image/webp";
    }

    if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
        return "image/gif";
    }

    return undefined;
}

/** The image without its metadata, and its type. Refuses what is not one of the four types, or larger than 10 MB. */
export function cleanImage(bytes: Uint8Array): { mime: ImageMime; bytes: Uint8Array } {
    if (bytes.length > MAX_IMAGE_BYTES) {
        throw new HttpError(413, "An image may be 10 MB at most.");
    }

    const mime = imageType(bytes);

    if (mime === undefined) {
        throw new HttpError(400, "Only PNG, JPEG, WebP and GIF images can go in documents.");
    }

    try {
        const clean = mime === "image/png" ? png(bytes) : mime === "image/jpeg" ? jpeg(bytes) : mime === "image/webp" ? webp(bytes) : gif(bytes);

        return { mime, bytes: clean };
    } catch (error) {
        throw error instanceof HttpError ? error : new HttpError(400, `This ${mime.slice(6).toUpperCase()} image is damaged: ${error instanceof Error ? error.message : String(error)}`);
    }
}

const concat = (parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;

    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }

    return out;
};

const need = (bytes: Uint8Array, end: number) => {
    if (end > bytes.length) {
        throw new Error("it ends too early");
    }
};

/** PNG: every chunk but text, time and EXIF ones. */
function png(bytes: Uint8Array): Uint8Array {
    const DROP = new Set(["tEXt", "zTXt", "iTXt", "tIME", "eXIf"]);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts = [bytes.subarray(0, 8)];

    for (let at = 8; at < bytes.length; ) {
        need(bytes, at + 12);
        const length = view.getUint32(at);
        const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
        const end = at + 12 + length;

        need(bytes, end);

        if (!DROP.has(type)) {
            parts.push(bytes.subarray(at, end));
        }

        at = end;

        if (type === "IEND") {
            break;
        }
    }

    return concat(parts);
}

/** JPEG: no APPn segments but the colour profile (APP2 ICC) and Adobe's (APP14), no comments; orientation kept. */
function jpeg(bytes: Uint8Array): Uint8Array {
    const parts = [bytes.subarray(0, 2)];
    let orientation: number | undefined;

    for (let at = 2; at < bytes.length; ) {
        need(bytes, at + 2);

        if (bytes[at] !== 0xff) {
            throw new Error("a segment does not start where it should");
        }

        const marker = bytes[at + 1]!;

        // Fill bytes, then markers with no length.
        if (marker === 0xff) {
            at += 1;
            continue;
        }

        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
            parts.push(bytes.subarray(at, at + 2));
            at += 2;
            continue;
        }

        need(bytes, at + 4);
        const length = (bytes[at + 2]! << 8) | bytes[at + 3]!;
        const end = at + 2 + length;

        need(bytes, end);
        const body = bytes.subarray(at + 4, end);
        const isApp = marker >= 0xe0 && marker <= 0xef;
        const keep = !isApp || marker === 0xe0 || marker === 0xee || (marker === 0xe2 && String.fromCharCode(...body.subarray(0, 11)) === "ICC_PROFILE");

        if (marker === 0xe1 && orientation === undefined) {
            orientation = exifOrientation(body);
        }

        if (keep && marker !== 0xfe) {
            parts.push(bytes.subarray(at, end));
        }

        // The image data: everything after the scan's header goes as it is.
        if (marker === 0xda) {
            parts.push(bytes.subarray(end));
            break;
        }

        at = end;
    }

    if (orientation !== undefined && orientation !== 1) {
        parts.splice(1, 0, orientationSegment(orientation));
    }

    return concat(parts);
}

/** The orientation (1 to 8) in an APP1 Exif segment's body, if it has one. */
function exifOrientation(body: Uint8Array): number | undefined {
    if (String.fromCharCode(...body.subarray(0, 4)) !== "Exif" || body.length < 14) {
        return undefined;
    }

    const tiff = body.subarray(6);
    const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const little = tiff[0] === 0x49;
    const first = view.getUint32(4, little);

    if (first + 2 > tiff.length) {
        return undefined;
    }

    const count = view.getUint16(first, little);

    for (let i = 0; i < count; i++) {
        const entry = first + 2 + i * 12;

        if (entry + 12 > tiff.length) {
            return undefined;
        }

        if (view.getUint16(entry, little) === 0x0112) {
            const value = view.getUint16(entry + 8, little);

            return value >= 1 && value <= 8 ? value : undefined;
        }
    }

    return undefined;
}

/** An APP1 Exif segment with the orientation alone. */
function orientationSegment(orientation: number): Uint8Array {
    // "Exif\0\0", then TIFF: big-endian header, IFD0 at 8 with one entry (0x0112, SHORT, 1, value), no next IFD.
    const tiff = [0x4d, 0x4d, 0x00, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0];
    const body = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const length = body.length + 2;

    return new Uint8Array([0xff, 0xe1, length >> 8, length & 0xff, ...body]);
}

/** WebP: no EXIF or XMP chunks, and VP8X no longer says it has them. */
function webp(bytes: Uint8Array): Uint8Array {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const parts: Uint8Array[] = [];

    for (let at = 12; at < bytes.length; ) {
        need(bytes, at + 8);
        const type = String.fromCharCode(...bytes.subarray(at, at + 4));
        const size = view.getUint32(at + 4, true);
        const end = at + 8 + size + (size % 2);

        need(bytes, Math.min(end, bytes.length));

        if (type === "VP8X") {
            const chunk = bytes.slice(at, Math.min(end, bytes.length));

            // Flags: 0x08 EXIF, 0x04 XMP.
            chunk[8] = chunk[8]! & ~0x0c;
            parts.push(chunk);
        } else if (type !== "EXIF" && type !== "XMP ") {
            parts.push(bytes.subarray(at, Math.min(end, bytes.length)));
        }

        at = end;
    }

    const body = concat(parts);
    const head = new Uint8Array(12);

    head.set(bytes.subarray(0, 12));
    new DataView(head.buffer).setUint32(4, body.length + 4, true);

    return concat([head, body]);
}

/** GIF: no comments, and no application blocks but the ones that make it loop. */
function gif(bytes: Uint8Array): Uint8Array {
    const KEEP_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0"]);
    need(bytes, 13);
    const flags = bytes[10]!;
    let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
    const parts = [bytes.subarray(0, at)];
    // Past a run of sub-blocks (each a length, then that many bytes; 0 ends them).
    const blocks = (from: number) => {
        let i = from;

        for (;;) {
            need(bytes, i + 1);
            const size = bytes[i]!;

            i += 1 + size;

            if (size === 0) {
                return i;
            }
        }
    };

    while (at < bytes.length) {
        const kind = bytes[at]!;

        if (kind === 0x3b) {
            parts.push(bytes.subarray(at, at + 1));
            break;
        }

        if (kind === 0x2c) {
            need(bytes, at + 10);
            const local = bytes[at + 9]!;
            const data = at + 10 + (local & 0x80 ? 3 * 2 ** ((local & 0x07) + 1) : 0) + 1;
            const end = blocks(data);

            parts.push(bytes.subarray(at, end));
            at = end;
            continue;
        }

        if (kind === 0x21) {
            need(bytes, at + 2);
            const label = bytes[at + 1]!;
            const end = blocks(at + 2);
            const app = label === 0xff ? String.fromCharCode(...bytes.subarray(at + 3, at + 14)) : "";

            if (label !== 0xfe && (label !== 0xff || KEEP_APPS.has(app))) {
                parts.push(bytes.subarray(at, end));
            }

            at = end;
            continue;
        }

        throw new Error(`an unknown block (${kind})`);
    }

    return concat(parts);
}
