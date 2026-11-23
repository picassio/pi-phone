// Google Antigravity's media, stood in for tests (antigravity-media.ts, PP-556/557): Cloud Code's answers through the
// provider's `send`, and agy's gRPC dictation stream on a local HTTP/2 server.
import { createServer, type Http2Server, type ServerHttp2Stream } from "node:http2";
import type { AddressInfo } from "node:net";
import type { AgySend } from "../../src/server/antigravity.ts";
import { endMessage, grpcFrame } from "../../src/server/antigravity-media.ts";

export const AGY_UA = "antigravity/cli/1.5.15 (aidev_client; os_type=linux; arch=amd64; cl=1027820220; auth_method=consumer)";
/** The provider's `toAuth` key for a signed-in account. */
export const AGY_AUTH = JSON.stringify({ token: "ya29.live", project: "aicode-consumers", userAgent: AGY_UA });
export const AGY_STT_MODEL = "models/proactive-observer-v10";
/** `fetchAvailableModels`' answer, as much of it as media reads (and a chat model for the provider's list). */
export const AGY_MEDIA_CATALOG = {
    models: { "gemini-3.1-flash-image": { displayName: "Gemini 3.1 Flash Image" }, "gemini-3.8-flash-low": { displayName: "Gemini 3.8 Flash (Low)" } },
    imageGenerationModelIds: ["gemini-3.1-flash-image"],
    audioTranscriptionModelIds: [AGY_STT_MODEL],
    agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low"] }] }],
    groupedModels: {},
};
/** A 1x1 PNG. */
export const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAwS2OUAAAAABJRU5ErkJggg==", "base64");

export type Sent = { url: string; headers: Record<string, string>; body: string };

/** Cloud Code, as a test answers for it: each request kept. */
export function cloudCode(answer: (sent: Sent) => { status?: number; body: string }) {
    const sent: Sent[] = [];
    const send: AgySend = async (url, init) => {
        const request = { url, headers: init.headers, body: init.body ?? "" };

        sent.push(request);
        const reply = answer(request);

        return {
            status: reply.status ?? 200,
            headers: new Headers({ "content-type": "application/json" }),
            body: (async function* () {
                yield new TextEncoder().encode(reply.body);
            })(),
        };
    };

    return { sent, send };
}

/** generateContent's answer with one picture (a PNG Google calls a JPEG). */
export const imageAnswer = () => ({
    body: JSON.stringify({
        response: {
            candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "c2ln", inlineData: { mimeType: "image/jpeg", data: PNG.toString("base64") } }] }, finishReason: "STOP" }],
            usageMetadata: { promptTokenCount: 72, candidatesTokenCount: 1607, totalTokenCount: 1679 },
            modelVersion: "gemini-3.1-flash-image",
        },
        traceId: "t",
        metadata: {},
    }),
});

/** Answers for a signed-in app: the token, the project, the catalog, a picture. */
export const signedInGoogle = (sent: Sent) =>
    sent.url.endsWith("/token")
        ? { body: JSON.stringify({ access_token: "ya29.live", expires_in: 3599, refresh_token: "1//kept-refresh", token_type: "Bearer" }) }
        : sent.url.includes("loadCodeAssist")
          ? { body: JSON.stringify({ cloudaicompanionProject: "aicode-consumers" }) }
          : sent.url.includes("fetchAvailableModels")
            ? { body: JSON.stringify(AGY_MEDIA_CATALOG) }
            : sent.url.endsWith(":generateContent")
              ? imageAnswer()
              : { body: "{}" };

/** pcm16 at 16 kHz: a tone of `seconds`, or silence. */
export function pcm(...parts: [kind: "tone" | "quiet", seconds: number][]): Uint8Array {
    const chunks = parts.map(([kind, seconds]) => {
        const out = Buffer.alloc(Math.round(seconds * 16000) * 2);

        for (let at = 0; kind === "tone" && at < out.length / 2; at++) {
            out.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 440 * at) / 16000)), at * 2);
        }

        return out;
    });

    return new Uint8Array(Buffer.concat(chunks));
}

export function varintOf(value: number): Buffer {
    const out: number[] = [];
    let rest = value;

    while (rest > 0x7f) {
        out.push((rest & 0x7f) | 0x80);
        rest >>>= 7;
    }

    out.push(rest);

    return Buffer.from(out);
}

/** Server content with one text field (11: running, 6: final). */
export const serverText = (field: number, value: string) => {
    const text = Buffer.concat([Buffer.from([0x0a]), varintOf(Buffer.byteLength(value)), Buffer.from(value)]);
    const inner = Buffer.concat([Buffer.from([(field << 3) | 2]), varintOf(text.length), text]);

    return Buffer.concat([Buffer.from([0x12]), varintOf(inner.length), inner]);
};

/**
 * Google's dictation stream on a local HTTP/2 server: each stream's headers and messages kept; it answers the setup,
 * then the running transcript (how many bytes of audio it heard) as audio comes, a final one and the turn's end after
 * the client's end, and grpc-status 0 (or `status`) once the client half-closes.
 */
export async function dictationServer(options: { status?: string } = {}) {
    const streams: { headers: Record<string, unknown>; raw: string[]; messages: Buffer[] }[] = [];
    const server: Http2Server = createServer();

    server.on("stream", (stream: ServerHttp2Stream, headers, _flags, raw: string[]) => {
        // `raw`: the names and values in the order the client sent them.
        const kept = { headers: { ...headers }, raw: [...raw], messages: [] as Buffer[] };
        let buffer = Buffer.alloc(0);
        let heard = 0;

        streams.push(kept);
        stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
        stream.on("wantTrailers", () => stream.sendTrailers(options.status === undefined ? { "grpc-status": "0" } : { "grpc-status": options.status, "grpc-message": "quota%20exhausted" }));
        const say = (message: Buffer) => stream.write(grpcFrame(message));

        stream.on("data", (data: Buffer) => {
            buffer = Buffer.concat([buffer, data]);

            while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
                const message = buffer.subarray(5, 5 + buffer.readUInt32BE(1));

                buffer = buffer.subarray(5 + message.length);
                kept.messages.push(Buffer.from(message));

                if (message[0] === 0x0a) {
                    say(Buffer.from([0x0a, 0x00]));
                } else if (message.length > 30) {
                    // An audio message: 31 bytes around its pcm (of 128 bytes or more).
                    heard += message.length - 31;
                    say(serverText(11, `heard ${heard}`));
                } else if (message.equals(endMessage())) {
                    say(serverText(6, `final ${heard}`));
                    say(Buffer.from([0x12, 0x02, 0x10, 0x01]));
                }
            }
        });
        stream.on("end", () => {
            if (options.status === undefined) {
                say(Buffer.from([0x12, 0x02, 0x18, 0x01]));
            }

            stream.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return { streams, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}
