/**
 * Images and dictation through Google Antigravity (PP-556, PP-557), on the sign-in of `antigravity.ts` and in the shape
 * Google's `agy` 1.5.15 sends them (captured 2026-11-23; wiki: resources/antigravity-agy-fingerprint):
 *
 * - **Images**: agy's `generate_image` tool is `POST v1internal:generateContent` on Cloud Code with `requestType:
 *   "image_gen"` and the image model `fetchAvailableModels` names (`imageGenerationModelIds`, Gemini 3.1 Flash Image
 *   now): the prompt as text, the images to edit (agy takes three) as inline data after it, one candidate and an aspect
 *   ratio (agy's default 1:1). The pictures come back as inline data.
 * - **Dictation**: agy's `/voice` streams the mic's 16 kHz pcm16 over gRPC to `aicode.googleapis.com`'s
 *   `PredictionService/BidiGenerateContent` with the transcription model the catalog names (`audioTranscriptionModelIds`,
 *   `models/proactive-observer-v10` now): a setup, an activity start, 40 ms of audio a message, then the end of the
 *   audio and of the activity. Google answers with the running transcript (cumulative) and, at the end, a final one of
 *   the last turn only. No language or hint is sent: agy sends none, and Google hears the language itself.
 * - **Text-to-speech**: none. The catalog lists no speech model, the account's live voice is off, and the one TTS id in
 *   agy's binary answered 404 (checked 2026-11-23); `audio_speak` stays on the ChatGPT sign-in.
 *
 * Nothing here is sent before the owner signs in to Google Antigravity (Settings › Providers); its models show only then.
 *
 * Accounts (`accounts.ts`): images are made on the account their model names (`google-antigravity/<model>` the
 * original's, `google-antigravity~<slug>/<model>` another's), each on its own sign-in, catalog and background reads.
 * Dictation and transcription have no account in their settings: they are the original account's.
 *
 * On the wire as agy (PP-558's `agy-wire.ts`): the Cloud Code calls go on the provider's own transport (HTTP/1.1, Go's
 * headers and TLS, one pool of connections), the catalog is the provider's (which agy's background reads refresh), and a
 * media call starts agy's background reads as a turn does. The dictation's gRPC goes on Node's HTTP/2 with grpc-go's
 * ClientHello (`AGY_GRPC_TLS`), through the app's proxy with grpc-go's CONNECT, its headers in grpc-go's order. Node's
 * HTTP/2 SETTINGS and window updates stay Node's.
 */
import { randomUUID } from "node:crypto";
import http from "node:http";
import { type ClientHttp2Session, type ClientHttp2Stream, connect } from "node:http2";
import https from "node:https";
import type { Socket } from "node:net";
import tls from "node:tls";
import type { ConversationId } from "@earendil-works/pi-durable";
import { AGY_GRPC_TLS, agyTransport } from "./agy-wire.ts";
import { AGY_HOST, AGY_NAME, AGY_PROVIDER, type AgyAuth, type AgyCatalog, type AgySend, type AgyStep, cloudCodeHeaders, errorText, parseAuth, readText } from "./antigravity.ts";
import { imageType } from "./image-meta.ts";

/** agy's dictation endpoint: gRPC on HTTP/2. */
export const AGY_DICTATION_URL = "https://aicode.googleapis.com";
export const AGY_DICTATION_PATH = "/google.gca.aicode.v1alpha.PredictionService/BidiGenerateContent";
/** agy's gRPC client says this of itself. */
export const AGY_GRPC_AGENT = "grpc-go/1.86.0-dev";
/** What dictation hears: 16 kHz mono pcm16, as agy records it (`arecord -f S16_LE -r 16000 -c 1`). */
export const AGY_PCM_RATE = 16000;
/** agy's audio message: 40 ms. */
export const AGY_CHUNK_BYTES = 1280;
const BYTES_A_SECOND = AGY_PCM_RATE * 2;
/** agy's image tool's aspect ratios, and its default. */
export const AGY_ASPECTS = ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9"] as const;
/** The most images agy's image tool edits at once. */
export const AGY_MAX_INPUTS = 3;
/** The id `audio.transcribeModel` keeps for Antigravity's transcription model, whatever Google names it now. */
export const AGY_TRANSCRIBE = "antigravity";
/** How long the catalog's media models are kept before Google is asked again. */
const CATALOG_MS = 60 * 60 * 1000;
/** Google is done reading the audio when it has said nothing for this long. */
const IDLE_MS = 1500;
/** The most a stream may wait for Google to finish, beyond its audio. */
const STREAM_MS = 60_000;
/** A picture takes a while. */
const IMAGE_MS = 5 * 60 * 1000;
/** A live dictation the page stopped feeding is dropped after this. */
const DICTATION_IDLE_MS = 30_000;

