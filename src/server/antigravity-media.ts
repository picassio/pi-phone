/**
 * Antigravity's image generation and speech-to-text (PP-559, under PP-555): agy 1.5.15's media calls, through the same
 * wire as its chat (agy-wire.ts), to match its fingerprint.
 *
 * - **Image generation (`gemini-3.1-flash-image`):** `POST v1internal:generateContent` (not streamed), with
 *   `requestType: "image_gen"`, `requestId: "image_gen/<ms>/<uuid>/<step>"`, the prompt and up to 3 input images in
 *   `request.contents`, and `generationConfig.imageConfig.aspectRatio`. The answer is JPEG data in `inlineData.data`.
 * - **Speech-to-text (`proactive-observer-v10`):** bidirectional gRPC over HTTP/2 to `aicode.googleapis.com`, path
 *   `/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent`, audio in 40 ms chunks of 16 kHz PCM s16le.
 *   The transcript comes in interim updates and a final at the end of an utterance.
 *
 * The catalog (`fetchAvailableModels`) names the media models: `imageGenerationModelIds`, `audioTranscriptionModelIds`.
 * When this account has no image model (empty array), there is nothing to offer: image generation is not faked.
 */
import { randomUUID } from "node:crypto";
import http2 from "node:http2";
import { agyAgent, AGY_TLS, goHeaders, type WireRequest, type WireResponse } from "./agy-wire.ts";
import { AGY_VERSION, AGY_BUILD, type AgyCredential } from "./antigravity.ts";
export type { AgyCredential };

const HOST = "https://daily-cloudcode-pa.googleapis.com";
const GRPC_HOST = "https://aicode.googleapis.com";
const GRPC_PATH = "/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent";

/** The image model agy uses, from `fetchAvailableModels.imageGenerationModelIds`. */
export const AGY_IMAGE_MODEL = "gemini-3.1-flash-image";
/** The STT model agy uses, from `fetchAvailableModels.audioTranscriptionModelIds`. */
export const AGY_STT_MODEL = "models/proactive-observer-v10";
/** What agy sends as User-Agent on gRPC (grpc-go's version). */
export const GRPC_UA = "grpc-go/1.86.0-dev";

/** Aspects agy's image tool accepts (from its function declaration in the binary). */
export const AGY_IMAGE_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] as const;
export type AgyImageAspect = (typeof AGY_IMAGE_ASPECTS)[number];

export type AgyImageInput = { mimeType: string; data: Uint8Array };

export interface AgyImageResult {
    mimeType: string;
    data: Uint8Array;
    tokens: { input: number; output: number };
}

/** gRPC protobuf helpers (hand-written, no library). */
function varint(n: number): Buffer {
    const out: number[] = [];
    while (n > 0x7f) {
        out.push((n & 0x7f) | 0x80);
        n >>>= 7;
    }
    out.push(n);
    return Buffer.from(out);
}

function field(number: number, value: Buffer): Buffer {
    return Buffer.concat([varint((number << 3) | 2), varint(value.length), value]);
}

function flag(number: number): Buffer {
    return Buffer.concat([varint(number << 3), varint(1)]);
}

function grpcFrame(message: Buffer): Buffer {
    const head = Buffer.alloc(5);
    head.writeUInt32BE(message.length, 1);
    return Buffer.concat([head, message]);
}

function readVarint(b: Buffer, i: number): [number, number] {
    let r = 0;
    let s = 0;
    for (;;) {
        if (i >= b.length) throw new Error("short varint");
        const c = b[i++]!;
        r |= (c & 0x7f) << s;
        s += 7;
        if (c < 0x80) return [r, i];
    }
}

/** Parse a protobuf message into a tree of fields. */
function parseProto(m: Buffer): Map<number, (Buffer | number)[]> {
    const fields = new Map<number, (Buffer | number)[]>();
    let i = 0;
    while (i < m.length) {
        const [key, j] = readVarint(m, i);
        i = j;
        const f = key >> 3;
        const wire = key & 7;
        let value: Buffer | number;
        if (wire === 0) {
            const [v, k] = readVarint(m, i);
            i = k;
            value = v;
        } else if (wire === 2) {
            const [n, k] = readVarint(m, i);
            value = m.subarray(k, k + n);
            i = k + n;
        } else {
            throw new Error(`unsupported wire type ${wire}`);
        }
        const arr = fields.get(f);
        if (arr) arr.push(value);
        else fields.set(f, [value]);
    }
    return fields;
}

