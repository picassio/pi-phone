/**
 * Session files read a line at a time, never whole (PP-486, from pi-pocket #261): Pi's and Claude Code's sessions are
 * JSONL files that grow to hundreds of megabytes (images, tool output), and the phone must not hold one. A file is a
 * `ByteSource`, read in chunks by position: one on this phone, or one on a machine read over its connection (pi-env's
 * `openBinaryReader`), so a machine's file is read where it is.
 */
import type { Context } from "@earendil-works/chord";
import { open } from "node:fs/promises";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

/** How much of a file is read at a time. */
export const CHUNK = 1024 * 1024;

/** A file read by position. */
export type ByteSource = {
    readonly size: number;
    /** Up to `length` bytes at `offset`; fewer only at the end. */
    read(offset: number, length: number): Promise<Buffer>;
    close(): Promise<void>;
};

/** A file on this phone. */
export async function localSource(path: string): Promise<ByteSource> {
    const handle = await open(path, "r");
    const { size } = await handle.stat().catch(async (error: unknown) => {
        await handle.close();
        throw error;
    });

    return {
        size,
        read: async (offset, length) => {
            const bytes = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(bytes, 0, length, offset);

            return bytes.subarray(0, bytesRead);
        },
        close: () => handle.close(),
    };
}

/** A file in an execution environment: a machine's, read over its connection. `failed` words its errors. */
export async function envSource(
    env: ExecutionEnv,
    path: string,
    context: Context,
    failed: (message: string) => Error,
): Promise<ByteSource> {
    const opened = await env.openBinaryReader(path, undefined, context);

    if (!opened.ok) {
        throw failed(opened.error.message);
    }

    const reader = opened.value;
    const info = await reader.info(context);

    if (!info.ok) {
        await reader.close(context);
        throw failed(info.error.message);
    }

    return {
        size: info.value.size,
        read: async (offset, length) => {
            const bytes = await reader.read(offset, length, context);

            if (!bytes.ok) {
                throw failed(bytes.error.message);
            }

            return Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength);
        },
        close: () => reader.close(context),
    };
}

/**
 * Lines read again by where they are, found by a first read: a megabyte of the file is held for the lines in it, as
 * the lines asked for mostly follow each other.
 */
export class LineReader {
    readonly #source: ByteSource;
    #held: { at: number; bytes: Buffer } = { at: 0, bytes: Buffer.alloc(0) };

    constructor(source: ByteSource) {
        this.#source = source;
    }

    /** The line at `at`, `size` bytes long; undefined when the file is shorter now. */
    async line(at: number, size: number): Promise<Buffer | undefined> {
        const held = this.#held;

        if (at < held.at || at + size > held.at + held.bytes.length) {
            this.#held = { at, bytes: await this.#source.read(at, Math.max(size, CHUNK)) };
        }

        const start = at - this.#held.at;
        const line = this.#held.bytes.subarray(start, start + size);

        return line.length === size ? line : undefined;
    }

    /** Let the held part go. */
    release(): void {
        this.#held = { at: 0, bytes: Buffer.alloc(0) };
    }
}

/** A line of a file: where it starts, and its bytes without the newline. */
export type Line = { at: number; bytes: Buffer };

/**
 * A file's lines from `from` (a line's start) to its end, in order, read a chunk at a time. Only the line being read is
 * held, so a file of any size is read in the memory of its longest line. A last line without a newline is a line too.
 */
export async function* linesOf(source: ByteSource, from = 0): AsyncGenerator<Line> {
    let position = from;
    let start = from;
    // The line read so far, from earlier chunks.
    let rest: Buffer[] = [];

    while (position < source.size) {
        const chunk = await source.read(position, Math.min(CHUNK, source.size - position));

        if (chunk.length === 0) {
            break;
        }

        let begin = 0;

        for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, begin)) {
            const part = chunk.subarray(begin, end);

            yield { at: start, bytes: rest.length === 0 ? part : Buffer.concat([...rest, part]) };
            rest = [];
            start = position + end + 1;
            begin = end + 1;
        }

        // A copy: the chunk's buffer is not kept for a line that goes on.
        rest.push(Buffer.from(chunk.subarray(begin)));
        position += chunk.length;
    }

    const last = Buffer.concat(rest);

    if (last.length > 0) {
        yield { at: start, bytes: last };
    }
}

/**
 * A file's lines from its end, last first, read a chunk at a time: a preview needs only the last few messages, so a
 * big file is not read whole for them. A line is decoded once whole, so a character split between chunks stays whole.
 */
export async function* linesFromEnd(source: ByteSource): AsyncGenerator<string> {
    let position = source.size;
    // The bytes of the line being read, from its first chunk read so far to its end.
    let rest: Buffer[] = [];

    while (position > 0) {
        const size = Math.min(CHUNK, position);

        position -= size;
        const part = await source.read(position, size);
        let end = part.length;

        while (end > 0) {
            const at = part.lastIndexOf(10, end - 1);

            if (at === -1) {
                break;
            }

            yield Buffer.concat([part.subarray(at + 1, end), ...rest]).toString("utf8");
            rest = [];
            end = at;
        }

        rest.unshift(Buffer.from(part.subarray(0, end)));
    }

    yield Buffer.concat(rest).toString("utf8");
}

/** A line as JSON, or undefined when it is blank or not JSON (a last line cut off while it is written). */
export function parseLine(bytes: Buffer | string): unknown {
    const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");

    if (text.trim() === "") {
        return undefined;
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}