type Catalog = Pick<AgyCatalog, "imageGenerationModelIds" | "audioTranscriptionModelIds"> & { models?: Record<string, { displayName?: string }> };

export type AgyImageModel = { id: string; name: string };
export type AgyImage = { mimeType: string; data: Uint8Array };
export type AgyImages = { images: AgyImage[]; text: string; tokens: { input: number; output: number } };
/** One stretch of speech in a file: from and to in ms, and what was said. */
export type AgyUtterance = { start: number; end: number; text: string };

/** An Antigravity account signed in now: the original (`google-antigravity`) or one more (`accounts.ts`), with its name. */
export type AgyAccount = { id: string; name?: string };

export interface AgyMediaOptions {
    /** An account's request auth (pi's `toAuth` key, renewed when it ran out), or undefined when it is not signed in. */
    apiKey(account: string): Promise<string | undefined>;
    /** The accounts signed in now, the original first when it is. Default: the original's alone, when signed in. */
    accounts?: () => Promise<AgyAccount[]>;
    /** The provider's transport (`AgyRuntime.send`); tests answer for Cloud Code. Default: a transport of agy's own. */
    send?: AgySend;
    /** An account's catalog (`AgyRuntime.catalog`). Default: asked here, kept an hour. */
    catalog?: (account: string, auth: AgyAuth, signal?: AbortSignal) => Promise<AgyCatalog>;
    /** Before a media call: the account's background reads start as for a turn (awaited unless `wait` is false). */
    beforeUse?: (account: string, auth: AgyAuth, wait: boolean) => Promise<void>;
    /** After a media call: agy's read of the account's quota after a turn. */
    afterUse?: (account: string) => void;
    /**
     * The agent request a session's tool call came from (its trajectory and step), when the session is on `account`'s
     * models: a session on another account's (or another provider's) has no trajectory of this account's.
     */
    stepOf?: (conversationId: ConversationId, account: string) => Promise<AgyStep | undefined>;
    /** Tests answer for the dictation endpoint (an h2c server). */
    dictationUrl?: string;
    now?: () => number;
    /** Tests do not wait for Google's quiet. */
    idleMs?: number;
}

// ---- protobuf, as much as the dictation stream needs ----

function varint(value: number): Buffer {
    const out: number[] = [];
    let rest = value;

    while (rest > 0x7f) {
        out.push((rest & 0x7f) | 0x80);
        rest = Math.floor(rest / 128);
    }

    out.push(rest);

    return Buffer.from(out);
}

const bytesField = (number: number, value: Uint8Array) => Buffer.concat([varint((number << 3) | 2), varint(value.length), value]);
const textField = (number: number, value: string) => bytesField(number, Buffer.from(value, "utf8"));
const trueField = (number: number) => Buffer.from([number << 3, 1]);
const EMPTY = Buffer.alloc(0);

/** The setup agy sends: the model, `5{6{1:1}}` and an empty `8`, as captured. */
export const setupMessage = (model: string) => bytesField(1, Buffer.concat([textField(1, model), bytesField(5, bytesField(6, trueField(1))), bytesField(8, EMPTY)]));
/** Realtime input: the activity starts. */
export const startMessage = () => bytesField(3, bytesField(5, EMPTY));
/** Realtime input: one piece of audio. */
export const audioMessage = (pcm: Uint8Array) => bytesField(3, bytesField(1, Buffer.concat([textField(1, `audio/pcm;rate=${AGY_PCM_RATE}`), bytesField(2, pcm)])));
/** Realtime input: the audio stream ends, and the activity. */
export const endMessage = () => bytesField(3, Buffer.concat([trueField(2), bytesField(6, EMPTY)]));

/** A gRPC message on the wire: uncompressed, its length, itself. */
export function grpcFrame(message: Uint8Array): Buffer {
    const head = Buffer.alloc(5);

    head.writeUInt32BE(message.length, 1);

    return Buffer.concat([head, message]);
}

