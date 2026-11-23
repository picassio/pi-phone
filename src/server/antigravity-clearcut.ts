/**
 * Antigravity Clearcut telemetry (PP-559): sends usage events to `play.googleapis.com/log` as agy does, using the same
 * binary protobuf schema (wireless_android_play_playlog). Reverse-engineered from agy 1.5.15 binary on 2026-11-23.
 *
 * Clearcut uses HTTP/2 with binary protobuf (application/octet-stream). agy sends events for:
 * - Session lifecycle: start, end
 * - Model usage: calls, tokens, latency
 * - Tool usage: name, success, latency
 *
 * Note: This uses Node.js HTTP/2 directly. The TLS fingerprint differs from agy's Go client, but Clearcut is a
 * telemetry endpoint that likely accepts any valid TLS connection. If Google rejects based on fingerprint, we can
 * add HTTP/2 support to the Go proxy later.
 *
 * Schema (from strings analysis of agy binary):
 * - LogRequest: client_info (1), log_source (2), log_events (3), request_time_ms (4)
 * - LogEvent: event_time_ms (1), source_extension (6), event_code (11)
 * - ClientInfo: client_type (1), desktop_client_info (3), client_version (8)
 * - DesktopClientInfo: os (1), arch (2)
 */
import http2 from "node:http2";
import { randomUUID } from "node:crypto";
import { AGY_VERSION, AGY_BUILD } from "./antigravity.ts";

const CLEARCUT_HOST = "play.googleapis.com";
const CLEARCUT_PATH = "/log";

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
    if (v < 0n) v = 0n; // Clearcut doesn't use negative numbers
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
        // Length-delimited: tag + length + value
        return Buffer.concat([tag, varint(value.length), value]);
    }
    // Varint: tag + value
    return Buffer.concat([tag, value]);
}

/** Encode a string field (wire type 2). */
function stringField(fieldNumber: number, value: string): Buffer {
    return field(fieldNumber, 2, Buffer.from(value, "utf8"));
}

/** Encode a varint field (wire type 0). */
function varintField(fieldNumber: number, value: number | bigint): Buffer {
    return field(fieldNumber, 0, varint(value));
}

/** Encode a bytes field (wire type 2). */
function bytesField(fieldNumber: number, value: Buffer): Buffer {
    return field(fieldNumber, 2, value);
}

/** Encode a nested message field (wire type 2). */
function messageField(fieldNumber: number, value: Buffer): Buffer {
    return field(fieldNumber, 2, value);
}

// ============================================================================
// Clearcut protobuf messages
// ============================================================================

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
 *
 * Message LogRequest {
 *   ClientInfo client_info = 1;
 *   int32 log_source = 2;
 *   repeated LogEvent log_events = 3;
 *   int64 request_time_ms = 4;
 * }
 */
export function buildLogRequest(
    logSource: number,
    requestTimeMs: number,
    events: ClearcutEvent[],
    clientInfo?: ClearcutClientInfo,
): Buffer {
    const parts: Buffer[] = [];

    // Field 1: client_info (optional, but agy sends it on session_start)
    if (clientInfo) {
        const clientParts: Buffer[] = [];
        // Field 1: client_type (3 = DESKTOP)
        clientParts.push(varintField(1, clientInfo.clientType));
        // Field 3: desktop_client_info
        const desktopParts: Buffer[] = [];
        desktopParts.push(stringField(1, clientInfo.osType)); // os
        desktopParts.push(stringField(2, clientInfo.arch)); // arch
        clientParts.push(messageField(3, Buffer.concat(desktopParts)));
        // Field 8: client_version
        clientParts.push(stringField(8, clientInfo.clientVersion));
        parts.push(messageField(1, Buffer.concat(clientParts)));
    }

    // Field 2: log_source
    parts.push(varintField(2, logSource));

    // Field 3: log_events (repeated)
    for (const event of events) {
        const eventParts: Buffer[] = [];
        // Field 1: event_time_ms
        eventParts.push(varintField(1, BigInt(event.eventTimeMs)));
        // Field 6: source_extension (the actual payload)
        eventParts.push(bytesField(6, event.sourceExtension));
        // Field 11: event_code (optional)
        if (event.eventCode !== undefined) {
            eventParts.push(varintField(11, event.eventCode));
        }
        parts.push(messageField(3, Buffer.concat(eventParts)));
    }

    // Field 4: request_time_ms
    parts.push(varintField(4, BigInt(requestTimeMs)));

    return Buffer.concat(parts);
}

