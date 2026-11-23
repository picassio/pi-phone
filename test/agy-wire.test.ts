// Google Antigravity on the wire (PP-558, agy-wire.ts): requests go as agy 1.5.15's Go binary sends them, as measured on
// the owner's devbox on 2026-11-23: HTTP/1.1, Go's headers in Go's order with no Connection header and the connection
// kept, its ClientHello as near as OpenSSL lets Node say it, and agy's background reads at agy's times, never its
// telemetry. Google is stood in for by local servers.
import assert from "node:assert/strict";
import type { Duplex } from "node:stream";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import https from "node:https";
import { gzipSync } from "node:zlib";
import { after, mock, test } from "node:test";
import { AGY_START, AgyBackground, agyAgent, agyTransport, goHeaders, parseAgyQuota } from "../src/server/agy-wire.ts";
import { antigravity, type AgySend } from "../src/server/antigravity.ts";
import { type OAuthCredential } from "@earendil-works/pi-ai";

const UA = "antigravity/cli/1.5.15 (aidev_client; os_type=linux; arch=amd64; cl=1027820220; auth_method=consumer)";
const credential: OAuthCredential = {
    type: "oauth",
    access: "ya29.live",
    refresh: "1//kept-refresh",
    expires: Date.now() + 3_000_000,
    projectId: "aicode-consumers",
    osType: "linux",
    arch: "amd64",
    authMethod: "consumer",
};
const servers: { close(): unknown }[] = [];

after(() => servers.forEach((server) => server.close()));

/** A local TCP server; `handle` gets each connection. */
async function listen(handle: (socket: Socket) => void): Promise<number> {
    const server = createServer(handle);

    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return (server.address() as AddressInfo).port;
}

test("Go's headers: Host, User-Agent, Content-Length, the rest by name, Accept-Encoding last; Go's own User-Agent when none", () => {
    assert.deepEqual(
        Object.entries(goHeaders("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", { "User-Agent": UA, "Content-Type": "application/json", Authorization: "Bearer t" }, "{}")),
        [
            ["Host", "daily-cloudcode-pa.googleapis.com"],
            ["User-Agent", UA],
            ["Content-Length", "2"],
            ["Authorization", "Bearer t"],
            ["Content-Type", "application/json"],
            ["Accept-Encoding", "gzip"],
        ],
    );
    assert.deepEqual(Object.entries(goHeaders("https://www.googleapis.com/oauth2/v2/userinfo", { Authorization: "Bearer t" })), [
        ["Host", "www.googleapis.com"],
        ["User-Agent", "Go-http-client/1.1"],
        ["Authorization", "Bearer t"],
        ["Accept-Encoding", "gzip"],
    ]);
    assert.equal(goHeaders("https://x.test/", {}, "héllo")["Content-Length"], "6", "bytes, not characters");
});