type Field = { number: number; varint?: number; bytes?: Buffer };

function fields(message: Buffer): Field[] {
    const out: Field[] = [];
    let at = 0;
    const read = () => {
        let value = 0;
        let scale = 1;

        for (;;) {
            if (at >= message.length) {
                throw new Error("A message from Google's dictation ended early.");
            }

            const byte = message[at++]!;

            value += (byte & 0x7f) * scale;
            scale *= 128;

            if (byte < 0x80) {
                return value;
            }
        }
    };

    while (at < message.length) {
        const key = read();
        const number = Math.floor(key / 8);
        const type = key & 7;

        if (type === 0) {
            out.push({ number, varint: read() });
        } else if (type === 2) {
            const length = read();

            out.push({ number, bytes: message.subarray(at, at + length) });
            at += length;
        } else if (type === 1) {
            at += 8;
        } else if (type === 5) {
            at += 4;
        } else {
            throw new Error(`Google's dictation sent a field of wire type ${type}.`);
        }
    }

    return out;
}

/** What one server message says: the setup is done, the running transcript, the final one, the turn is complete. */
export type Heard = { setup?: true; running?: string; final?: string; turnComplete?: true };

export function readHeard(message: Buffer): Heard {
    const heard: Heard = {};
    const textOf = (bytes: Buffer | undefined) => fields(bytes ?? EMPTY).find((each) => each.number === 1)?.bytes?.toString("utf8") ?? "";

    for (const field of fields(message)) {
        if (field.number === 1) {
            heard.setup = true;
        } else if (field.number === 2 && field.bytes !== undefined) {
            for (const inner of fields(field.bytes)) {
                if (inner.number === 11) {
                    heard.running = textOf(inner.bytes);
                } else if (inner.number === 6) {
                    heard.final = textOf(inner.bytes);
                } else if (inner.number === 2 && inner.varint === 1) {
                    heard.turnComplete = true;
                }
            }
        }
    }

    return heard;
}

/**
 * What was said: Google's final transcript covers the last turn only, its running one all of it. The final is the
 * transcript when it covers what was heard (at least 80% of the running one's length), else the running one is.
 */
export function transcriptOf(running: string, final: string): string {
    const a = running.trim();
    const b = final.trim();

    return b !== "" && b.length >= a.length * 0.8 ? b : a;
}

/**
 * The stretches of speech in 16 kHz pcm16, by loudness in 30 ms frames: quiet under three times the quietest fifth's
 * level or a tenth of the loud end's (at least 300), gaps up to 1.5 s joined, 210 ms kept around each, and none longer than 45 s (cut at its
 * quietest frame). Times in ms.
 */
export function speechSegments(pcm: Uint8Array): { start: number; end: number }[] {
    const FRAME = AGY_PCM_RATE * 0.03;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
    const samples = view.byteLength / 2;
    const levels: number[] = [];

    for (let from = 0; from < samples; from += FRAME) {
        let sum = 0;
        const to = Math.min(samples, from + FRAME);

        for (let at = from; at < to; at++) {
            const sample = view.getInt16(at * 2, true);

            sum += sample * sample;
        }

        levels.push(Math.sqrt(sum / Math.max(1, to - from)));
    }

    if (levels.length === 0) {
        return [];
    }

    // Speech is louder than three times the quietest fifth (the room's noise), or than a tenth of the loud end, whichever
    // is lower: a file with no pause at all is speech throughout. Never under 300 (of 32767).
    const sorted = [...levels].sort((a, b) => a - b);
    const floor = sorted[Math.floor(sorted.length * 0.2)]!;
    const loud = sorted[Math.floor(sorted.length * 0.95)]!;
    const threshold = Math.max(300, Math.min(floor * 3, loud * 0.1));
    const regions: [number, number][] = [];

    levels.forEach((level, index) => {
        if (level < threshold) {
            return;
        }

        const last = regions.at(-1);

        if (last !== undefined && index - last[1] <= 50) {
            last[1] = index + 1;
        } else {
            regions.push([index, index + 1]);
        }
    });

    // A stretch longer than 45 s is cut at its quietest frame between 30 and 45 s, and the rest the same way.
    const cut = (from: number, to: number): [number, number][] => {
        if (to - from <= 1500) {
            return [[from, to]];
        }

        let quietest = from + 1000;

        for (let at = from + 1000; at < from + 1500; at++) {
            if (levels[at]! < levels[quietest]!) {
                quietest = at;
            }
        }

        return [...cut(from, quietest), ...cut(quietest, to)];
    };
    const total = levels.length;

    return regions
        .filter(([from, to]) => to - from >= 4)
        .flatMap(([from, to]) => cut(Math.max(0, from - 7), Math.min(total, to + 7)))
        .map(([from, to]) => ({ start: from * 30, end: Math.min(to * 30, Math.round((samples / AGY_PCM_RATE) * 1000)) }));
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The proxy Go would use for this address (`HTTPS_PROXY`, unless `NO_PROXY` names its host), as the app sets it. */
export function proxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
    const proxy = env.HTTPS_PROXY ?? env.https_proxy;

    if (target.protocol !== "https:" || proxy === undefined || proxy.trim() === "") {
        return undefined;
    }

    const host = target.hostname.toLowerCase();

    for (const entry of (env.NO_PROXY ?? env.no_proxy ?? "").split(",")) {
        const name = entry.trim().toLowerCase().replace(/:\d+$/, "");

        if (name === "*" || (name !== "" && (host === name.replace(/^\./, "") || host.endsWith(name.startsWith(".") ? name : `.${name}`)))) {
            return undefined;
        }
    }

    return new URL(proxy.includes("://") ? proxy : `http://${proxy}`);
}

