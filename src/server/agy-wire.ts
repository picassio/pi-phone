/**
 * How Google Antigravity's requests go on the wire (PP-558, under PP-555): as Google's `agy` CLI 1.5.15 sends them, a Go
 * 1.28 binary, measured on the owner's devbox on 2026-11-23 (a local proxy read agy's ClientHello inside each tunnel and
 * relayed the bytes unchanged; mitmproxy read the requests; wiki: resources/antigravity-agy-fingerprint).
 *
 * - HTTP/1.1, as agy speaks to `daily-cloudcode-pa`, `aicode`, `www.googleapis.com` and `oauth2.googleapis.com` (its
 *   ClientHello offers only `http/1.1` there; it speaks HTTP/2 only to Clearcut and gstatic, which this server never asks).
 * - Headers as Go's `net/http` writes them: `Host`, `User-Agent`, `Content-Length`, the rest by name, then the transport's
 *   `Accept-Encoding: gzip`; no `Connection` header, and the connection kept open. Node's own client (`node:https`) is
 *   used, not undici, which writes `connection: keep-alive` first and `content-length` last whatever it is given.
 * - TLS as close to Go's ClientHello as OpenSSL lets Node say it: the same cipher suites, groups (X25519MLKEM768 and
 *   X25519 key shares), signature algorithms, ALPN, status_request, no session ticket, no encrypt-then-MAC, no resumption.
 *   What OpenSSL does not let Node change stays Node's (DESIGN.md lists it): the TLS 1.3 suites come first, the extension
 *   order, `psk_key_exchange_modes` always sent, no `signed_certificate_timestamp` nor `signature_algorithms_cert`, and
 *   with OpenSSL 3.5 three EC point formats instead of one (the phone's OpenSSL 3.6 sends one, as Go).
 *
 * agy also reads in the background while it runs, and so does this server while the provider is in use (`AgyBackground`):
 * the reads agy makes when it starts, its config every minute, its project and models every six minutes, the account's
 * quota after a turn (at most once a minute; the Providers sheet's bars come from it), and its user info at a new
 * conversation's first turn. Only reads: agy's telemetry (Clearcut `play.googleapis.com/log`, the `cclog` scope) and its
 * writes (`writeTrajectoryAcls`) are never sent, since that would be made-up usage data in Google's systems.
 */
import { constants } from "node:crypto";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";

/** agy's ClientHello, in Node's TLS options (measured from agy 1.5.15, Go 1.28, 2026-11-23). */
export const AGY_TLS = {
    // Go's order: ECDHE GCM, ChaCha20, then CBC; OpenSSL puts the TLS 1.3 suites first whatever the order given.
    ciphers: [
        "TLS_AES_128_GCM_SHA256",
        "TLS_AES_256_GCM_SHA384",
        "TLS_CHACHA20_POLY1305_SHA256",
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
        "ECDHE-ECDSA-CHACHA20-POLY1305",
        "ECDHE-RSA-CHACHA20-POLY1305",
        "ECDHE-ECDSA-AES128-SHA",
        "ECDHE-RSA-AES128-SHA",
        "ECDHE-ECDSA-AES256-SHA",
        "ECDHE-RSA-AES256-SHA",
    ].join(":"),
    // `*` marks the groups with a key share, as Go sends them: X25519MLKEM768 and X25519.
    ecdhCurve: "*X25519MLKEM768:SecP256r1MLKEM768:SecP384r1MLKEM1024:*X25519:P-256:P-384:P-521",
    sigalgs: [
        "mldsa44",
        "mldsa65",
        "mldsa87",
        "rsa_pss_rsae_sha256",
        "ecdsa_secp256r1_sha256",
        "ed25519",
        "rsa_pss_rsae_sha384",
        "rsa_pss_rsae_sha512",
        "rsa_pkcs1_sha256",
        "rsa_pkcs1_sha384",
        "rsa_pkcs1_sha512",
        "ecdsa_secp384r1_sha384",
        "ecdsa_secp521r1_sha512",
    ].join(":"),
    ALPNProtocols: ["http/1.1"],
    // Go asks for the OCSP staple (status_request).
    requestOCSP: true,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    // Go sends no session ticket extension and no encrypt-then-MAC.
    secureOptions: constants.SSL_OP_NO_TICKET | constants.SSL_OP_NO_ENCRYPT_THEN_MAC,
} as const satisfies https.AgentOptions;

