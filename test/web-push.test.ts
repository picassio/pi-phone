// Web Push for the web UI (PP-127, `src/server/web-push.ts`): the payload encryption is RFC 8291's own example byte for
// byte; the VAPID token verifies with the public key; a push reaches a push service (one here) that decrypts it as a
// browser would; a gone subscription (404, 410) is forgotten; bad subscriptions are refused; the key file is private.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { encryptPayload, vapidAuthorization, WebPush } from "../src/server/web-push.ts";

after(cleanUp);

const b = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");

test("the payload is encrypted as RFC 8291's example, byte for byte", () => {
    const sender = createECDH("prime256v1");

    sender.setPrivateKey(b("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"));

    const body = encryptPayload(
        Buffer.from("When I grow up, I want to be a watermelon"),
        b("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
        b("BTBZMqHH6r4Tts7J_aSIgg"),
        { ecdh: sender, salt: b("DGv6ra1nlYgDCS1FRnbzlw") },
    );

    assert.equal(
        body.toString("base64url"),
        b(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
           mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
           pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`).toString("base64url"),
    );
});

test("the VAPID token names the push service's origin and verifies with the public key", () => {
    const pair = createECDH("prime256v1");

    pair.generateKeys();

    const now = Date.UTC(2026, 9, 23, 12);
    const header = vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", "https://team.example.test", { publicKey: pair.getPublicKey(), privateKey: pair.getPrivateKey() }, now);
    const [, token, key] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? assert.fail(header);
    const [head, claims, signature] = token!.split(".");

    assert.equal(key, pair.getPublicKey().toString("base64url"));
    assert.deepEqual(JSON.parse(Buffer.from(head!, "base64url").toString()), { typ: "JWT", alg: "ES256" });
    assert.deepEqual(JSON.parse(Buffer.from(claims!, "base64url").toString()), { aud: "https://fcm.googleapis.com", exp: now / 1000 + 12 * 3600, sub: "https://team.example.test" });

    const publicKey = createPublicKey({
        key: { kty: "EC", crv: "P-256", x: pair.getPublicKey().subarray(1, 33).toString("base64url"), y: pair.getPublicKey().subarray(33).toString("base64url") },
        format: "jwk",
    });

    assert.ok(verify("sha256", Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url")));
});

/** What a browser does with a push message's body: its own key and secret open it (RFC 8291, the user agent's side). */
function decrypt(body: Buffer, ua: ReturnType<typeof createECDH>, auth: Buffer): string {
    const salt = body.subarray(0, 16);
    const idLength = body.readUInt8(20);
    const asPublic = body.subarray(21, 21 + idLength);
    const sealed = body.subarray(21 + idLength);
    const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
    const prkKey = hmac(auth, ua.computeSecret(asPublic));
    const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const decipher = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));

    decipher.setAuthTag(sealed.subarray(sealed.length - 16));

    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);

    assert.equal(plain.at(-1), 2, "the last record's delimiter");

    return plain.subarray(0, plain.length - 1).toString();
}

let service: Server;
let base = "";
/** What the push service here got, and what it answers next, per path. */
const got: { path: string; headers: Record<string, string | string[] | undefined>; body: Buffer }[] = [];
const answers = new Map<string, number>();

before(async () => {
    service = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            got.push({ path: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
            response.writeHead(answers.get(request.url ?? "") ?? 201);
            response.end();
        });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
});

after(() => service?.close());

/** A browser's subscription: its own key pair and secret, at a path of the push service here. */
function browser(path: string) {
    const ua = createECDH("prime256v1");

    ua.generateKeys();

    const auth = Buffer.from("0123456789abcdef");

    return { ua, auth, subscription: { endpoint: `${base}${path}`, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

test("a push reaches the push service encrypted for the browser, which reads it; the key file is private", async () => {
    const file = join(mkdtempSync(join(root, "push-")), "web-push.json");
    const push = new WebPush({ file, log: () => {} });
    const desktop = browser("/send/desktop");
    const record = push.subscribe(desktop.subscription, { name: "Chrome on Windows", language: "vi", origin: "https://team.example.test/s/3" });

    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(record.origin, "https://team.example.test");
    assert.equal(push.subscribe(desktop.subscription, { name: "Chrome on Windows", origin: "https://team.example.test" }).id, record.id, "the same browser again keeps its id");
    assert.equal(push.list().length, 1);

    const outcome = await push.send(record, { title: "Done: HSE PVPower", body: "All 14 tests pass.", url: "/s/3", tag: "pi-phone-s3", urgency: "high" });
    const sent = got.at(-1)!;

    assert.equal(outcome, "sent");
    assert.equal(sent.path, "/send/desktop");
    assert.equal(sent.headers["content-encoding"], "aes128gcm");
    assert.equal(sent.headers.urgency, "high");
    assert.match(String(sent.headers.authorization), /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.match(String(sent.headers.authorization), new RegExp(`k=${push.publicKey()}$`));
    assert.deepEqual(JSON.parse(decrypt(sent.body, desktop.ua, desktop.auth)), { title: "Done: HSE PVPower", body: "All 14 tests pass.", url: "/s/3", tag: "pi-phone-s3", urgency: "high" });
    assert.ok(push.list()[0]!.lastSentAt !== undefined);

    // The same keys come back from the file.
    assert.equal(new WebPush({ file, log: () => {} }).publicKey(), push.publicKey());
});

test("a subscription the push service says is gone (404, 410) is forgotten; another failure keeps it, with why", async () => {
    const push = new WebPush({ file: join(mkdtempSync(join(root, "push-")), "web-push.json"), log: () => {} });
    const gone = push.subscribe(browser("/send/gone").subscription, { name: "Old phone", origin: "https://team.example.test" });
    const busy = push.subscribe(browser("/send/busy").subscription, { name: "Busy", origin: "https://team.example.test" });

    answers.set("/send/gone", 410);
    answers.set("/send/busy", 503);

    const message = { title: "t", body: "b", url: "/", tag: "x" };

    assert.equal(await push.send(gone, message), "gone");
    assert.equal(await push.send(busy, message), "failed");
    assert.deepEqual(push.list().map((each) => each.name), ["Busy"]);
    assert.match(push.list()[0]!.lastError ?? "", /503/);
});

test("subscriptions without HTTPS, or with keys that are not a P-256 point and a 16-byte secret, are refused", () => {
    const push = new WebPush({ file: join(mkdtempSync(join(root, "push-")), "web-push.json"), log: () => {} });
    const good = browser("/send/x").subscription;
    const about = { name: "x", origin: "https://team.example.test" };

    assert.throws(() => push.subscribe({ ...good, endpoint: "http://push.example.net/x" }, about), /HTTPS/);
    assert.throws(() => push.subscribe({ ...good, keys: { ...good.keys, auth: "c2hvcnQ" } }, about), /16-byte secret/);
    assert.throws(() => push.subscribe({ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }, about));
    assert.equal(push.list().length, 0);
});
