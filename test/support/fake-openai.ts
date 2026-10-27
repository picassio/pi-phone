// OpenAI's realtime API as voice uses it (PP-185, src/server/voice.ts and voice-bridge.ts), for tests: short-lived keys
// (`POST /v1/realtime/client_secrets`), calls (`POST /v1/realtime/calls`, with a key or the sign-in), Codex's private
// calls endpoint, and the server's own connection to a call by its id (the sideband WebSocket). Only the test token
// signs in. Everything asked is recorded; tests push events into a call's sideband as OpenAI would.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { VoiceEndpoints } from "../../src/server/voice.ts";

export const TOKEN = "header.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjdC0xIn19.signature";
export const ANSWER = "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n";

export type Recorded = { method: string; path: string; headers: Record<string, string | string[] | undefined>; body: string };

export class FakeOpenAI {
    /** Live models a key may be minted for. */
    live = new Set(["gpt-realtime-2", "gpt-realtime-mini"]);
    /** Live models minting refuses (403) though a call with the sign-in takes them. */
    serverOnly = new Set(["gpt-realtime-1.5"]);
    dictation = new Set(["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"]);
    voices = new Set(["marin", "cedar", "alloy"]);
    languages = new Set(["vi", "en"]);
    /** The Codex endpoint takes calls. */
    codex = true;
    readonly requests: Recorded[] = [];
    /** Keys minted, and the session each was for. */
    readonly keys = new Map<string, Record<string, unknown>>();
    /** Calls made, by id: how (key or sign-in), and the SDP offer. */
    readonly calls = new Map<string, { by: string; offer: string }>();
    /** Each call's sideband: what the server sent on it, and the socket. */
    readonly sidebands = new Map<string, { received: Record<string, unknown>[]; socket: WebSocket; headers: Record<string, string | string[] | undefined> }>();
    #server: Server | undefined;
    #sockets: WebSocketServer | undefined;
    #count = 0;