/** Get the first Buffer value of a field, or undefined. */
function getBytes(fields: Map<number, (Buffer | number)[]>, f: number): Buffer | undefined {
    const arr = fields.get(f);
    const v = arr?.[0];
    return v instanceof Buffer ? v : undefined;
}

/** Get the first number value of a field, or undefined. */
function getInt(fields: Map<number, (Buffer | number)[]>, f: number): number | undefined {
    const arr = fields.get(f);
    const v = arr?.[0];
    return typeof v === "number" ? v : undefined;
}

export type AgySend = (url: string, init: WireRequest) => Promise<WireResponse>;

export interface AgyMediaOptions {
    /** The signed-in credential (renewed by Pi when it ends). */
    auth: () => Promise<AgyCredential | undefined>;
    /** agy's transport (agy-wire). */
    send?: AgySend;
    log?: (line: string) => void;
}

/**
 * Generate an image with agy's image model (non-streaming `generateContent`).
 * @param prompt The prompt text.
 * @param inputs Up to 3 input images for editing (optional).
 * @param aspect The aspect ratio (default "1:1").
 */
export async function makeAgyImage(
    options: AgyMediaOptions,
    prompt: string,
    inputs: AgyImageInput[] = [],
    aspect: AgyImageAspect = "1:1",
    signal?: AbortSignal,
): Promise<AgyImageResult> {
    const auth = await options.auth();
    if (!auth) throw new Error("not signed in to Antigravity");

    const send = options.send ?? defaultSend();
    const url = `${HOST}/v1internal:generateContent`;
    const ms = Date.now();
    const requestId = `image_gen/${ms}/${randomUUID()}/2`;
    const ua = agyUserAgent(auth.osType, auth.arch, auth.authMethod);

    // Build contents: text part, then image parts
    const parts: unknown[] = [{ text: prompt }];
    for (const input of inputs.slice(0, 3)) {
        parts.push({
            inlineData: {
                mimeType: input.mimeType,
                data: Buffer.from(input.data).toString("base64"),
            },
        });
    }

    const body = JSON.stringify({
        project: auth.projectId,
        requestId,
        request: {
            contents: [{ role: "user", parts }],
            generationConfig: {
                candidateCount: 1,
                imageConfig: { aspectRatio: aspect },
            },
        },
        model: AGY_IMAGE_MODEL,
        userAgent: "antigravity",
        requestType: "image_gen",
    });

    const headers = goHeaders(url, {
        "User-Agent": ua,
        Authorization: `Bearer ${auth.access}`,
        "Content-Type": "application/json",
    }, body);

    const response = await send(url, { method: "POST", headers, body, signal });

    if (response.status !== 200) {
        const text = await collectText(response.body);
        throw new Error(`Antigravity image generation failed (${response.status}): ${text.slice(0, 500)}`);
    }

    const text = await collectText(response.body);
    const json = JSON.parse(text) as {
        response?: {
            candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[];
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
        };
    };

    const candidate = json.response?.candidates?.[0];
    const imagePart = candidate?.content?.parts?.find((p) => p.inlineData?.data);
    if (!imagePart?.inlineData) {
        throw new Error("Antigravity returned no image");
    }

    const usage = json.response?.usageMetadata;
    return {
        mimeType: imagePart.inlineData.mimeType,
        data: Buffer.from(imagePart.inlineData.data, "base64"),
        tokens: {
            input: usage?.promptTokenCount ?? 0,
            output: usage?.candidatesTokenCount ?? 0,
        },
    };
}

async function collectText(body: AsyncIterable<Uint8Array>): Promise<string> {
    const chunks: Uint8Array[] = [];
    for await (const chunk of body) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
}

function agyUserAgent(osType: string, arch: string, authMethod: string): string {
    return `antigravity/cli/${AGY_VERSION} (aidev_client; os_type=${osType}; arch=${arch}; cl=${AGY_BUILD}; auth_method=${authMethod})`;
}

