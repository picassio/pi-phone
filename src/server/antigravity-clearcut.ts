/**
 * Antigravity Clearcut telemetry (PP-559): sends usage events to `play.googleapis.com/log` as agy does, using the same
 * binary protobuf schema (wireless_android_play_playlog). Reverse-engineered from agy 1.5.15 binary on 2026-11-23.
 *
 * Clearcut uses HTTP/2 with binary protobuf (application/octet-stream). agy sends ~10 requests per session:
 * - On start: client info, session start
 * - During use: model calls, tool use, errors
 * - On end: session end, usage summary
 *
 * Schema (from strings analysis):
 * - LogRequest: log_source (field 2), log_events (field 3), request_time_ms (field 4), client_info (field 1)
 * - LogEvent: event_time_ms (field 1), source_extension (field 6, bytes payload)
 * - ClientInfo: client_type (field 1), desktop_client_info (field 3), client_version (field 8)
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { AGY_VERSION, AGY_BUILD } from "./antigravity.ts";

const CLEARCUT_HOST = "play.googleapis.com";
const CLEARCUT_PATH = "/log";

/** agy's log source ID (from wireless_android_play_playlog.LogSourceEnum). */
const AGY_LOG_SOURCE = 1673; // Codeium/Antigravity log source

/** Protobuf encoding helpers. */
function varint(n: number | bigint): Buffer {
    const out: number[] = [];
    let v = typeof n === "bigint" ? n : BigInt(n);
    while (v > 0x7fn) {
        out.push(Number(v & 0x7fn) | 0x80);
        v >>= 7n;
    }
    out.push(Number(v));
    return Buffer.from(out);
}

function field(number: number, wireType: number, value: Buffer): Buffer {
    const tag = varint((number << 3) | wireType);
    if (wireType === 2) {
        // Length-delimited
        return Buffer.concat([tag, varint(value.length), value]);
    }
    return Buffer.concat([tag, value]);
}

function stringField(number: number, value: string): Buffer {
    return field(number, 2, Buffer.from(value, "utf8"));
}

function varintField(number: number, value: number | bigint): Buffer {
    return field(number, 0, varint(value));
}

function bytesField(number: number, value: Buffer): Buffer {
    return field(number, 2, value);
}

function messageField(number: number, value: Buffer): Buffer {
    return field(number, 2, value);
}

export interface ClearcutEvent {
    eventTimeMs: number;
    eventCode?: number;
    /** The source_extension payload (already encoded as bytes). */
    sourceExtension: Buffer;
}

export interface ClearcutClientInfo {
    clientType: number;
    clientVersion: string;
    osType: string;
    arch: string;
}

/**
 * Build a LogRequest protobuf message.
 */
export function buildLogRequest(
    logSource: number,
    requestTimeMs: number,
    events: ClearcutEvent[],
    clientInfo?: ClearcutClientInfo,
): Buffer {
    const parts: Buffer[] = [];

    // Field 2: log_source (varint)
    parts.push(varintField(2, logSource));

    // Field 4: request_time_ms (varint)
    parts.push(varintField(4, BigInt(requestTimeMs)));

    // Field 3: log_events (repeated message)
    for (const event of events) {
        const eventParts: Buffer[] = [];
        // Field 1: event_time_ms
        eventParts.push(varintField(1, BigInt(event.eventTimeMs)));
        // Field 6: source_extension
        eventParts.push(bytesField(6, event.sourceExtension));
        // Field 11: event_code (optional)
        if (event.eventCode !== undefined) {
            eventParts.push(varintField(11, event.eventCode));
        }
        parts.push(messageField(3, Buffer.concat(eventParts)));
    }

    // Field 1: client_info (optional)
    if (clientInfo) {
        const clientParts: Buffer[] = [];
        // Field 1: client_type
        clientParts.push(varintField(1, clientInfo.clientType));
        // Field 8: client_version
        clientParts.push(stringField(8, clientInfo.clientVersion));
        // Field 3: desktop_client_info (nested)
        const desktopParts: Buffer[] = [];
        desktopParts.push(stringField(1, clientInfo.osType)); // os
        desktopParts.push(stringField(2, clientInfo.arch)); // arch
        clientParts.push(messageField(3, Buffer.concat(desktopParts)));
        parts.push(messageField(1, Buffer.concat(clientParts)));
    }

    return Buffer.concat(parts);
}

/**
 * Build an AnalyticsEventMetadata payload for source_extension.
 * This is what agy sends for most events.
 */