    get endpoints(): VoiceEndpoints {
        const port = (this.#server!.address() as AddressInfo).port;

        return { api: `http://127.0.0.1:${port}/v1`, socket: `ws://127.0.0.1:${port}/v1`, codex: `http://127.0.0.1:${port}/backend-api/codex` };
    }

    async start(): Promise<this> {
        this.#server = createServer((request, response) => {
            const chunks: Buffer[] = [];

            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                // A page posts its offer from another origin, as OpenAI allows (checked 2026-10-27: `*`, Location exposed).
                const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "Location" };

                if (request.method === "OPTIONS") {
                    response.writeHead(200, { ...cors, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST" });
                    response.end();

                    return;
                }

                const answer = this.#answer(request, body);

                this.requests.push({ method: request.method ?? "", path: request.url ?? "", headers: request.headers, body });
                response.writeHead(answer.status, { ...cors, "content-type": answer.type, ...(answer.location === undefined ? {} : { location: answer.location }) });
                response.end(answer.body);
            });
        });
        this.#sockets = new WebSocketServer({ noServer: true });
        this.#server.on("upgrade", (request, socket, head) => {
            const url = new URL(request.url ?? "/", "http://fake");
            const call = url.searchParams.get("call_id") ?? "";

            if (request.headers.authorization !== `Bearer ${TOKEN}` || !this.calls.has(call)) {
                socket.end("HTTP/1.1 401 Unauthorized\r\n\r\n");

                return;
            }

            this.#sockets!.handleUpgrade(request, socket, head, (ws) => {
                const side = { received: [] as Record<string, unknown>[], socket: ws, headers: request.headers };

                this.sidebands.set(call, side);
                ws.on("message", (data) => {
                    const event = JSON.parse(String(data)) as Record<string, unknown>;

                    side.received.push(event);

                    if (event.type === "session.update") {
                        ws.send(JSON.stringify({ type: "session.updated", session: event.session }));
                    }
                });
            });
        });
        await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));

        return this;
    }

    /** Send an event to the server on a call's sideband, as OpenAI would. */
    push(call: string, event: Record<string, unknown>): void {
        this.sidebands.get(call)?.socket.send(JSON.stringify(event));
    }

    /** Close a call's sideband from OpenAI's side (the call ended). */
    hangUp(call: string): void {
        this.sidebands.get(call)?.socket.close(1000, "call ended");
    }

    #error(status: number, message: string, code?: string) {
        return { status, type: "application/json", body: JSON.stringify({ error: { message, type: "invalid_request_error", code: code ?? null } }) };
    }

    #answer(request: IncomingMessage, body: string): { status: number; type: string; body: string; location?: string } {
        const url = new URL(request.url ?? "/", "http://fake");
        const auth = String(request.headers.authorization ?? "");
        const signedIn = auth === `Bearer ${TOKEN}`;

        if (url.pathname === "/v1/realtime/client_secrets" && request.method === "POST") {
            if (!signedIn) {
                return this.#error(401, "Missing scopes.");
            }

            const session = (JSON.parse(body) as { session: Record<string, unknown> }).session;
            const audio = session.audio as { input?: { transcription?: { model?: string; language?: string } }; output?: { voice?: string } } | undefined;

            if (session.type === "transcription") {
                const transcription = audio?.input?.transcription;

                if (!this.dictation.has(transcription?.model ?? "")) {
                    return this.#error(404, `The model \`${transcription?.model}\` does not exist or you do not have access to it.`, "model_not_found");
                }

                if (transcription?.language !== undefined && !this.languages.has(transcription.language)) {
                    return this.#error(400, `Invalid language '${transcription.language}'.`);
                }
            } else {
                const model = String(session.model);

                // An error that quotes the request back, headers and all.
                if (model === "quote-me") {
                    return this.#error(404, `No model quote-me for ${auth}.`, "model_not_found");
                }

                if (this.serverOnly.has(model)) {
                    return this.#error(403, "This model is not available with ephemeral keys.");
                }

                if (!this.live.has(model)) {
                    return this.#error(404, `The model \`${model}\` does not exist or you do not have access to it.`, "model_not_found");
                }

                if (audio?.output?.voice !== undefined && !this.voices.has(audio.output.voice)) {
                    return this.#error(400, `Invalid voice '${audio.output.voice}'.`);
                }
            }

            const value = `ek_test_${++this.#count}`;

            this.keys.set(value, session);

            return { status: 200, type: "application/json", body: JSON.stringify({ value, expires_at: Math.floor(Date.now() / 1000) + 60, session }) };
        }

        if (url.pathname === "/v1/realtime/calls" && request.method === "POST") {
            const key = auth.replace(/^Bearer /, "");

            if (!signedIn && !this.keys.has(key)) {
                return this.#error(401, "Bad key.");
            }

            if (signedIn && !this.serverOnly.has(url.searchParams.get("model") ?? "") && !this.live.has(url.searchParams.get("model") ?? "")) {
                return this.#error(404, "No such model.", "model_not_found");
            }

            const id = `rtc_test${++this.#count}`;

            this.calls.set(id, { by: signedIn ? "sign-in" : key, offer: body });

            return { status: 201, type: "application/sdp", body: ANSWER, location: `/v1/realtime/calls/${id}` };
        }

        if (url.pathname === "/backend-api/codex/realtime/calls" && request.method === "POST") {
            if (!signedIn || !this.codex) {
                return this.#error(401, "Not signed in to ChatGPT.");
            }

            return { status: 201, type: "application/sdp", body: ANSWER };
        }

        return this.#error(404, "Not here.");
    }

    async close(): Promise<void> {
        for (const side of this.sidebands.values()) {
            side.socket.terminate();
        }

        this.#sockets?.close();
        this.#server?.closeAllConnections();
        await new Promise<void>((resolve) => this.#server?.close(() => resolve()) ?? resolve());
    }
}