let sharedAgent: ReturnType<typeof agyAgent> | undefined;

function defaultSend(): AgySend {
    return async (url, init) => {
        sharedAgent ??= agyAgent();
        const https = await import("node:https");
        return new Promise((resolve, reject) => {
            const request = https.request(url, {
                agent: sharedAgent,
                method: init.method ?? "POST",
                headers: init.headers,
                setHost: false,
                ...(init.signal ? { signal: init.signal } : {}),
            });
            request.removeHeader("Connection");
            request.on("error", reject);
            request.on("response", (response) => {
                const headers = new Headers();
                for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
                    headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
                }
                resolve({
                    status: response.statusCode ?? 0,
                    headers,
                    body: response as AsyncIterable<Uint8Array>,
                });
            });
            request.end(init.body);
        });
    };
}

/**
 * A bidirectional gRPC stream for speech-to-text with agy's dictation model.
 * Audio is sent as 40 ms chunks (1280 bytes at 16 kHz PCM s16le).
 */
export class AgyListen {
    readonly #auth: AgyCredential;
    readonly #log: (line: string) => void;
    #session: http2.ClientHttp2Session | undefined;
    #stream: http2.ClientHttp2Stream | undefined;
    #buffer = Buffer.alloc(0);
    #transcript = "";
    #final = "";
    #lastChange = 0;
    #turnComplete = false;
    #closed = false;

    constructor(auth: AgyCredential, log?: (line: string) => void) {
        this.#auth = auth;
        this.#log = log ?? (() => {});
    }