/**
 * The agent agy's requests share: kept-alive connections as Go's transport keeps them, agy's TLS, no TLS resumption (Go
 * has no session cache unless given one), and the proxy the app is set to (Settings › Proxy, or the environment), as Go
 * reads `HTTPS_PROXY`.
 */
export function agyAgent(extra: https.AgentOptions = {}): https.Agent {
    return new https.Agent({ keepAlive: true, maxCachedSessions: 0, proxyEnv: process.env, ...AGY_TLS, ...extra });
}

/**
 * A request's headers as Go's `net/http` writes them: `Host`, `User-Agent` (Go's own when none), `Content-Length` when
 * there is a body, the others sorted by name, and `Accept-Encoding: gzip` last, which Go's transport adds.
 */
export function goHeaders(url: string, others: Record<string, string>, body?: string): Record<string, string> {
    const { "User-Agent": agent = "Go-http-client/1.1", ...rest } = others;
    const headers: Record<string, string> = { Host: new URL(url).host, "User-Agent": agent };

    if (body !== undefined) {
        headers["Content-Length"] = String(Buffer.byteLength(body));
    }

    for (const name of Object.keys(rest).sort()) {
        headers[name] = rest[name]!;
    }

    headers["Accept-Encoding"] = "gzip";

    return headers;
}

export interface WireResponse {
    status: number;
    headers: Headers;
    body: AsyncIterable<Uint8Array>;
}

export type WireRequest = { method?: "GET" | "POST"; headers: Record<string, string>; body?: string; signal?: AbortSignal };

/**
 * One request on agy's wire: the headers exactly as given (in their order, nothing added: `goHeaders` makes them), no
 * `Connection` header, the connection kept for the next one. The body is gunzipped when Google gzipped it, as Go does
 * for the `Accept-Encoding` it added.
 */
export function agyTransport(agent?: https.Agent): (url: string, init: WireRequest) => Promise<WireResponse> {
    let shared = agent;

    return (url, init) =>
        new Promise<WireResponse>((resolve, reject) => {
            // Made at the first request, after the app has set its proxy in the environment (`net.ts`).
            shared ??= agyAgent();
            const request = https.request(url, {
                agent: shared,
                method: init.method ?? "POST",
                headers: init.headers,
                setHost: false,
                ...(init.signal === undefined ? {} : { signal: init.signal }),
            });

            // Node writes `Connection: keep-alive` unless the header is removed; removed, it still keeps the connection.
            request.removeHeader("Connection");
            request.on("error", reject);
            request.on("response", (response: IncomingMessage) => {
                const headers = new Headers();

                for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
                    headers.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
                }

                const body: AsyncIterable<Uint8Array> = headers.get("content-encoding") === "gzip" ? pipeline(response, createGunzip(), () => {}) : response;

                resolve({ status: response.statusCode ?? 0, headers, body });
            });
            request.end(init.body);
        });
}

/** The reads agy makes in the background, by its methods' names (`userinfo` is Google's account endpoint). */
export type AgyRead =
    | "userinfo"
    | "loadCodeAssist"
    | "fetchAdminControls"
    | "fetchUserInfo"
    | "retrieveUserQuotaSummary"
    | "fetchAvailableModels"
    | "listExperiments"
    | "fetchConfig"
    | "cascadeNuxes";

/**
 * What agy 1.5.15 reads when it starts, in its order (its parts start together and some ask twice). Left out: the
 * account's picture (lh3.googleusercontent.com) and gstatic's plugin lists, which its screen draws.
 */