test("on the wire: HTTP/1.1, the headers exactly as Go writes them and no Connection header, one connection kept for the next request, gzip read", async () => {
    const heads: string[][] = [];
    let connections = 0;
    const port = await listen((socket) => {
        connections += 1;
        let buffer = Buffer.alloc(0);

        socket.on("data", (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);

            for (;;) {
                const end = buffer.indexOf("\r\n\r\n");

                if (end < 0) {
                    return;
                }

                const lines = buffer.subarray(0, end).toString("latin1").split("\r\n");
                const length = Number(lines.find((line) => line.startsWith("Content-Length: "))?.slice(16) ?? 0);

                if (buffer.length < end + 4 + length) {
                    return;
                }

                heads.push(lines);
                buffer = buffer.subarray(end + 4 + length);
                const body = gzipSync(lines[0]!.includes("/token") ? JSON.stringify({ access_token: "ya29.renewed", expires_in: 3599 }) : JSON.stringify({ models: {} }));

                socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nContent-Length: ${body.length}\r\n\r\n`);
                socket.write(body);
            }
        });
    });
    // Every host's connection goes to the local server, in plain text, so its bytes can be read.
    const agent = new (class extends https.Agent {
        override createConnection(): Duplex {
            return connect(port, "127.0.0.1");
        }
    })({ keepAlive: true });
    const { provider } = antigravity({ send: agyTransport(agent) });
    const renewed = await provider.auth.oauth!.refresh(credential, new AbortController().signal);

    assert.equal(renewed.access, "ya29.renewed", "the gzipped answer read");
    const auth = await provider.auth.oauth!.toAuth(credential);

    assert.ok(auth.apiKey);
    await provider.refreshModels!({ credential, allowNetwork: true, signal: new AbortController().signal, publish: async () => true });
    await provider.refreshModels!({ credential, allowNetwork: true, signal: new AbortController().signal, publish: async () => true });

    const token = heads[0]!;

    assert.equal(token[0], "POST /token HTTP/1.1");
    assert.deepEqual(
        token.slice(1).map((line) => line.split(":")[0]),
        ["Host", "User-Agent", "Content-Length", "Content-Type", "Accept-Encoding"],
    );
    assert.deepEqual(token.slice(1, 3), ["Host: oauth2.googleapis.com", "User-Agent: Go-http-client/1.1"]);
    const models = heads[1]!;

    assert.equal(models[0], "POST /v1internal:fetchAvailableModels HTTP/1.1");
    assert.deepEqual(models.slice(1), [
        "Host: daily-cloudcode-pa.googleapis.com",
        `User-Agent: ${UA}`,
        'Content-Length: 30',
        "Authorization: Bearer ya29.live",
        "Content-Type: application/json",
        "Accept-Encoding: gzip",
    ]);
    assert.deepEqual(heads[2], models, "the next request the same");
    assert.equal(heads.flat().some((line) => /^connection:/i.test(line)), false, "Go sends no Connection header");
    // One connection per host, kept: the token's, and the one both model requests went on.
    assert.equal(connections, 2);
    agent.destroy();
});

/** The fields of a TLS ClientHello that make its fingerprint. */
function parseHello(bytes: Buffer) {
    const u16 = (at: number) => bytes.readUInt16BE(at);
    let at = 5 + 4 + 2 + 32;

    at += 1 + bytes[at]!;
    const ciphers: number[] = [];

    for (let end = at + 2 + u16(at), each = at + 2; each < end; each += 2) {
        ciphers.push(u16(each));
    }

    at += 2 + u16(at);
    at += 1 + bytes[at]!;
    const extensions: number[] = [];
    const hello = { ciphers, extensions, groups: [] as number[], keyShares: [] as number[], sigalgs: [] as number[], alpn: [] as string[], versions: [] as number[] };
    const list16 = (from: number) => Array.from({ length: u16(from) / 2 }, (_, index) => u16(from + 2 + index * 2));

    for (let end = at + 2 + u16(at), each = at + 2; each < end; ) {
        const type = u16(each);
        const body = each + 4;

        extensions.push(type);

        if (type === 10) {
            hello.groups = list16(body);
        } else if (type === 13) {
            hello.sigalgs = list16(body);
        } else if (type === 43) {
            hello.versions = Array.from({ length: bytes[body]! / 2 }, (_, index) => u16(body + 1 + index * 2));
        } else if (type === 16) {
            for (let name = body + 2; name < body + 2 + u16(body); name += 1 + bytes[name]!) {
                hello.alpn.push(bytes.subarray(name + 1, name + 1 + bytes[name]!).toString());
            }
        } else if (type === 51) {
            for (let share = body + 2; share < body + 2 + u16(body); share += 4 + u16(share + 2)) {
                hello.keyShares.push(u16(share));
            }
        }

        each = body + u16(each + 2);
    }

    return hello;
}

/** agy 1.5.15's ClientHello to daily-cloudcode-pa.googleapis.com, read on the devbox on 2026-11-23. */
const GO_HELLO = {
    ciphers: [0xc02b, 0xc02f, 0xc02c, 0xc030, 0xcca9, 0xcca8, 0xc009, 0xc013, 0xc00a, 0xc014, 0x1301, 0x1302, 0x1303],
    extensions: [0, 11, 65281, 23, 18, 5, 10, 13, 50, 16, 43, 51],
    groups: [0x11ec, 0x11eb, 0x11ed, 29, 23, 24, 25],
    keyShares: [0x11ec, 29],
    sigalgs: [0x0904, 0x0905, 0x0906, 0x0804, 0x0403, 0x0807, 0x0805, 0x0806, 0x0401, 0x0501, 0x0601, 0x0503, 0x0603],
    alpn: ["http/1.1"],
    versions: [0x0304, 0x0303],
};

test("TLS: agy's cipher suites (Go's order within each version), groups, key shares, signature algorithms, ALPN and versions; its extensions but for what OpenSSL decides", async () => {
    const hello = await new Promise<Buffer>((resolve) => {
        void listen((socket) => {
            let bytes = Buffer.alloc(0);

            socket.on("data", (chunk: Buffer) => {
                bytes = Buffer.concat([bytes, chunk]);

                if (bytes.length >= 5 && bytes.length >= 5 + bytes.readUInt16BE(3)) {
                    resolve(bytes);
                    socket.destroy();
                }
            });
        }).then((port) => {
            const agent = agyAgent({ proxyEnv: {} });
            const tlsConnection = agent.createConnection.bind(agent);

            agent.createConnection = (options, callback) => tlsConnection({ ...options, host: "127.0.0.1", port }, callback);
            void agyTransport(agent)("https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist", { headers: {}, body: "{}" }).catch(() => {});
        });
    });
    const node = parseHello(hello);
    const tls12 = (list: number[]) => list.filter((each) => each >> 8 !== 0x13);

    assert.deepEqual([...node.ciphers].sort(), [...GO_HELLO.ciphers].sort(), "the same suites, no others");
    assert.deepEqual(tls12(node.ciphers), tls12(GO_HELLO.ciphers), "TLS 1.2's in Go's order");
    assert.deepEqual(node.groups, GO_HELLO.groups);
    assert.deepEqual(node.keyShares, GO_HELLO.keyShares);
    assert.deepEqual(node.sigalgs, GO_HELLO.sigalgs);
    assert.deepEqual(node.alpn, GO_HELLO.alpn);
    assert.deepEqual(node.versions, GO_HELLO.versions);
    // Go's extensions that OpenSSL can send are sent (status_request asked for); none it never sends (session ticket,
    // encrypt-then-MAC, a pre-shared key from an earlier connection). Left to OpenSSL: the order, SCT and
    // signature_algorithms_cert (never sent), psk_key_exchange_modes (always sent).
    const unreachable = new Set([18, 50]);

    assert.deepEqual(
        GO_HELLO.extensions.filter((each) => !unreachable.has(each)).filter((each) => !node.extensions.includes(each)),
        [],
    );
    assert.deepEqual(node.extensions.filter((each) => !GO_HELLO.extensions.includes(each)), [45]);
});

/** Google's quota answer (texts cut). */
const QUOTA = {
    groups: [
        {
            displayName: "Gemini Models",
            buckets: [
                { window: "weekly", resetTime: "2026-11-28T10:39:15Z", remainingFraction: 0.25 },
                { window: "5h", resetTime: "2026-11-23T13:12:05Z" },
            ],
        },
        { displayName: "Gemini 4 Argon", buckets: [{ window: "weekly", resetTime: "2026-11-28T16:57:20Z", remainingFraction: 0.826786 }] },
    ],
};

test("the quota as usage bars: each group's windows, the share used and the reset; another shape is an error", () => {
    assert.deepEqual(parseAgyQuota(QUOTA), [
        { label: "Weekly", usedPercent: 75, resetsAt: Date.parse("2026-11-28T10:39:15Z"), group: "Gemini Models" },
        { label: "5-hour", usedPercent: 0, resetsAt: Date.parse("2026-11-23T13:12:05Z"), group: "Gemini Models" },
        { label: "Weekly", usedPercent: (1 - 0.826786) * 100, resetsAt: Date.parse("2026-11-28T16:57:20Z"), group: "Gemini 4 Argon" },
    ]);
    assert.throws(() => parseAgyQuota({}), /no quota groups/);
    assert.throws(() => parseAgyQuota({ groups: [{ buckets: [{ window: "5h", remainingFraction: "x" }] }] }), /not a number/);
});

/** agy 1.5.15's reads when it starts, in its order (mitmproxy on the devbox, 2026-11-23; its picture and gstatic's lists left out). */
const MEASURED_START = [
    "userinfo",
    "loadCodeAssist",
    "fetchAdminControls",
    "fetchUserInfo",
    "retrieveUserQuotaSummary",
    "fetchAvailableModels",
    "listExperiments",
    "fetchConfig",
    "fetchConfig",
    "loadCodeAssist",
    "retrieveUserQuotaSummary",
    "userinfo",
    "cascadeNuxes",
    "loadCodeAssist",
    "fetchUserInfo",
    "retrieveUserQuotaSummary",
    "loadCodeAssist",
    "retrieveUserQuotaSummary",
];

const flush = async () => {
    for (let round = 0; round < 20; round += 1) {
        await new Promise((resolve) => setImmediate(resolve));
    }
};

test("agy's background reads at agy's times: its start before the first turn, config each minute, project and models each six, the quota after a turn at most once a minute, user info at a new conversation; none after 30 idle minutes", async () => {
    mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: Date.parse("2026-11-23T13:00:00Z") });

    try {
        const reads: string[] = [];
        const background = new AgyBackground<string>({
            read: async (_provider, _auth, read) => {
                reads.push(read);

                return read === "retrieveUserQuotaSummary" ? QUOTA : read === "loadCodeAssist" ? { paidTier: { name: "Google AI Pro" } } : {};
            },
            auth: async () => "signed-in",
            log: () => {},
        });
        const take = () => reads.splice(0);
        const P = "google-antigravity";

        assert.deepEqual(AGY_START, MEASURED_START);
        await background.beforeTurn(P, "signed-in", "session-1");
        assert.deepEqual(take(), [...MEASURED_START, "fetchUserInfo"]);
        background.afterTurn(P);
        await flush();
        assert.deepEqual(take(), [], "the quota was read under a minute ago");

        // A second turn of the same conversation: nothing before it.
        await background.beforeTurn(P, "signed-in", "session-1");
        assert.deepEqual(take(), []);

        mock.timers.tick(60_000);
        await flush();
        assert.deepEqual(take(), ["fetchConfig"]);
        background.afterTurn(P);
        await flush();
        assert.deepEqual(take(), ["retrieveUserQuotaSummary"]);

        // Another conversation: its user info first.
        await background.beforeTurn(P, "signed-in", "session-2");
        assert.deepEqual(take(), ["fetchUserInfo"]);

        for (let minute = 2; minute <= 6; minute += 1) {
            mock.timers.tick(60_000);
            await flush();
        }

        assert.deepEqual(take(), ["fetchConfig", "fetchConfig", "fetchConfig", "fetchConfig", "fetchConfig", "loadCodeAssist", "fetchAvailableModels"]);
        assert.deepEqual(await background.usage(P), { windows: parseAgyQuota(QUOTA), plan: "Google AI Pro" });
        assert.deepEqual(take(), [], "the bars read what agy last read");

        // Half an hour with no turn: agy is closed.
        mock.timers.tick(30 * 60_000);
        await flush();
        assert.equal(background.running(P), false);
        take();
        mock.timers.tick(10 * 60_000);
        await flush();
        assert.deepEqual(take(), []);

        // Asking for the bars then starts agy again, as opening it would.
        await background.usage(P);
        assert.deepEqual(take(), MEASURED_START);
        background.stop();
    } finally {
        mock.timers.reset();
    }
});

test("only Google's API hosts agy reads, never its telemetry (Clearcut, cclog) nor its writes; each background read with agy's headers", async () => {
    const sent: { url: string; method: string; headers: Record<string, string> }[] = [];
    const send: AgySend = async (url, init) => {
        sent.push({ url, method: init.method ?? "POST", headers: init.headers });
        const body = url.includes("streamGenerateContent")
            ? `data: ${JSON.stringify({ response: { candidates: [{ content: { role: "model", parts: [{ text: "pong" }] }, finishReason: "STOP" }] } })}\n\n`
            : url.includes("fetchAvailableModels")
              ? JSON.stringify({ models: { "gemini-3.8-flash-low": { thinkingLevel: 1, maxOutputTokens: 100, modelProvider: "MODEL_PROVIDER_GOOGLE" } }, groupedModels: { "gemini-3.8-flash": { supportedThinkingLevels: [{ thinkingSuffix: "low" }] } }, agentModelSorts: [{ groups: [{ modelIds: ["gemini-3.8-flash-low"] }] }] })
              : url.includes("retrieveUserQuotaSummary")
                ? JSON.stringify(QUOTA)
                : "{}";

        return { status: 200, headers: new Headers(), body: (async function* () { yield new TextEncoder().encode(body); })() };
    };
    const { provider, background } = antigravity({ send });
    const auth = await provider.auth.oauth!.toAuth(credential);
    const model = { id: "gemini-3.8-flash", name: "Flash", api: "google-antigravity", provider: "google-antigravity", baseUrl: "", reasoning: true, thinkingLevelMap: { off: null, low: "low" }, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 } as const;
    const answer = await provider.streamSimple(model as never, { messages: [{ role: "user", content: "ping", timestamp: Date.now() }] } as never, { apiKey: auth.apiKey, reasoning: "low", sessionId: "s" }).result();

    background.stop();
    assert.equal(answer.stopReason, "stop", answer.errorMessage ?? "");
    const hosts = new Set(sent.map((each) => new URL(each.url).host));

    assert.deepEqual([...hosts].sort(), ["aicode.googleapis.com", "daily-cloudcode-pa.googleapis.com", "www.googleapis.com"]);
    assert.equal(sent.some((each) => /play\.googleapis\.com|cclog|writeTrajectoryAcls|:log\b/.test(each.url)), false);
    const generate = sent.findIndex((each) => each.url.includes("streamGenerateContent"));

    assert.equal(generate, MEASURED_START.length + 1, "agy's start, the conversation's user info, then the turn");
    const userinfo = sent.find((each) => each.url === "https://www.googleapis.com/oauth2/v2/userinfo")!;

    assert.deepEqual(Object.entries(userinfo.headers), [
        ["Host", "www.googleapis.com"],
        ["User-Agent", "Go-http-client/1.1"],
        ["Authorization", "Bearer ya29.live"],
        ["Accept-Encoding", "gzip"],
    ]);
    const config = sent.find((each) => each.url === "https://aicode.googleapis.com/v1alpha:fetchConfig")!;

    assert.equal(config.method, "GET");
    assert.deepEqual(Object.keys(config.headers), ["Host", "User-Agent", "Authorization", "Accept-Encoding"]);
    assert.equal(config.headers["User-Agent"], UA);
    assert.ok(sent.some((each) => each.url === "https://daily-cloudcode-pa.googleapis.com/v1internal/cascadeNuxes?page_size=1000" && each.method === "GET"));
});