    /** Start the gRPC stream. */
    async start(): Promise<void> {
        this.#session = http2.connect(GRPC_HOST, {
            ...AGY_TLS,
            ALPNProtocols: ["h2"],
        });

        this.#stream = this.#session.request({
            ":method": "POST",
            ":path": GRPC_PATH,
            "content-type": "application/grpc",
            "user-agent": GRPC_UA,
            te: "trailers",
            authorization: `Bearer ${this.#auth.access}`,
        });

        this.#stream.on("data", (data: Buffer) => this.#onData(data));
        this.#stream.on("trailers", (trailers) => {
            const status = trailers["grpc-status"];
            if (status && status !== "0") {
                this.#log(`gRPC error: ${status} ${trailers["grpc-message"] ?? ""}`);
            }
        });
        this.#stream.on("close", () => {
            this.#closed = true;
        });

        // Setup message
        const setup = field(1, Buffer.concat([
            field(1, Buffer.from(AGY_STT_MODEL)),
            field(5, field(6, Buffer.from([0x08, 0x01]))),
            field(8, Buffer.alloc(0)),
        ]));
        this.#stream.write(grpcFrame(setup));

        // Activity start
        const start = field(3, field(5, Buffer.alloc(0)));
        this.#stream.write(grpcFrame(start));

        // Wait for setup complete
        await this.#waitSetupComplete();
    }

    async #waitSetupComplete(): Promise<void> {
        const timeout = Date.now() + 10_000;
        while (Date.now() < timeout && !this.#closed) {
            // Setup complete is `1{}` (field 1, empty)
            if (this.#buffer.length >= 5) {
                const len = this.#buffer.readUInt32BE(1);
                if (this.#buffer.length >= 5 + len) {
                    const msg = this.#buffer.subarray(5, 5 + len);
                    this.#buffer = this.#buffer.subarray(5 + len);
                    const fields = parseProto(msg);
                    if (fields.has(1)) {
                        // Setup complete
                        return;
                    }
                }
            }
            await new Promise((r) => setTimeout(r, 50));
        }
        if (this.#closed) throw new Error("gRPC stream closed before setup complete");
        throw new Error("setup timeout");
    }

    #onData(data: Buffer): void {
        this.#buffer = Buffer.concat([this.#buffer, data]);
        this.#processMessages();
    }

    #processMessages(): void {
        while (this.#buffer.length >= 5) {
            const len = this.#buffer.readUInt32BE(1);
            if (this.#buffer.length < 5 + len) break;

            const msg = this.#buffer.subarray(5, 5 + len);
            this.#buffer = this.#buffer.subarray(5 + len);

            try {
                const fields = parseProto(msg);
                // Field 2 is the response content
                const content = getBytes(fields, 2);
                if (content) {
                    const inner = parseProto(content);
                    // Field 11 is interim transcript, field 6 is final
                    const interim = getBytes(inner, 11);
                    const final = getBytes(inner, 6);
                    // Field 2 = turn complete, field 3 = end
                    const turnComplete = getInt(inner, 2);
                    getInt(inner, 3); // end marker, not needed

                    if (interim) {
                        const text = this.#extractText(interim);
                        if (text !== this.#transcript) {
                            this.#transcript = text;
                            this.#lastChange = Date.now();
                        }
                    }
                    if (final) {
                        const text = this.#extractText(final);
                        this.#final = text;
                        this.#lastChange = Date.now();
                    }
                    if (turnComplete === 1) {
                        this.#turnComplete = true;
                    }
                }
            } catch (e) {
                this.#log(`parse error: ${e}`);
            }
        }
    }

    #extractText(msg: Buffer): string {
        const fields = parseProto(msg);
        const textBuf = getBytes(fields, 1);
        return textBuf?.toString("utf8") ?? "";
    }

    /** Send audio chunk (40 ms = 1280 bytes at 16 kHz). */
    sendAudio(chunk: Buffer): void {
        if (this.#closed || !this.#stream) return;
        const audio = field(3, field(1, Buffer.concat([
            field(1, Buffer.from("audio/pcm;rate=16000")),
            field(2, chunk),
        ])));
        this.#stream.write(grpcFrame(audio));
    }

    /** Signal end of audio. */
    sendEnd(): void {
        if (this.#closed || !this.#stream) return;
        const end = field(3, Buffer.concat([flag(2), field(6, Buffer.alloc(0))]));
        this.#stream.write(grpcFrame(end));
    }

    /** Half-close the stream (no more data from client). */
    halfClose(): void {
        this.#stream?.end();
    }

    /** Wait for the transcript to stop changing for the given ms. */
    async waitQuiet(ms: number): Promise<void> {
        while (!this.#closed && Date.now() - this.#lastChange < ms) {
            await new Promise((r) => setTimeout(r, 100));
        }
    }

    /** The current transcript (interim or final). */
    get transcript(): string {
        // Use final if it's at least 80% of interim length, else interim
        if (this.#final && this.#final.length >= this.#transcript.length * 0.8) {
            return this.#final;
        }
        return this.#transcript;
    }

    get turnComplete(): boolean {
        return this.#turnComplete;
    }

    get closed(): boolean {
        return this.#closed;
    }

    /** Close the stream and session. */
    close(): void {
        this.#stream?.close();
        this.#session?.close();
        this.#closed = true;
    }
}

/**
 * Transcribe audio with Antigravity's STT model.
 * @param pcm 16 kHz PCM s16le audio data.
 * @returns The transcript text.
 */
export async function transcribeAgy(
    options: AgyMediaOptions,
    pcm: Uint8Array,
    signal?: AbortSignal,
): Promise<string> {
    const auth = await options.auth();
    if (!auth) throw new Error("not signed in to Antigravity");

    const listener = new AgyListen(auth, options.log);
    await listener.start();

    // Send all audio at once (faster than real time)
    const CHUNK = 1280;
    for (let at = 0; at < pcm.length; at += CHUNK) {
        if (signal?.aborted) {
            listener.close();
            throw new Error("aborted");
        }
        listener.sendAudio(Buffer.from(pcm.subarray(at, at + CHUNK)));
    }

    // Wait for transcript to stabilize
    await listener.waitQuiet(1500);

    // Send end and half-close
    listener.sendEnd();
    await new Promise((r) => setTimeout(r, 100));
    listener.halfClose();

    // Wait for close
    const timeout = Date.now() + 10_000;
    while (!listener.closed && Date.now() < timeout) {
        await new Promise((r) => setTimeout(r, 100));
    }

    const transcript = listener.transcript;
    listener.close();
    return transcript;
}
