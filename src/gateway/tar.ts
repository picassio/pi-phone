/**
 * A tar archive written as a stream (ustar, as tar and Docker read it), for the server backup (PP-35): files whose size is
 * known before they are written, each a buffer or a file on disk.
 */
import { createReadStream } from "node:fs";

export type TarEntry = { name: string; size: number; mtime?: number } & ({ data: Buffer } | { file: string });

/** A ustar header for one regular file. Names are short ASCII paths here (at most 99 bytes). */
export function tarHeader(name: string, size: number, mtime = Date.now()): Buffer {
    if (Buffer.byteLength(name) > 99) {
        throw new Error(`A name in the archive is at most 99 bytes: ${name}`);
    }

    const header = Buffer.alloc(512, 0);
    const put = (text: string, offset: number, length: number) => header.write(text, offset, length, "ascii");
    const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, "0");

    put(name, 0, 100);
    put(octal(0o644, 8), 100, 8);
    put(octal(0, 8), 108, 8);
    put(octal(0, 8), 116, 8);
    put(octal(size, 12), 124, 12);
    put(octal(Math.floor(mtime / 1000), 12), 136, 12);
    put("        ", 148, 8);
    put("0", 156, 1);
    put("ustar\u000000", 257, 8);

    let sum = 0;

    for (const byte of header) {
        sum += byte;
    }

    put(`${octal(sum, 7)}\u0000 `, 148, 8);

    return header;
}

/** The archive's bytes, entry by entry, then the two empty blocks that end it. */
export async function* tarStream(entries: Iterable<TarEntry>): AsyncGenerator<Buffer> {
    for (const entry of entries) {
        yield tarHeader(entry.name, entry.size, entry.mtime);

        if ("data" in entry) {
            yield entry.data;
        } else {
            for await (const chunk of createReadStream(entry.file)) {
                yield chunk as Buffer;
            }
        }

        const pad = (512 - (entry.size % 512)) % 512;

        if (pad > 0) {
            yield Buffer.alloc(pad, 0);
        }
    }

    yield Buffer.alloc(1024, 0);
}