export function buildAnalyticsPayload(
    eventName: string,
    metadata: Record<string, string | number | boolean>,
): Buffer {
    const parts: Buffer[] = [];
    // Field 1: event_name
    parts.push(stringField(1, eventName));
    // Field 2: metadata (as repeated key-value pairs)
    for (const [key, value] of Object.entries(metadata)) {
        const kvParts: Buffer[] = [];
        kvParts.push(stringField(1, key));
        if (typeof value === "string") {
            kvParts.push(stringField(2, value));
        } else if (typeof value === "number") {
            kvParts.push(varintField(3, value));
        } else if (typeof value === "boolean") {
            kvParts.push(varintField(4, value ? 1 : 0));
        }
        parts.push(messageField(2, Buffer.concat(kvParts)));
    }
    return Buffer.concat(parts);
}

export interface ClearcutOptions {
    auth: () => Promise<{ token: string } | undefined>;
    platform?: { osType: string; arch: string };
    log?: (line: string) => void;
}

/**
 * Clearcut telemetry client for Antigravity.
 */
export class ClearcutClient {
    readonly #options: ClearcutOptions;
    readonly #log: (line: string) => void;
    #session: http2.ClientHttp2Session | undefined;
    #sessionId: string;
    #startTime: number;
    #eventCount = 0;

    constructor(options: ClearcutOptions) {
        this.#options = options;
        this.#log = options.log ?? (() => {});
        this.#sessionId = randomUUID();
        this.#startTime = Date.now();
    }

    /** Get or create HTTP/2 session. */
    #getSession(): http2.ClientHttp2Session {
        if (this.#session && !this.#session.closed && !this.#session.destroyed) {
            return this.#session;
        }
        this.#session = http2.connect(`https://${CLEARCUT_HOST}`, {
            ALPNProtocols: ["h2"],
        });
        this.#session.on("error", (err) => this.#log(`clearcut h2 error: ${err}`));
        return this.#session;
    }

    /** Send a LogRequest to Clearcut. */
    async send(events: ClearcutEvent[], clientInfo?: ClearcutClientInfo): Promise<void> {
        const cred = await this.#options.auth();
        if (!cred) {
            this.#log("clearcut: not signed in, skipping");
            return;
        }

        const body = buildLogRequest(AGY_LOG_SOURCE, Date.now(), events, clientInfo);

        const session = this.#getSession();
        const req = session.request({
            ":method": "POST",
            ":path": CLEARCUT_PATH,
            "content-type": "application/octet-stream",
            "content-length": body.length.toString(),
            "user-agent": "Go-http-client/2.0",
            "accept-encoding": "gzip",
        });

        return new Promise((resolve, reject) => {
            req.on("response", (headers) => {
                const status = headers[":status"];
                if (status !== 200) {
                    this.#log(`clearcut: status ${status}`);
                }
            });
            req.on("data", () => {
                // Ignore response body
            });
            req.on("end", () => {
                this.#eventCount += events.length;
                resolve();
            });
            req.on("error", reject);
            req.end(body);
        });
    }

    /** Send a session start event. */
    async sendSessionStart(): Promise<void> {
        const platform = this.#options.platform ?? { osType: "linux", arch: "amd64" };
        const payload = buildAnalyticsPayload("session_start", {
            session_id: this.#sessionId,
            version: AGY_VERSION,
            build: AGY_BUILD,
            os_type: platform.osType,
            arch: platform.arch,
        });

        const clientInfo: ClearcutClientInfo = {
            clientType: 3, // Desktop
            clientVersion: AGY_VERSION,
            osType: platform.osType,
            arch: platform.arch,
        };

        await this.send(
            [{ eventTimeMs: Date.now(), sourceExtension: payload }],
            clientInfo,
        );
    }

    /** Send a model call event. */
    async sendModelCall(model: string, inputTokens: number, outputTokens: number, latencyMs: number): Promise<void> {
        const payload = buildAnalyticsPayload("model_call", {
            session_id: this.#sessionId,
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
    }

    /** Send a tool use event. */
    async sendToolUse(toolName: string, success: boolean, latencyMs: number): Promise<void> {
        const payload = buildAnalyticsPayload("tool_use", {
            session_id: this.#sessionId,
            tool_name: toolName,
            success,
            latency_ms: latencyMs,
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
    }

    /** Send a session end event. */
    async sendSessionEnd(): Promise<void> {
        const durationMs = Date.now() - this.#startTime;
        const payload = buildAnalyticsPayload("session_end", {
            session_id: this.#sessionId,
            duration_ms: durationMs,
            event_count: this.#eventCount,
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
    }

    /** Close the HTTP/2 session. */
    close(): void {
        this.#session?.close();
        this.#session = undefined;
    }
}