/**
 * Build an AnalyticsEventMetadata payload for source_extension.
 *
 * Message AnalyticsEventMetadata {
 *   string event_name = 1;
 *   repeated KeyValue metadata = 2;
 * }
 *
 * Message KeyValue {
 *   string key = 1;
 *   string string_value = 2;
 *   int64 int_value = 3;
 *   bool bool_value = 4;
 * }
 */
export function buildAnalyticsPayload(
    eventName: string,
    metadata: Record<string, string | number | boolean>,
): Buffer {
    const parts: Buffer[] = [];

    // Field 1: event_name
    parts.push(stringField(1, eventName));

    // Field 2: metadata (repeated key-value pairs)
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
// Clearcut client
// ============================================================================

export interface ClearcutOptions {
    /** Get the current auth token, or undefined if not signed in. */
    auth: () => Promise<{ token: string } | undefined>;
    /** Platform info for client_info. */
    platform?: { osType: string; arch: string };
    /** Log function for debugging. */
    log?: (line: string) => void;
}

/**
 * Clearcut telemetry client for Antigravity.
 *
 * Usage:
 *   const clearcut = new ClearcutClient({ auth: () => getToken() });
 *   await clearcut.sendSessionStart();
 *   // ... during session ...
 *   await clearcut.sendModelCall("gemini-2.5-pro", 1000, 500, 2000);
 *   // ... on exit ...
 *   await clearcut.sendSessionEnd();
 *   clearcut.close();
 */
export class ClearcutClient {
    readonly #options: ClearcutOptions;
    readonly #log: (line: string) => void;
    readonly #platform: { osType: string; arch: string };
    #session: http2.ClientHttp2Session | undefined;
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

    /** Get or create HTTP/2 session to Clearcut. */
    #getSession(): http2.ClientHttp2Session | undefined {
        if (this.#closed) return undefined;
        if (this.#session && !this.#session.closed && !this.#session.destroyed) {
            return this.#session;
        }
        try {
            this.#session = http2.connect(`https://${CLEARCUT_HOST}`, {
                // agy uses Go's default ALPN which negotiates h2
            });
            this.#session.on("error", (err) => {
                this.#log(`clearcut: h2 error: ${err.message}`);
            });
            this.#session.on("close", () => {
                this.#session = undefined;
            });
            return this.#session;
        } catch (err) {
            this.#log(`clearcut: failed to connect: ${err}`);
            return undefined;
        }
    }

    /** Send a LogRequest to Clearcut. Fire-and-forget with error logging. */
    async send(events: ClearcutEvent[], clientInfo?: ClearcutClientInfo): Promise<void> {
        if (this.#closed) return;

        const cred = await this.#options.auth();
        if (!cred) {
            this.#log("clearcut: not signed in, skipping");
            return;
        }

        const session = this.#getSession();
        if (!session) return;

        const body = buildLogRequest(AGY_LOG_SOURCE, Date.now(), events, clientInfo);

        return new Promise((resolve) => {
            const req = session.request({
                ":method": "POST",
                ":path": CLEARCUT_PATH,
                "content-type": "application/octet-stream",
                "content-length": String(body.length),
                // agy's Go HTTP/2 client sends this User-Agent
                "user-agent": "Go-http-client/2.0",
                // Authorization with the user's token
                authorization: `Bearer ${cred.token}`,
            });

            req.on("response", (headers) => {
                const status = headers[":status"];
                if (status !== 200) {
                    this.#log(`clearcut: status ${status}`);
                }
            });

            req.on("data", () => {
                // Ignore response body (LogResponse)
            });

            req.on("end", () => {
                this.#eventCount += events.length;
                resolve();
            });

            req.on("error", (err) => {
                this.#log(`clearcut: request error: ${err.message}`);
                resolve(); // Don't fail the caller
            });

            req.end(body);
        });
    }

    /** Send a session_start event. Called once when Antigravity initializes. */
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
            clientType: 3, // DESKTOP
            clientVersion: AGY_VERSION,
            osType: this.#platform.osType,
            arch: this.#platform.arch,
        };

        await this.send([{ eventTimeMs: Date.now(), sourceExtension: payload }], clientInfo);
        this.#log("clearcut: session_start sent");
    }

    /** Send a model_call event after each API call. */
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

    /** Send a tool_use event after each tool execution. */
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

    /** Send a session_end event. Called when the app shuts down. */
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

    /** Close the HTTP/2 session. */
    close(): void {
        this.#closed = true;
        if (this.#session) {
            this.#session.close();
            this.#session = undefined;
        }
    }
}
