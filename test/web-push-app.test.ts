// The app's push notifications for the web UI (PP-127): what the phone is told (`phone-events.ts`) goes to each browser
// that turned notifications on, in the owner's language or the browser's, with its session to open; a quiet session's
// end does not; a browser with a pi-phone tab visible now gets nothing, and gets it again once the tab is hidden.
import { type App, cleanUp, fakeTab, openApp, owner, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";

let app: App;
let service: Server;
let base = "";
const got: Buffer[] = [];
const ua = createECDH("prime256v1");
const auth = Buffer.from("fedcba9876543210");

ua.generateKeys();

/** The browser's side: open a push message's body with its key and secret (RFC 8291). */
function read(body: Buffer): { title: string; body: string; url: string; tag: string; urgency: string } {
    const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
    const asPublic = body.subarray(21, 21 + body.readUInt8(20));
    const sealed = body.subarray(21 + asPublic.length);
    const ikm = hmac(hmac(auth, ua.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), ua.getPublicKey(), asPublic, Buffer.from([1])]));
    const prk = hmac(body.subarray(0, 16), ikm);
    const decipher = createDecipheriv("aes-128-gcm", hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12));

    decipher.setAuthTag(sealed.subarray(sealed.length - 16));

    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);

    return JSON.parse(plain.subarray(0, plain.length - 1).toString()) as never;
}

before(async () => {
    service = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            got.push(Buffer.concat(chunks));
            response.writeHead(201);
            response.end();
        });
    });
    await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(service.address() as { port: number }).port}`;
    app = await openApp(scriptedModel());
});

after(async () => {
    service?.close();
    await app?.close();
    cleanUp();
});

test("what the phone is told goes to the browsers with notifications on, not quiet ends, not to one with a visible tab", async () => {
    const record = app.webPush.subscribe({ endpoint: `${base}/push/one`, keys: { p256dh: ua.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } }, { name: "Chrome on Windows", language: "zh-CN", origin: "https://team.example.test" });

    // A run ended: the browser's language (Chinese), as the owner's choice is Auto.
    app.phoneEvents.add({ kind: "done", session: 7, title: "HSE PVPower", text: "All 14 tests pass." });
    await until(() => got.length === 1, "the push");
    assert.deepEqual(read(got[0]!), { title: "已完成：HSE PVPower", body: "All 14 tests pass.", url: "/s/7", tag: "pi-phone-s7", urgency: "normal" });

    // Waiting for an approval: high urgency.
    app.phoneEvents.add({ kind: "approval", session: 7, title: "HSE PVPower", text: "Pi asks before this: bash" });
    await until(() => got.length === 2, "the approval's push");
    assert.equal(read(got[1]!).urgency, "high");

    // A quiet session's end (a board task's): the phone does not hear it, nor the browser.
    const stop = app.phoneEvents.quiet((session) => session === 9);

    app.phoneEvents.add({ kind: "done", session: 9, title: "Task", text: "done" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(got.length, 2, "no push for a quiet end");
    stop();

    // A pi-phone tab of that browser is visible: no push to it; hidden again, the next one comes.
    const tab = fakeTab(undefined, owner(app));

    await app.attach(tab.client);
    app.setVisible(owner(app), tab.client.id, true, record.id);
    app.phoneEvents.add({ kind: "failed", session: 7, title: "HSE PVPower", text: "It stopped." });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(got.length, 2, "no push while its tab is visible");

    app.setVisible(owner(app), tab.client.id, false);
    app.phoneEvents.add({ kind: "failed", session: 7, title: "HSE PVPower", text: "It stopped again." });
    await until(() => got.length === 3, "the push once the tab is hidden");
    assert.equal(read(got[2]!).body, "It stopped again.");
});