/** A tunnel through the proxy as grpc-go opens it: `CONNECT host:443` with only `Host` and grpc-go's User-Agent. */
function tunnel(proxy: URL, target: URL): Promise<Socket> {
    const authority = `${target.hostname}:${target.port || "443"}`;

    return new Promise<Socket>((resolve, reject) => {
        const request = (proxy.protocol === "https:" ? https : http).request({
            host: proxy.hostname,
            port: Number(proxy.port) || (proxy.protocol === "https:" ? 443 : 80),
            method: "CONNECT",
            path: authority,
            setHost: false,
            headers: {
                Host: authority,
                "User-Agent": AGY_GRPC_AGENT,
                ...(proxy.username === "" ? {} : { "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}` }),
            },
        });

        request.removeHeader("Connection");
        request.on("connect", (response, socket) => {
            if (response.statusCode === 200) {
                resolve(socket);
            } else {
                socket.destroy();
                reject(new Error(`the proxy answered ${String(response.statusCode)} to CONNECT`));
            }
        });
        request.on("error", reject);
        request.end();
    });
}

/**
 * An HTTP/2 session to the dictation endpoint as grpc-go opens one: its ClientHello (`AGY_GRPC_TLS`), through the proxy
 * when there is one. An `http:` address (tests) is plain h2c.
 */
async function grpcSession(address: string): Promise<ClientHttp2Session> {
    const target = new URL(address);

    if (target.protocol !== "https:") {
        return connect(address);
    }

    const proxy = proxyFor(target);
    const socket = proxy === undefined ? undefined : await tunnel(proxy, target);
    const options = { ...AGY_GRPC_TLS, ALPNProtocols: [...AGY_GRPC_TLS.ALPNProtocols], servername: target.hostname };

    return socket === undefined
        ? connect(address, options)
        : connect(address, { ...options, createConnection: () => tls.connect({ ...options, socket }) });
}

/**
 * One dictation stream: opened with the setup and the activity's start, fed audio (in agy's 40 ms messages), then
 * finished: once Google has said nothing for a moment (it has read all the audio), the end goes and the stream is
 * half-closed; what was said comes when Google closes it.
 */
export class AgyListen {
    readonly #session: ClientHttp2Session;
    readonly #stream: ClientHttp2Stream;
    readonly #idleMs: number;
    #rest: Buffer = EMPTY;
    #running = "";
    #final = "";
    #lastHeard = Date.now();
    #ended = false;
    readonly closed: Promise<string>;
    /** The running transcript as it changes. */
    onText: ((text: string) => void) | undefined;

    /** A stream on a new connection, as agy opens one for each dictation. */
    static async open(url: string, token: string, model: string, idleMs: number): Promise<AgyListen> {
        return new AgyListen(await grpcSession(url), new URL(url), token, model, idleMs);
    }

    private constructor(session: ClientHttp2Session, url: URL, token: string, model: string, idleMs: number) {
        this.#idleMs = idleMs;
        this.#session = session;
        this.#session.on("error", () => undefined);
        // grpc-go's order: the pseudo-headers, then content-type, user-agent, te, and the call's metadata.
        this.#stream = this.#session.request({
            ":method": "POST",
            ":scheme": url.protocol.replace(":", ""),
            ":path": AGY_DICTATION_PATH,
            ":authority": url.host,
            "content-type": "application/grpc",
            "user-agent": AGY_GRPC_AGENT,
            te: "trailers",
            authorization: `Bearer ${token}`,
        });
        let buffer = EMPTY;
        let status: string | undefined;
        let message: string | undefined;
        let httpStatus: number | undefined;

        this.closed = new Promise<string>((resolve, reject) => {
            this.#stream.on("response", (headers) => {
                httpStatus = Number(headers[":status"]);
                status = typeof headers["grpc-status"] === "string" ? headers["grpc-status"] : status;
                message = typeof headers["grpc-message"] === "string" ? decodeURIComponent(headers["grpc-message"]) : message;
            });
            this.#stream.on("trailers", (trailers) => {
                status = typeof trailers["grpc-status"] === "string" ? trailers["grpc-status"] : status;
                message = typeof trailers["grpc-message"] === "string" ? decodeURIComponent(trailers["grpc-message"]) : message;
            });
            this.#stream.on("data", (data: Buffer) => {
                buffer = Buffer.concat([buffer, data]);

                while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
                    const length = buffer.readUInt32BE(1);
                    const heard = readHeard(buffer.subarray(5, 5 + length));

                    buffer = buffer.subarray(5 + length);
                    this.#lastHeard = Date.now();

                    if (heard.running !== undefined && heard.running !== this.#running) {
                        this.#running = heard.running;
                        this.onText?.(this.#running);
                    }

                    if (heard.final !== undefined) {
                        this.#final = heard.final;
                    }
                }
            });
            this.#stream.on("error", (error) => reject(new Error(`Could not reach ${AGY_NAME}'s dictation: ${error.message}`)));
            this.#stream.on("close", () => {
                this.#session.close();

                if (httpStatus !== undefined && httpStatus !== 200) {
                    reject(new Error(`${AGY_NAME}'s dictation answered HTTP ${httpStatus}.`));
                } else if (status !== undefined && status !== "0") {
                    reject(new Error(`${AGY_NAME}'s dictation refused (gRPC ${status}${message === undefined || message === "" ? "" : `: ${message}`}).`));
                } else if (status === undefined) {
                    reject(new Error(`${AGY_NAME}'s dictation closed without a status.`));
                } else {
                    resolve(transcriptOf(this.#running, this.#final));
                }
            });
        });
        this.closed.catch(() => undefined);
        this.#stream.write(grpcFrame(setupMessage(model)));
        this.#stream.write(grpcFrame(startMessage()));
    }

    get running(): string {
        return this.#running;
    }

    /** Audio to send, in agy's 40 ms messages; a remainder waits for the next. */
    audio(pcm: Uint8Array): void {
        if (this.#ended || this.#stream.closed || this.#stream.destroyed) {
            return;
        }

        let data = this.#rest.length === 0 ? Buffer.from(pcm) : Buffer.concat([this.#rest, pcm]);

        while (data.length >= AGY_CHUNK_BYTES) {
            this.#stream.write(grpcFrame(audioMessage(data.subarray(0, AGY_CHUNK_BYTES))));
            data = data.subarray(AGY_CHUNK_BYTES);
        }

        this.#rest = data;
    }

    /** The rest of the audio, Google's quiet, the end, and what was said. */
    async finish(signal?: AbortSignal): Promise<string> {
        if (!this.#ended) {
            if (this.#rest.length > 0) {
                this.#stream.write(grpcFrame(audioMessage(this.#rest)));
                this.#rest = EMPTY;
            }

            this.#ended = true;
            const started = Date.now();

            while (Date.now() - this.#lastHeard < this.#idleMs && Date.now() - started < STREAM_MS && !this.#stream.closed) {
                if (signal?.aborted) {
                    this.abort();
                    throw new Error("Stopped.");
                }

                await new Promise((resolve) => setTimeout(resolve, 100));
            }

            if (!this.#stream.closed) {
                this.#stream.end(grpcFrame(endMessage()));
            }
        }

        const timer = setTimeout(() => this.abort(), STREAM_MS);

        try {
            return await this.closed;
        } finally {
            clearTimeout(timer);
        }
    }

    /** Close now, nothing kept. */
    abort(): void {
        this.#ended = true;
        this.#stream.close();
        this.#session.close();
    }
}

