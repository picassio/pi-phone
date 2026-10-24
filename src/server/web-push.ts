/**
 * Push notifications for the web UI (PP-127): what the Android app's notifications say (`phone-events.ts`), sent to the
 * browsers that turned them on (the team server, an iPhone's Home Screen app, a desktop), even with no tab open.
 *
 * Web Push itself, with `node:crypto` and nothing else: the payload encrypted as `aes128gcm` (RFC 8291, its Appendix A in
 * `test/web-push.test.ts`), and the app server named by a VAPID token (RFC 8292, ES256). This pi-phone makes its own key
 * pair on first use and keeps it, with the subscriptions, in `web-push.json` in its data folder (mode 600): nobody sets
 * anything. A push service that answers 404 or 410 says the subscription is gone: it is forgotten.
 */
import { createCipheriv, createECDH, createHash, createHmac, createPrivateKey, randomBytes, sign, type ECDH } from "node:crypto";
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

/** One browser that turned notifications on. */
export type PushSubscriptionRecord = {
    /** From the endpoint: the same browser subscribing again keeps its id. */
    id: string;
    endpoint: string;
    /** The browser's ECDH public key (65 bytes, uncompressed) and authentication secret (16 bytes), base64url. */
    p256dh: string;
    auth: string;
    /** "Chrome on Windows": from the browser that turned them on. */
    name: string;
    /** The browser's language (`navigator.language`): what is said in it when its person's choice is Auto. */
    language?: string;
    /** The browser's time zone (IANA, as `Intl` reports it): a time in a notification is said in it (PP-135). */
    zone?: string;
    /** The app's address it was turned on at (`https://host`): the VAPID token's `sub`. */
    origin: string;
    createdAt: number;
    lastSentAt?: number;
    /** Why the last push did not go, until one does. */
    lastError?: string;
};

/** What a notification says, and where its tap goes. */
export type PushMessage = {
    title: string;
    body: string;
    /** The app's own path to open: `/s/<id>`, or `/`. */
    url: string;
    /** Notifications with the same tag replace each other: one per session. */
    tag: string;
    urgency?: "normal" | "high";
};

type Stored = { publicKey: string; privateKey: string; subscriptions: PushSubscriptionRecord[] };

/** A push service accepts at most 4096 octets of body: header (86) and tag (16) and delimiter (1) leave 3993. */
const MAX_PLAINTEXT = 3993;
/** How long a push service keeps a message for a browser that is away. */
const TTL_SECONDS = 24 * 60 * 60;
/** VAPID tokens may last at most 24 hours; 12 is the usual. */
const TOKEN_SECONDS = 12 * 60 * 60;

const b64u = (bytes: Buffer): string => bytes.toString("base64url");
const fromB64u = (text: string): Buffer => Buffer.from(text, "base64url");
const hmac = (key: Buffer, data: Buffer): Buffer => createHmac("sha256", key).update(data).digest();

/**
 * A push message's body (RFC 8291): `plaintext` encrypted for the browser's key `uaPublic` and secret `authSecret`, as
 * one `aes128gcm` record with its header (salt, record size 4096, and the sender's one-off public key). `sender` fixes
 * the one-off key and the salt, for the RFC's example; otherwise both are new each time.
 */
