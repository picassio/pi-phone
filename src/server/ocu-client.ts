/**
 * One `ocu mcp` (open-computer-use's MCP server, PP-178) for a computer control session: JSON-RPC lines over its stdin
 * and stdout, here through the app's ssh to the machine (`computer-control.ts` gives the process). ocu keeps each app's
 * last read (its element numbers) in its own memory, so a session keeps one process from its start to its end, and its
 * calls go one at a time, in order.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/** What `ocu mcp` runs as: a child process here (ssh to the machine, or a stand-in in tests). */
export type OcuProcess = {
    stdin: Writable;
    stdout: Readable;
    stderr: Readable;
    kill(signal?: NodeJS.Signals): boolean;
    once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    once(event: "error", listener: (error: Error) => void): unknown;
};

/** One item of a tool's result: text, or a picture (PNG, base64). */
export type OcuContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export type OcuResult = { content: OcuContent[]; isError: boolean };

/** How long one call may take: ocu's own runtime gives up after 30 s. */
const CALL_MS = 45_000;
/** How long the handshake may take: ssh logs in first. */
const START_MS = 30_000;

export class OcuClient {
    readonly #process: OcuProcess;
    readonly #waiting = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    #next = 0;
    #queue: Promise<unknown> = Promise.resolve();
    /** Why it ended, once it did. */
    #ended: string | undefined;
    #said = "";

    constructor(process: OcuProcess, onEnd: (why: string) => void = () => {}) {
        this.#process = process;
        process.stderr.on("data", (chunk: Buffer) => {
            this.#said = (this.#said + chunk.toString()).slice(-2000);
        });
        createInterface({ input: process.stdout }).on("line", (line) => {
            let message: { id?: number; result?: Record<string, unknown>; error?: { message?: string } };

            try {
                message = JSON.parse(line) as typeof message;
            } catch {
                return;
            }

            const waiting = message.id === undefined ? undefined : this.#waiting.get(message.id);

            if (waiting === undefined) {
                return;
            }

            this.#waiting.delete(message.id!);
            clearTimeout(waiting.timer);

            if (message.error !== undefined) {
                waiting.reject(new Error(`ocu: ${message.error.message ?? "an error"}`));
            } else {
                waiting.resolve(message.result ?? {});
            }
        });
        const end = (why: string) => {
            if (this.#ended !== undefined) {
                return;
            }

            this.#ended = why;

            for (const [id, waiting] of this.#waiting) {
                this.#waiting.delete(id);
                clearTimeout(waiting.timer);
                waiting.reject(new Error(why));
            }

            onEnd(why);
        };

        process.once("exit", (code, signal) => {
            const last = this.#said.trim().split("\n").at(-1);

            end(`ocu ended${last ? `: ${last}` : signal === null ? ` (exit ${code})` : ` (${signal})`}`);
        });
        process.once("error", (error) => end(`ocu could not start: ${error.message}`));
    }

    /** Why it ended, or undefined while it runs. */
    get ended(): string | undefined {
        return this.#ended;
    }

    #request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
        if (this.#ended !== undefined) {
            return Promise.reject(new Error(this.#ended));
        }

        const id = ++this.#next;

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.#waiting.delete(id);
                reject(new Error(`ocu did not answer ${method} in ${Math.round(timeoutMs / 1000)} s.`));
            }, timeoutMs);

            this.#waiting.set(id, { resolve, reject, timer });
            this.#process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
        });
    }

    /** The handshake: ocu's name and version. */
    async start(): Promise<{ name: string; version: string }> {
        const answer = await this.#request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pi-phone", version: "1" } }, START_MS);

        this.#process.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

        const info = (answer.serverInfo ?? {}) as { name?: string; version?: string };

        return { name: String(info.name ?? "ocu"), version: String(info.version ?? "") };
    }

    /** One tool call, after the ones before it: ocu answers a call at a time. */
    call(name: string, args: Record<string, unknown>, timeoutMs = CALL_MS): Promise<OcuResult> {
        const run = this.#queue.then(async () => {
            const result = await this.#request("tools/call", { name, arguments: args }, timeoutMs);

            return { content: (result.content ?? []) as OcuContent[], isError: result.isError === true };
        });

        this.#queue = run.catch(() => {});

        return run;
    }

    /** Stop it: its input closes (ocu ends at the end of its input), then the process goes. */
    close(): void {
        if (this.#ended === undefined) {
            this.#process.stdin.end();
            setTimeout(() => {
                if (this.#ended === undefined) {
                    this.#process.kill();
                }
            }, 2000).unref();
        }
    }
}

/** The text items of a result, joined. */
export const textOf = (result: OcuResult): string =>
    result.content
        .filter((each): each is { type: "text"; text: string } => each.type === "text")
        .map((each) => each.text)
        .join("\n");

/** The picture of a result (PNG, base64), if it has one. */
export const imageOf = (result: OcuResult): string | undefined =>
    result.content.find((each): each is { type: "image"; data: string; mimeType: string } => each.type === "image")?.data;