/** A dictation from the page: its stream, and when the page last sent audio. */
type Dictation = { listen: AgyListen; at: number; userId: string; failed?: string };

export class AgyMedia {
    readonly #options: AgyMediaOptions;
    readonly #send: AgySend;
    readonly #catalogs = new Map<string, { at: number; catalog: Catalog }>();
    readonly #dictations = new Map<string, Dictation>();

    constructor(options: AgyMediaOptions) {
        this.#options = options;
        this.#send = options.send ?? agyTransport();
    }

    #now(): number {
        return (this.#options.now ?? Date.now)();
    }

    /** An account's auth, or undefined when it is not signed in. */
    async #auth(account: string): Promise<AgyAuth | undefined> {
        const key = await this.#options.apiKey(account);

        return key === undefined || key === "" ? undefined : parseAuth(key);
    }

    async #signedInAuth(account: string): Promise<AgyAuth> {
        const auth = await this.#auth(account);

        if (auth === undefined) {
            throw new Error(
                account === AGY_PROVIDER
                    ? `${AGY_NAME} is not signed in: sign in in Settings › Providers.`
                    : `The ${AGY_NAME} account ${account} is not signed in: sign in to it in Settings › Providers.`,
            );
        }

        return auth;
    }

    /** Whether the account (the original by default) is signed in. */
    async signedIn(account: string = AGY_PROVIDER): Promise<boolean> {
        return (await this.#options.apiKey(account).catch(() => undefined)) !== undefined;
    }

    /** The accounts signed in now, the original first when it is. */
    async accounts(): Promise<AgyAccount[]> {
        if (this.#options.accounts !== undefined) {
            return this.#options.accounts();
        }

        return (await this.signedIn(AGY_PROVIDER)) ? [{ id: AGY_PROVIDER }] : [];
    }

    /** One Cloud Code call with agy's headers, in Go's order; Google's error as the message. */
    async #cloudCode(method: string, auth: AgyAuth, body: unknown, signal?: AbortSignal): Promise<unknown> {
        const url = `${AGY_HOST}/v1internal:${method}`;
        const json = JSON.stringify(body);
        const answer = await this.#send(url, { headers: cloudCodeHeaders(url, auth, json), body: json, ...(signal === undefined ? {} : { signal }) });
        const text = await readText(answer.body);

        if (answer.status >= 400) {
            throw new Error(`${AGY_NAME} (${answer.status}): ${errorText(text)}`);
        }

        return JSON.parse(text) as unknown;
    }

    /**
     * The catalog's media models: the provider's (agy's background reads keep it current), or else asked here
     * (`fetchAvailableModels`, as agy asks it) and kept an hour; a failed ask is not kept.
     */
    async #media(account: string, auth: AgyAuth): Promise<Catalog> {
        if (this.#options.catalog !== undefined) {
            return this.#options.catalog(account, auth, AbortSignal.timeout(30_000));
        }

        const now = this.#now();
        const kept = this.#catalogs.get(account);

        if (kept !== undefined && now - kept.at < CATALOG_MS) {
            return kept.catalog;
        }

        const answer = await this.#cloudCode("fetchAvailableModels", auth, { project: auth.project }, AbortSignal.timeout(30_000));
        const catalog = (isRecord(answer) ? answer : {}) as Catalog;

        this.#catalogs.set(account, { at: now, catalog });

        return catalog;
    }

    /** The image models an account (the original by default) offers, with their names; none when it is not signed in. */
    async imageModels(account: string = AGY_PROVIDER): Promise<AgyImageModel[]> {
        const auth = await this.#auth(account);

        if (auth === undefined) {
            return [];
        }

        const catalog = await this.#media(account, auth);

        return (catalog.imageGenerationModelIds ?? []).map((id) => ({ id, name: catalog.models?.[id]?.displayName ?? id }));
    }

    /** The transcription model Antigravity offers now (agy's dictation model), on the original account. */
    async transcribeModel(): Promise<string> {
        const auth = await this.#signedInAuth(AGY_PROVIDER);
        const model = (await this.#media(AGY_PROVIDER, auth)).audioTranscriptionModelIds?.[0];

        if (model === undefined) {
            throw new Error(`${AGY_NAME} lists no transcription model for this account now.`);
        }

        return model;
    }

    /** A media call as agy makes one while it runs: its background reads first, its quota read after. */
    async #use<T>(account: string, auth: AgyAuth, wait: boolean, call: () => Promise<T>): Promise<T> {
        await this.#options.beforeUse?.(account, auth, wait);

        try {
            return await call();
        } finally {
            this.#options.afterUse?.(account);
        }
    }

    /**
     * agy's image request id: `image_gen/<ms>/<the calling trajectory>/<the step after the agent request>`. A session on
     * Antigravity gives its own; another session has no agy trajectory, so it gets a new one, as a first tool call (step 2).
     */
    async #imageRequestId(account: string, conversationId: ConversationId | undefined): Promise<string> {
        const step = conversationId === undefined ? undefined : await this.#options.stepOf?.(conversationId, account).catch(() => undefined);

        return `image_gen/${this.#now()}/${step?.trajectory ?? randomUUID()}/${step === undefined ? 2 : step.step + 1}`;
    }

    /** One picture, or an edit of up to three, as agy's image tool asks for it, on `account` (the original by default). */
    async makeImage(request: {
        model: string;
        prompt: string;
        inputs: AgyImage[];
        aspect?: string;
        signal?: AbortSignal;
        conversationId?: ConversationId;
        account?: string;
    }): Promise<AgyImages> {
        if (request.inputs.length > AGY_MAX_INPUTS) {
            throw new Error(`${AGY_NAME} edits at most ${AGY_MAX_INPUTS} images at once.`);
        }

        const aspect = request.aspect ?? "1:1";

        if (!(AGY_ASPECTS as readonly string[]).includes(aspect)) {
            throw new Error(`${AGY_NAME} takes the aspect ratios ${AGY_ASPECTS.join(", ")}.`);
        }

        const account = request.account ?? AGY_PROVIDER;
        const auth = await this.#signedInAuth(account);

        return this.#use(account, auth, true, () => this.#makeImage(account, auth, request, aspect));
    }

    async #makeImage(
        account: string,
        auth: AgyAuth,
        request: { model: string; prompt: string; inputs: AgyImage[]; signal?: AbortSignal; conversationId?: ConversationId },
        aspect: string,
    ): Promise<AgyImages> {
        const body = {
            project: auth.project,
            requestId: await this.#imageRequestId(account, request.conversationId),
            request: {
                contents: [
                    {
                        role: "user",
                        parts: [{ text: request.prompt }, ...request.inputs.map((image) => ({ inlineData: { mimeType: image.mimeType, data: Buffer.from(image.data).toString("base64") } }))],
                    },
                ],
                generationConfig: { candidateCount: 1, imageConfig: { aspectRatio: aspect } },
            },
            model: request.model,
            userAgent: "antigravity",
            requestType: "image_gen",
        };
        const answer = await this.#cloudCode("generateContent", auth, body, AbortSignal.any([AbortSignal.timeout(IMAGE_MS), ...(request.signal === undefined ? [] : [request.signal])]));
        const response = isRecord(answer) && isRecord(answer.response) ? answer.response : {};
        const candidate = Array.isArray(response.candidates) && isRecord(response.candidates[0]) ? response.candidates[0] : {};
        const content = isRecord(candidate.content) ? candidate.content : {};
        const parts = Array.isArray(content.parts) ? content.parts.filter(isRecord) : [];
        const images = parts.flatMap((part) => {
            const inline = isRecord(part.inlineData) ? part.inlineData : undefined;
            const data = typeof inline?.data === "string" ? new Uint8Array(Buffer.from(inline.data, "base64")) : undefined;

            if (data === undefined || data.length === 0) {
                return [];
            }

            const mimeType = imageType(data) ?? (typeof inline?.mimeType === "string" ? inline.mimeType : undefined);

            return mimeType === undefined ? [] : [{ mimeType, data }];
        });
        const text = parts
            .filter((part) => part.thought !== true && typeof part.text === "string")
            .map((part) => String(part.text))
            .join("")
            .trim();

        if (images.length === 0) {
            const reason = typeof candidate.finishReason === "string" ? ` (${candidate.finishReason})` : "";

            throw new Error(`${AGY_NAME} returned no image with ${request.model}${reason}${text === "" ? "" : `; it said: ${text.slice(0, 400)}`}.`);
        }

        const usage = isRecord(response.usageMetadata) ? response.usageMetadata : {};

        return {
            images,
            text,
            tokens: { input: typeof usage.promptTokenCount === "number" ? usage.promptTokenCount : 0, output: typeof usage.candidatesTokenCount === "number" ? usage.candidatesTokenCount : 0 },
        };
    }

    /** A new dictation stream on the original account's sign-in, with the catalog's transcription model. */
    async listen(): Promise<{ listen: AgyListen; model: string }> {
        const auth = await this.#signedInAuth(AGY_PROVIDER);
        const model = await this.transcribeModel();

        return { listen: await AgyListen.open(this.#options.dictationUrl ?? AGY_DICTATION_URL, auth.token, model, this.#options.idleMs ?? IDLE_MS), model };
    }

    /**
     * A file's 16 kHz pcm16 as utterances: each stretch of speech (`speechSegments`) in a stream of its own, one after
     * another, sent at once, its transcript once Google is done with it.
     */
    async transcribe(pcm: Uint8Array, signal?: AbortSignal): Promise<{ model: string; utterances: AgyUtterance[] }> {
        const auth = await this.#signedInAuth(AGY_PROVIDER);

        return this.#use(AGY_PROVIDER, auth, true, () => this.#transcribe(pcm, signal));
    }

    async #transcribe(pcm: Uint8Array, signal?: AbortSignal): Promise<{ model: string; utterances: AgyUtterance[] }> {
        const model = await this.transcribeModel();
        const utterances: AgyUtterance[] = [];

        for (const segment of speechSegments(pcm)) {
            if (signal?.aborted) {
                throw new Error("Stopped.");
            }

            const { listen } = await this.listen();
            const from = Math.floor((segment.start * BYTES_A_SECOND) / 1000 / 2) * 2;
            const to = Math.floor((segment.end * BYTES_A_SECOND) / 1000 / 2) * 2;

            listen.audio(pcm.subarray(from, to));
            const text = (await listen.finish(signal)).trim();

            if (text !== "") {
                utterances.push({ ...segment, text });
            }
        }

        return { model, utterances };
    }

    // ---- the message box's dictation (Settings › Dictation › Google Antigravity) ----

    /** Start a dictation for the page: its id. */
    async startDictation(userId: string): Promise<{ dictation: string; model: string; rate: number }> {
        this.#sweep();
        // agy's background reads start beside it: the mic does not wait for them.
        await this.#options.beforeUse?.(AGY_PROVIDER, await this.#signedInAuth(AGY_PROVIDER), false);
        const { listen, model } = await this.listen();
        const id = randomUUID();

        const dictation: Dictation = { listen, at: this.#now(), userId };

        this.#dictations.set(id, dictation);
        // Google closing it early (a refusal, the network) is said to the page's next audio.
        listen.closed.catch((error: unknown) => {
            dictation.failed = error instanceof Error ? error.message : String(error);
        });

        return { dictation: id, model, rate: AGY_PCM_RATE };
    }

    #dictation(userId: string, id: string): Dictation {
        const found = this.#dictations.get(id);

        if (found === undefined || found.userId !== userId) {
            throw new Error("No such dictation: it ended. Tap the mic again.");
        }

        return found;
    }

    /** The page's audio (16 kHz pcm16): the running transcript back. */
    dictationAudio(userId: string, id: string, pcm: Uint8Array): { text: string } {
        const found = this.#dictation(userId, id);

        if (found.failed !== undefined) {
            this.#dictations.delete(id);
            throw new Error(found.failed);
        }

        found.at = this.#now();
        found.listen.audio(pcm);

        return { text: found.listen.running };
    }

    /** The page stopped: what was said; `drop` closes it at once. */
    async endDictation(userId: string, id: string, drop: boolean): Promise<{ text: string }> {
        const found = this.#dictation(userId, id);

        this.#dictations.delete(id);

        if (drop) {
            found.listen.abort();

            return { text: "" };
        }

        try {
            return { text: await found.listen.finish() };
        } finally {
            this.#options.afterUse?.(AGY_PROVIDER);
        }
    }

    /** Dictations the page stopped feeding long ago are closed. */
    #sweep(): void {
        for (const [id, each] of this.#dictations) {
            if (this.#now() - each.at > DICTATION_IDLE_MS) {
                each.listen.abort();
                this.#dictations.delete(id);
            }
        }
    }
}