export function encryptPayload(plaintext: Buffer, uaPublic: Buffer, authSecret: Buffer, sender: { ecdh?: ECDH; salt?: Buffer } = {}): Buffer {
    if (plaintext.length > MAX_PLAINTEXT) {
        throw new Error(`A push message holds at most ${MAX_PLAINTEXT} bytes; this one has ${plaintext.length}.`);
    }

    if (uaPublic.length !== 65 || uaPublic[0] !== 4 || authSecret.length !== 16) {
        throw new Error("The browser's push keys are not a P-256 public key and a 16-byte secret.");
    }

    let ecdh = sender.ecdh;

    if (ecdh === undefined) {
        ecdh = createECDH("prime256v1");
        ecdh.generateKeys();
    }

    const asPublic = ecdh.getPublicKey();
    // Throws for a point not on the curve (RFC 8291, section 7).
    const ecdhSecret = ecdh.computeSecret(uaPublic);
    const salt = sender.salt ?? randomBytes(16);
    const prkKey = hmac(authSecret, ecdhSecret);
    const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0", "latin1"), uaPublic, asPublic]);
    const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01", "latin1")).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01", "latin1")).subarray(0, 12);
    const cipher = createCipheriv("aes-128-gcm", cek, nonce);
    // The padding delimiter of the last (only) record, and no padding.
    const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(21);

    salt.copy(header, 0);
    header.writeUInt32BE(4096, 16);
    header.writeUInt8(asPublic.length, 20);

    return Buffer.concat([header, asPublic, sealed]);
}

/**
 * The `Authorization` header that names this app server to a push service (RFC 8292): a VAPID token for the endpoint's
 * origin, signed with `privateKey` (the 32-byte P-256 scalar), and the matching `publicKey` (65 bytes).
 */
export function vapidAuthorization(endpoint: string, subject: string, keys: { publicKey: Buffer; privateKey: Buffer }, now: number): string {
    const header = b64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
    const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + TOKEN_SECONDS, sub: subject })));
    const key = createPrivateKey({
        key: { kty: "EC", crv: "P-256", d: b64u(keys.privateKey), x: b64u(keys.publicKey.subarray(1, 33)), y: b64u(keys.publicKey.subarray(33, 65)) },
        format: "jwk",
    });
    const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });

    return `vapid t=${header}.${claims}.${b64u(signature)}, k=${b64u(keys.publicKey)}`;
}

/** Where a push service may be: HTTPS, or this machine (tests' own push service). */
/** A time zone `Intl` knows (`Asia/Saigon`); any other is refused, as the browser's own always is one. */
function knownZone(zone: string): string {
    try {
        return new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions().timeZone;
    } catch {
        throw new Error(`The time zone ${zone.slice(0, 60)} is not one this server knows.`);
    }
}

function pushAddress(endpoint: unknown): string {
    if (typeof endpoint !== "string" || endpoint.length > 2000) {
        throw new Error("The subscription has no push service address.");
    }

    const url = new URL(endpoint);

    if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"))) {
        throw new Error("A push service is reached over HTTPS.");
    }

    return url.href;
}

export class WebPush {
    readonly #file: string;
    readonly #fetch: typeof fetch;
    readonly #now: () => number;
    readonly #log: (line: string) => void;
    #stored: Stored | undefined;

    constructor(options: { file: string; fetch?: typeof fetch; now?: () => number; log: (line: string) => void }) {
        this.#file = options.file;
        this.#fetch = options.fetch ?? fetch;
        this.#now = options.now ?? Date.now;
        this.#log = options.log;
    }

    /** What is kept: read once, and the key pair made on first use. */
    #data(): Stored {
        if (this.#stored !== undefined) {
            return this.#stored;
        }

        if (existsSync(this.#file)) {
            this.#stored = JSON.parse(readFileSync(this.#file, "utf8")) as Stored;
        } else {
            const ecdh = createECDH("prime256v1");

            ecdh.generateKeys();
            this.#stored = { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()), subscriptions: [] };
            this.#save();
        }

        return this.#stored;
    }

    #save(): void {
        const temporary = `${this.#file}.tmp`;

