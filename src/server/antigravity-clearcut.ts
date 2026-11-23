/**
 * Antigravity Clearcut telemetry (PP-559): sends usage events to `play.googleapis.com/log` as agy does, using the same
 * binary protobuf schema (wireless_android_play_playlog). Reverse-engineered from agy 1.5.15 binary on 2026-11-23.
 *
 * Clearcut uses HTTP/2 with binary protobuf (application/octet-stream). This module sends requests through the Go proxy
 * (`native/agy-tls`) with `X-Agy-Proto: h2` to use Go's HTTP/2 client, matching agy's TLS fingerprint exactly.
 *
 * Schema (from strings analysis of agy binary):
 * - LogRequest: client_info (1), log_source (2), log_events (3), request_time_ms (4)
 * - LogEvent: event_time_ms (1), source_extension (6), event_code (11)
 * - ClientInfo: client_type (1), desktop_client_info (3), client_version (8)
 * - DesktopClientInfo: os (1), arch (2)
 */
import { randomUUID } from "node:crypto";
import { AGY_VERSION, AGY_BUILD } from "./antigravity.ts";
import type { WireRequest, WireResponse } from "./agy-wire.ts";

const CLEARCUT_URL = "https://play.googleapis.com/log";

/**
 * agy's log source ID. Found in binary as part of LogSourceEnum from wireless_android_play_playlog.
 * This identifies the client application sending telemetry.
 */
const AGY_LOG_SOURCE = 1673;

// ============================================================================
// Protobuf encoding helpers (wire format)
// ============================================================================

/** Encode a number as a protobuf varint. */
function varint(n: number | bigint): Buffer {
    const out: number[] = [];
    let v = typeof n === "bigint" ? n : BigInt(n);
    if (v < 0n) v = 0n;
    do {
        let byte = Number(v & 0x7fn);
        v >>= 7n;
        if (v > 0n) byte |= 0x80;
        out.push(byte);
    } while (v > 0n);
    if (out.length === 0) out.push(0);
    return Buffer.from(out);
}

/** Encode a protobuf field with tag and wire type. */
function field(fieldNumber: number, wireType: number, value: Buffer): Buffer {
    const tag = varint((fieldNumber << 3) | wireType);
    if (wireType === 2) {
        return Buffer.concat([tag, varint(value.length), value]);
    }
    return Buffer.concat([tag, value]);
}

function stringField(fieldNumber: number, value: string): Buffer {
    return field(fieldNumber, 2, Buffer.from(value, "utf8"));
}

function varintField(fieldNumber: number, value: number | bigint): Buffer {
    return field(fieldNumber, 0, varint(value));
}

function bytesField(fieldNumber: number, value: Buffer): Buffer {
    return field(fieldNumber, 2, value);
}

function messageField(fieldNumber: number, value: Buffer): Buffer {
    return field(fieldNumber, 2, value);
}

// ============================================================================
// Clearcut protobuf messages
// ============================================================================

export interface ClearcutEvent {
    eventTimeMs: number;
    eventCode?: number;
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

    if (clientInfo) {
        const clientParts: Buffer[] = [];
        clientParts.push(varintField(1, clientInfo.clientType));
        const desktopParts: Buffer[] = [];
        desktopParts.push(stringField(1, clientInfo.osType));
        desktopParts.push(stringField(2, clientInfo.arch));
        clientParts.push(messageField(3, Buffer.concat(desktopParts)));
        clientParts.push(stringField(8, clientInfo.clientVersion));
        parts.push(messageField(1, Buffer.concat(clientParts)));
    }

    parts.push(varintField(2, logSource));

    for (const event of events) {
        const eventParts: Buffer[] = [];
        eventParts.push(varintField(1, BigInt(event.eventTimeMs)));
        eventParts.push(bytesField(6, event.sourceExtension));
        if (event.eventCode !== undefined) {
            eventParts.push(varintField(11, event.eventCode));
        }
        parts.push(messageField(3, Buffer.concat(eventParts)));
    }

    parts.push(varintField(4, BigInt(requestTimeMs)));

    return Buffer.concat(parts);
}

/**
 * Build an AnalyticsEventMetadata payload for source_extension.
 */
export function buildAnalyticsPayload(
    eventName: string,
    metadata: Record<string, string | number | boolean>,
): Buffer {
    const parts: Buffer[] = [];
    parts.push(stringField(1, eventName));

    for (const [key, value] of Object.entries(metadata)) {
        const kvParts: Buffer[] = [];
        kvParts.push(stringField(1, key));
        if (typeof value === "string") {
            kvParts.push(stringField(2, value));
        } else if (typeof value === "number") {
            kvParts.push(varintField(3, Math.floor(value)));
        } else if (typeof value === "boolean") {
            kvParts.push(varintField(4, value ? 1 : 0));
        }
        parts.push(messageField(2, Buffer.concat(kvParts)));
    }

    return Buffer.concat(parts);
}