export const AGY_START: readonly AgyRead[] = [
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

/** What agy reads again while it runs, and how often (measured over 15 idle minutes). */
export const AGY_EVERY: readonly { ms: number; reads: readonly AgyRead[] }[] = [
    { ms: 60_000, reads: ["fetchConfig"] },
    { ms: 360_000, reads: ["loadCodeAssist", "fetchAvailableModels"] },
];

/** After a turn agy reads the quota again, unless it read it this recently. */
export const AGY_QUOTA_AFTER_MS = 60_000;
/** How long the background reads go on after the last turn, as if agy were closed then. */
export const AGY_IDLE_MS = 30 * 60_000;

/** A plan window as the usage bars show it (`usage-limits.ts`'s `UsageWindow`). */
export type AgyWindow = { label: string; usedPercent: number; resetsAt?: number; group?: string };

/**
 * `retrieveUserQuotaSummary`'s answer as usage bars: each group's buckets (`5h`, `weekly`), the share used
 * (1 − `remainingFraction`) and when it resets. Another shape is an error, never a guess.
 */
export function parseAgyQuota(json: unknown): AgyWindow[] {
    type Bucket = { window?: unknown; remainingFraction?: unknown; resetTime?: unknown };
    const groups = (json as { groups?: { displayName?: unknown; buckets?: Bucket[] }[] } | null)?.groups;

    if (!Array.isArray(groups)) {
        throw new Error("no quota groups in Antigravity's answer");
    }

    const windows: AgyWindow[] = [];

    for (const group of groups) {
        for (const bucket of group.buckets ?? []) {
            const label = bucket.window === "5h" ? "5-hour" : bucket.window === "weekly" ? "Weekly" : typeof bucket.window === "string" ? bucket.window : "Window";
            // A bucket with nothing used may leave its fraction out (protobuf's JSON drops a default).
            const left = bucket.remainingFraction === undefined ? 1 : bucket.remainingFraction;

            if (typeof left !== "number" || !Number.isFinite(left)) {
                throw new Error("a quota figure that is not a number");
            }

            const resetsAt = typeof bucket.resetTime === "string" ? Date.parse(bucket.resetTime) : Number.NaN;

            windows.push({
                label,
                usedPercent: Math.max(0, Math.min(100, (1 - left) * 100)),
                ...(Number.isNaN(resetsAt) ? {} : { resetsAt }),
                ...(typeof group.displayName === "string" ? { group: group.displayName } : {}),
            });
        }
    }

    if (windows.length === 0) {
        throw new Error("no quota windows in Antigravity's answer");
    }

    return windows;
}

export type AgyBackgroundDeps<Auth> = {
    /** One read with this sign-in; its answer, parsed. */
    read: (provider: string, auth: Auth, read: AgyRead) => Promise<unknown>;
    /** The sign-in now (renewed by Pi when it ends); undefined once signed out. */
    auth: (provider: string) => Promise<Auth | undefined>;
    log: (line: string) => void;
    /** The quota was read again: the usage bars ask for it. */
    quotaRead?: (provider: string) => void;
    now?: () => number;
};

type Live<Auth> = {
    auth: Auth;
    started: Promise<void>;
    lastTurn: number;
    quota?: { windows: AgyWindow[]; at: number } | { error: string; at: number };
    plan?: string;
    conversations: Set<string>;
    timers: ReturnType<typeof setInterval>[];
    idle?: ReturnType<typeof setTimeout>;
};

/**
 * agy's background reads for each signed-in account while it is in use: started by a turn (or by the usage bars asking),
 * stopped `AGY_IDLE_MS` after the last turn, as agy stops when it is closed. A read that fails is logged, and a turn goes
 * on: these reads tell the turn nothing it needs.
 */
export class AgyBackground<Auth> {
    readonly #deps: AgyBackgroundDeps<Auth>;
    readonly #now: () => number;
    readonly #live = new Map<string, Live<Auth>>();

    constructor(deps: AgyBackgroundDeps<Auth>) {
        this.#deps = deps;
        this.#now = deps.now ?? Date.now;
    }

    /** Whether agy would be running for this account now. */
    running(provider: string): boolean {
        return this.#live.has(provider);
    }

    /** Before a turn: agy's start when it is not running, and its user info at a conversation's first turn. */
    async beforeTurn(provider: string, auth: Auth, conversation: string | undefined): Promise<void> {
        const live = this.#start(provider, auth);

        live.auth = auth;
        live.lastTurn = this.#now();
        this.#idle(provider, live);
        await live.started;

        if (conversation !== undefined && !live.conversations.has(conversation)) {
            live.conversations.add(conversation);
            await this.#read(provider, live, "fetchUserInfo");
        }
    }

    /** After a turn: the quota again, unless read under a minute ago. */
    afterTurn(provider: string): void {
        const live = this.#live.get(provider);

        if (live === undefined || (live.quota !== undefined && this.#now() - live.quota.at < AGY_QUOTA_AFTER_MS)) {
            return;
        }

        live.lastTurn = this.#now();
        this.#idle(provider, live);
        void this.#read(provider, live, "retrieveUserQuotaSummary");
    }

    /**
     * The account's quota as agy last read it, and its plan. When agy is not running for it, it starts (its start reads
     * the quota), as opening agy to see the quota would.
     */
    async usage(provider: string): Promise<{ windows: AgyWindow[]; plan?: string }> {
        let live = this.#live.get(provider);

        if (live === undefined) {
            const auth = await this.#deps.auth(provider);

            if (auth === undefined) {
                throw new Error("not signed in");
            }

            live = this.#start(provider, auth);
            live.lastTurn = this.#now();
            this.#idle(provider, live);
        }

        await live.started;
        const quota = live.quota;

        if (quota === undefined) {
            throw new Error("Antigravity has not said its quota yet");
        }

        if ("error" in quota) {
            throw new Error(quota.error);
        }

        return { windows: quota.windows, ...(live.plan === undefined ? {} : { plan: live.plan }) };
    }

    /** Signed out, or the app closes: no more reads for it. */
    stop(provider?: string): void {
        for (const [id, live] of this.#live) {
            if (provider === undefined || id === provider) {
                live.timers.forEach(clearInterval);
                clearTimeout(live.idle);
                this.#live.delete(id);
            }
        }
    }

    #start(provider: string, auth: Auth): Live<Auth> {
        const running = this.#live.get(provider);

        if (running !== undefined) {
            return running;
        }

        const live: Live<Auth> = { auth, started: Promise.resolve(), lastTurn: this.#now(), conversations: new Set(), timers: [] };

        this.#live.set(provider, live);
        live.started = (async () => {
            for (const read of AGY_START) {
                await this.#read(provider, live, read);
            }
        })();

        for (const every of AGY_EVERY) {
            const timer = setInterval(() => void this.#tick(provider, live, every.reads), every.ms);

            timer.unref();
            live.timers.push(timer);
        }

        return live;
    }

    async #tick(provider: string, live: Live<Auth>, reads: readonly AgyRead[]): Promise<void> {
        const auth = await this.#deps.auth(provider).catch(() => undefined);

        if (auth === undefined || this.#live.get(provider) !== live) {
            this.stop(provider);

            return;
        }

        live.auth = auth;

        for (const read of reads) {
            await this.#read(provider, live, read);
        }
    }

    #idle(provider: string, live: Live<Auth>): void {
        clearTimeout(live.idle);
        live.idle = setTimeout(() => {
            if (this.#live.get(provider) === live) {
                this.stop(provider);
            }
        }, AGY_IDLE_MS);
        live.idle.unref();
    }

    async #read(provider: string, live: Live<Auth>, read: AgyRead): Promise<void> {
        try {
            const answer = await this.#deps.read(provider, live.auth, read);

            if (read === "retrieveUserQuotaSummary") {
                live.quota = { windows: parseAgyQuota(answer), at: this.#now() };
                // Told once agy's start is over: the bars ask for its last figures, and asking waits for the start.
                void live.started.then(() => this.#deps.quotaRead?.(provider));
            } else if (read === "loadCodeAssist") {
                const tiers = answer as { paidTier?: { name?: unknown }; currentTier?: { name?: unknown } } | null;
                const plan = tiers?.paidTier?.name ?? tiers?.currentTier?.name;

                if (typeof plan === "string") {
                    live.plan = plan;
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (read === "retrieveUserQuotaSummary") {
                live.quota = { error: message, at: this.#now() };
            }

            this.#deps.log(`${provider}: background ${read} failed: ${message}`);
        }
    }
}