        writeFileSync(temporary, JSON.stringify(this.#stored), { mode: 0o600 });
        chmodSync(temporary, 0o600);
        renameSync(temporary, this.#file);
    }

    /** The key browsers subscribe with (`applicationServerKey`), base64url. */
    publicKey(): string {
        return this.#data().publicKey;
    }

    list(): readonly PushSubscriptionRecord[] {
        return this.#data().subscriptions;
    }

    /** A browser turned notifications on (or again): kept by its endpoint. */
    subscribe(subscription: unknown, about: { name: string; language?: string; zone?: string; origin: string }): PushSubscriptionRecord {
        const given = (subscription ?? {}) as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
        const endpoint = pushAddress(given.endpoint);
        const p256dh = typeof given.keys?.p256dh === "string" ? fromB64u(given.keys.p256dh) : Buffer.alloc(0);
        const auth = typeof given.keys?.auth === "string" ? fromB64u(given.keys.auth) : Buffer.alloc(0);

        if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
            throw new Error("The subscription's keys are not a P-256 public key and a 16-byte secret.");
        }

        // The key must be a point on the curve: a test agreement throws otherwise.
        const probe = createECDH("prime256v1");

        probe.generateKeys();
        probe.computeSecret(p256dh);

        const record: PushSubscriptionRecord = {
            id: createHash("sha256").update(endpoint).digest("hex").slice(0, 16),
            endpoint,
            p256dh: b64u(p256dh),
            auth: b64u(auth),
            name: about.name,
            ...(about.language === undefined || about.language === "" ? {} : { language: about.language.slice(0, 35) }),
            ...(about.zone === undefined ? {} : { zone: knownZone(about.zone) }),
            origin: new URL(about.origin).origin,
            createdAt: this.#now(),
        };
        const data = this.#data();

        data.subscriptions = [...data.subscriptions.filter((each) => each.id !== record.id), record];
        this.#save();

        return record;
    }

    /** Forget a browser's subscription; whether there was one. */
    remove(id: string): boolean {
        const data = this.#data();
        const before = data.subscriptions.length;

        data.subscriptions = data.subscriptions.filter((each) => each.id !== id);

        if (data.subscriptions.length !== before) {
            this.#save();
        }

        return data.subscriptions.length !== before;
    }

    /** Send one notification to one browser: sent, gone (forgotten now), or failed (kept, with why). */
    async send(record: PushSubscriptionRecord, message: PushMessage): Promise<"sent" | "gone" | "failed"> {
        const data = this.#data();
        const keys = { publicKey: fromB64u(data.publicKey), privateKey: fromB64u(data.privateKey) };
        const limited = { ...message, body: message.body.length > 1500 ? `${message.body.slice(0, 1499)}…` : message.body };
        let outcome: "sent" | "gone" | "failed";
        let error: string | undefined;

        try {
            const body = encryptPayload(Buffer.from(JSON.stringify(limited)), fromB64u(record.p256dh), fromB64u(record.auth));
            const answer = await this.#fetch(record.endpoint, {
                method: "POST",
                headers: {
                    authorization: vapidAuthorization(record.endpoint, record.origin, keys, this.#now()),
                    "content-encoding": "aes128gcm",
                    "content-type": "application/octet-stream",
                    ttl: String(TTL_SECONDS),
                    urgency: message.urgency ?? "normal",
                    // A newer message for the same session replaces one the browser has not taken yet.
                    topic: createHash("sha256").update(message.tag).digest("base64url").slice(0, 32),
                },
                body: new Uint8Array(body),
                signal: AbortSignal.timeout(20_000),
            });

            outcome = answer.ok ? "sent" : answer.status === 404 || answer.status === 410 ? "gone" : "failed";

            if (!answer.ok) {
                error = `the push service answered ${answer.status} ${(await answer.text().catch(() => "")).slice(0, 200)}`.trim();
            }
        } catch (thrown) {
            outcome = "failed";
            error = thrown instanceof Error ? thrown.message : String(thrown);
        }

        if (outcome === "gone") {
            this.remove(record.id);
            this.#log(`push: ${record.name}'s notifications ended (${error ?? "gone"}): forgotten`);

            return outcome;
        }

        const kept = data.subscriptions.find((each) => each.id === record.id);

        if (kept !== undefined) {
            if (outcome === "sent") {
                kept.lastSentAt = this.#now();
                delete kept.lastError;
            } else {
                kept.lastError = error ?? "failed";
                this.#log(`push to ${record.name} failed: ${kept.lastError}`);
            }

            this.#save();
        }

        return outcome;
    }
}