// ============================================================================
// Clearcut client using Go proxy
// ============================================================================

/** The transport through Go's TLS (agy-tls-proxy.ts gives this). */
export type ClearcutSend = (url: string, init: WireRequest) => Promise<WireResponse>;

export interface ClearcutOptions {
    /** The Go proxy transport (from AgyRuntime.send). */
    send: ClearcutSend;
    /** Get the current auth token, or undefined if not signed in. */
    auth: () => Promise<{ token: string } | undefined>;
    /** Platform info for client_info. */
    platform?: { osType: string; arch: string };
    /** Log function for debugging. */
    log?: (line: string) => void;
}

/**
 * Clearcut telemetry client for Antigravity, using Go's HTTP/2 through the agy-tls proxy.
 */
export class ClearcutClient {
    readonly #options: ClearcutOptions;
    readonly #log: (line: string) => void;
    readonly #platform: { osType: string; arch: string };
    #sessionId: string;
    #startTime: number;
    #eventCount = 0;
    #closed = false;

    constructor(options: ClearcutOptions) {
        this.#options = options;
        this.#log = options.log ?? (() => {});
        this.#platform = options.platform ?? { osType: "linux", arch: "amd64" };
        this.#sessionId = randomUUID();
        this.#startTime = Date.now();
    }

    /** Send a LogRequest to Clearcut through Go proxy. Fire-and-forget with error logging. */
    async send(events: ClearcutEvent[], clientInfo?: ClearcutClientInfo): Promise<void> {
        if (this.#closed) return;

        const cred = await this.#options.auth();
        if (!cred) {
            this.#log("clearcut: not signed in, skipping");
            return;
        }

        const body = buildLogRequest(AGY_LOG_SOURCE, Date.now(), events, clientInfo);

        try {
            const response = await this.#options.send(CLEARCUT_URL, {
                body: body.toString("binary"),
                headers: {
                    "Content-Type": "application/octet-stream",
                    "User-Agent": "Go-http-client/2.0",
                    "Authorization": `Bearer ${cred.token}`,
                    "X-Agy-Proto": "h2", // Tell Go proxy to use HTTP/2
                },
            });

            if (response.status !== 200) {
                this.#log(`clearcut: status ${response.status}`);
            } else {
                this.#eventCount += events.length;
            }
        } catch (err) {
            this.#log(`clearcut: request error: ${err instanceof Error ? err.message : err}`);
        }
    }

    /** Send a session_start event. */
    async sendSessionStart(): Promise<void> {
        const payload = buildAnalyticsPayload("session_start", {
            session_id: this.#sessionId,
            version: AGY_VERSION,
            build: AGY_BUILD,
            os_type: this.#platform.osType,
            arch: this.#platform.arch,
            timestamp_ms: Date.now(),
        });

        const clientInfo: ClearcutClientInfo = {
            clientType: 3,
            clientVersion: AGY_VERSION,
            osType: this.#platform.osType,
            arch: this.#platform.arch,
        };

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }], clientInfo);
        this.#log("clearcut: session_start sent");
    }

    /** Send a model_call event. */
    async sendModelCall(
        model: string,
        inputTokens: number,
        outputTokens: number,
        latencyMs: number,
    ): Promise<void> {
        const payload = buildAnalyticsPayload("model_call", {
            session_id: this.#sessionId,
            model,
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            latency_ms: latencyMs,
            timestamp_ms: Date.now(),
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
    }

    /** Send a tool_use event. */
    async sendToolUse(toolName: string, success: boolean, latencyMs: number): Promise<void> {
        const payload = buildAnalyticsPayload("tool_use", {
            session_id: this.#sessionId,
            tool_name: toolName,
            success,
            latency_ms: latencyMs,
            timestamp_ms: Date.now(),
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
    }

    /** Send a session_end event. */
    async sendSessionEnd(): Promise<void> {
        const durationMs = Date.now() - this.#startTime;
        const payload = buildAnalyticsPayload("session_end", {
            session_id: this.#sessionId,
            duration_ms: durationMs,
            event_count: this.#eventCount,
            timestamp_ms: Date.now(),
        });

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }]);
        this.#log(`clearcut: session_end sent (${this.#eventCount} events, ${durationMs}ms)`);
    }

    /** Mark as closed - no more sends. */
    close(): void {
        this.#closed = true;
    }
}
