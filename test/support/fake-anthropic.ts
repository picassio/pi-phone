// A fake Anthropic Messages API over real HTTP, for the limit tests (PP-135): each request gets what `reply` says, a
// streamed answer or a refusal with its status, headers, and body, as the provider sends them. The provider built on it
// is pi-ai's own Anthropic provider with one model whose address is this server, signed in with a subscription
// (OAuth) sign-in kept in Pi's auth.json, so pi-phone's usage bars count it.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Api, Model, OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

export type FakeReply = { text: string } | { status: number; headers?: Record<string, string>; type?: string; message?: string };

/** A request the fake provider got: which sign-in it came with (its token), and its path. */
export type FakeCall = { token: string; path: string; at: number };

export const MODEL_ID = "claude-test";

/** A 429 of Claude's 5-hour window, resetting at `resetAt` (ms), as Anthropic sends it to a subscription. */
export const fiveHourLimit = (resetAt: number): FakeReply => ({
    status: 429,
    headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-status": "rejected",
        "anthropic-ratelimit-unified-5h-reset": String(Math.ceil(resetAt / 1000)),
        "anthropic-ratelimit-unified-reset": String(Math.ceil(resetAt / 1000)),
    },
    type: "rate_limit_error",
    message: "This request would exceed your account's rate limit. Please try again later.",
});

/** A 429 of Claude's 7-day window, days away. */
export const weeklyLimit = (resetAt: number): FakeReply => ({
    status: 429,
    headers: {
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-7d-status": "rejected",
        "anthropic-ratelimit-unified-7d-reset": String(Math.ceil(resetAt / 1000)),
    },
    type: "rate_limit_error",
    message: "This request would exceed your account's rate limit. Please try again later.",
});

export const overloaded: FakeReply = { status: 529, type: "overloaded_error", message: "Overloaded" };
/** A 429 with nothing that says when. */
export const plainLimit: FakeReply = { status: 429, type: "rate_limit_error", message: "Rate limited." };

function sse(response: ServerResponse, text: string): void {
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    send("message_start", {
        type: "message_start",
        message: { id: "msg_test", type: "message", role: "assistant", model: MODEL_ID, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } },
    });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
    send("message_stop", { type: "message_stop" });
    response.end();
}

/** The fake provider's server: `reply` answers each request (its token, and how many came before). */
export async function fakeAnthropic(reply: (token: string, call: number) => FakeReply) {
    const calls: FakeCall[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
        let body = "";

        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            const token = String(request.headers["x-api-key"] ?? request.headers.authorization ?? "").replace(/^Bearer /, "");

            calls.push({ token, path: request.url ?? "", at: Date.now() });

            const answer = reply(token, calls.length - 1);

            if ("text" in answer) {
                sse(response, answer.text);

                return;
            }

            response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
            response.end(JSON.stringify({ type: "error", error: { type: answer.type ?? "api_error", message: answer.message ?? "error" } }));
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    return {
        url,
        calls,
        close: () => {
            server.closeAllConnections();
            server.close();
        },
    };
}

/**
 * pi-ai's Anthropic provider with one model at `url`, signed in by a subscription (OAuth) whose access token is the
 * request's key: the fake server tells accounts apart by it. `id`: another provider id than Anthropic's own, for the
 * team server's tests (its subscription bases are pi-ai's real ones).
 */
export function localAnthropic(url: string, id = "anthropic"): Provider {
    const base = anthropicProvider() as unknown as Provider;
    const template = base.getModels()[0] as Model<Api>;
    const model = { ...template, id: MODEL_ID, name: "Claude Test", baseUrl: url, provider: id } as Model<Api>;

    return {
        ...base,
        id,
        auth: {
            // A key too, as the team server signs its accounts in with one in the tests.
            ...(base.auth.apiKey === undefined ? {} : { apiKey: base.auth.apiKey }),
            oauth: {
                name: "Claude (test)",
                login: async () => {
                    throw new Error("no sign-in in tests");
                },
                refresh: async (credential: OAuthCredential) => credential,
                toAuth: async (credential: OAuthCredential) => ({ apiKey: credential.access }),
            },
        },
        getModels: () => [model],
        getAllModels: () => [model],
    } as unknown as Provider;
}

/** Sign-ins as Pi's auth.json keeps them: an access token for each provider id, that does not run out. */
export function signIns(tokens: Record<string, string>): string {
    return JSON.stringify(
        Object.fromEntries(Object.entries(tokens).map(([id, access]) => [id, { type: "oauth", access, refresh: `refresh-${access}`, expires: Date.now() + 30 * 86_400_000 }])),
    );
}
