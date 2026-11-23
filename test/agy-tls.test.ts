// Google Antigravity on Go's own TLS (PP-559, agy-tls-proxy.ts and native/agy-tls): the server sends its requests to a
// small Go program on a Unix socket in the app's temporary folder, which writes them as agy's Go client does (Content-Length,
// Go's header order, no Connection header, Accept-Encoding: gzip added and the answer unzipped) and reaches only
// googleapis.com; without the program the requests go on Node's transport. PR #12's first version bound /tmp (not
// writable by the app on the phone), sent bodies chunked with Node's Connection header, and reached any address.
// The program's tests run the server edition's build (CI builds it: scripts/build-agy-tls.sh linux-x64).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { constants, createGzip } from "node:zlib";
import { agyTlsBinary, agyTlsSocket, agyTlsTransport } from "../src/server/agy-tls-proxy.ts";
import { goHeaders, type WireRequest, type WireResponse } from "../src/server/agy-wire.ts";
import { APP_ROOT } from "../src/server/config.ts";

const UA = "antigravity/cli/1.5.15 (aidev_client; os_type=linux; arch=amd64; cl=1027820220; auth_method=consumer)";
const binary = agyTlsBinary(APP_ROOT);
const built = existsSync(binary);
const skip = built ? false : `no ${binary}: run bash scripts/build-agy-tls.sh ${process.platform}-${process.arch} (CI does)`;
const closing: { close(): unknown }[] = [];

after(() => closing.forEach((each) => each.close()));

/** A transport standing for Node's: answers 299 and counts its calls. */
function fallback(): ((url: string, init: WireRequest) => Promise<WireResponse>) & { calls: string[] } {
    const calls: string[] = [];
    const empty = async function* (): AsyncGenerator<Uint8Array> {};

    return Object.assign(
        async (url: string, _init: WireRequest): Promise<WireResponse> => {
            calls.push(url);

            return { status: 299, headers: new Headers(), body: empty() };
        },
        { calls },
    );
}

async function text(body: AsyncIterable<Uint8Array>): Promise<string> {
    let all = "";

    for await (const chunk of body) {
        all += Buffer.from(chunk).toString("utf8");
    }

    return all;
}

/** A local server that keeps each request's bytes as they came, and answers with `answer`. */
async function recorder(answer: (socket: Socket) => void): Promise<{ port: number; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((socket) => {
        let got = Buffer.alloc(0);

        socket.on("data", (data: Buffer) => {
            got = Buffer.concat([got, data]);

            const head = got.indexOf("\r\n\r\n");
            const length = /\r\ncontent-length: (\d+)\r\n/i.exec(got.toString("latin1"));

            if (head < 0 || (length !== null && got.length < head + 4 + Number(length[1]))) {
                return;
            }

            requests.push(got.toString("utf8"));
            got = Buffer.alloc(0);
            answer(socket);
        });
    });

    closing.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return { port: (server.address() as AddressInfo).port, requests };
}

test("its socket is in the app's temporary folder, one per server, never /tmp, and short enough for a Unix socket on the phone", () => {
    const phone = "/data/user/0/io.piphone/files/tmp";
    const one = agyTlsSocket(phone);
    const two = agyTlsSocket(phone);

    assert.ok(one.startsWith(`${phone}/agy-tls-${process.pid}-`), one);
    assert.notEqual(one, two);
    assert.ok(Buffer.byteLength(one) < 107, `${Buffer.byteLength(one)} bytes`);
    assert.ok(agyTlsSocket().startsWith(tmpdir()));
    assert.equal(agyTlsBinary("/app", "android", "arm64"), "/app/native/android-arm64/agy-tls/agy-tls");
    assert.equal(agyTlsBinary("/app", "linux", "x64"), "/app/native/linux-x64/agy-tls/agy-tls");
});

test("without the program, or one that does not start, Antigravity's requests go on Node's transport, said once in the log", async () => {
    const lines: string[] = [];
    const node = fallback();
    const missing = agyTlsTransport({ appRoot: "/nowhere", fallback: node, log: (line) => lines.push(line) });

    assert.equal((await missing("https://daily-cloudcode-pa.googleapis.com/v1internal:a", { headers: {} })).status, 299);
    assert.equal((await missing("https://daily-cloudcode-pa.googleapis.com/v1internal:b", { headers: {} })).status, 299);
    assert.equal(node.calls.length, 2);
    assert.equal(lines.length, 1, lines.join("\n"));
    assert.match(lines[0]!, /^agy-tls: no \/nowhere\/native\/.*agy-tls; Antigravity's requests use Node's TLS$/);

    // A program that fails as it starts (the phone refusing it, a bad build): the same, with what it said.
    const folder = mkdtempSync(join(tmpdir(), "agy-tls-bad-"));
    const bad = join(folder, "agy-tls");

    writeFileSync(bad, "#!/bin/sh\necho 'listen: bind: permission denied' >&2\nexit 1\n");
    chmodSync(bad, 0o755);

    const said: string[] = [];
    const other = fallback();
    const failing = agyTlsTransport({ appRoot: "/nowhere", binary: bad, fallback: other, log: (line) => said.push(line) });

    assert.equal((await failing("https://daily-cloudcode-pa.googleapis.com/v1internal:c", { headers: {} })).status, 299);
    assert.equal(other.calls.length, 1);
    assert.match(said.join("\n"), /agy-tls: it stopped as it started \(1: listen: bind: permission denied\); Antigravity's requests use Node's TLS/);
});

test("a request goes out as agy's Go client writes it: Content-Length, Go's order, no Connection; the gzipped answer streams back unzipped", { skip }, async () => {
    let second: (() => void) | undefined;
    const google = await recorder((socket) => {
        // Two events in one gzip stream, flushed after each as Google sends Server-Sent Events, the second only once the
        // first was read: the answer streams, it is not held to its end.
        const zip = createGzip();
        const chunk = (data: Buffer) => socket.write(`${data.length.toString(16)}\r\n${data.toString("latin1")}\r\n`, "latin1");

        zip.on("data", chunk);
        zip.on("end", () => socket.end("0\r\n\r\n"));
        socket.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Encoding: gzip\r\nTransfer-Encoding: chunked\r\n\r\n`);
        zip.write("data: one\n\n");
        zip.flush(constants.Z_SYNC_FLUSH);
        second = () => zip.end("data: two\n\n");
    });
    const send = agyTlsTransport({ appRoot: APP_ROOT, fallback: fallback(), allow: [`127.0.0.1:${google.port}`] });

    closing.push(send);

    const url = `http://127.0.0.1:${google.port}/v1internal:streamGenerateContent?alt=sse`;
    const body = JSON.stringify({ project: "aicode-consumers", request: { contents: [] } });
    const answer = await send(url, { headers: goHeaders(url, { "User-Agent": UA, Authorization: "Bearer ya29.live", "Content-Type": "application/json" }, body), body });

    assert.equal(answer.status, 200);
    assert.equal(answer.headers.get("content-encoding"), null, "unzipped by Go, as agy's client does");

    const events: string[] = [];

    for await (const chunk of answer.body) {
        events.push(Buffer.from(chunk).toString("utf8"));

        if (events.join("") === "data: one\n\n") {
            second?.();
        }
    }

    assert.equal(events.join(""), "data: one\n\ndata: two\n\n");
    assert.equal(
        google.requests[0],
        `POST /v1internal:streamGenerateContent?alt=sse HTTP/1.1\r\nHost: 127.0.0.1:${google.port}\r\nUser-Agent: ${UA}\r\nContent-Length: ${body.length}\r\n` +
            `Authorization: Bearer ya29.live\r\nContent-Type: application/json\r\nAccept-Encoding: gzip\r\n\r\n${body}`,
    );
});

test("Go's own User-Agent for the token endpoint, a GET has no body; the next request reuses the program, and after close it starts again", { skip }, async () => {
    const google = await recorder((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"));
    const send = agyTlsTransport({ appRoot: APP_ROOT, fallback: fallback(), allow: [`127.0.0.1:${google.port}`] });

    closing.push(send);

    const url = `http://127.0.0.1:${google.port}/oauth2/v2/userinfo`;
    const get = await send(url, { method: "GET", headers: goHeaders(url, { Authorization: "Bearer t" }) });

    assert.equal(await text(get.body), "{}");
    assert.equal(google.requests[0], `GET /oauth2/v2/userinfo HTTP/1.1\r\nHost: 127.0.0.1:${google.port}\r\nUser-Agent: Go-http-client/1.1\r\nAuthorization: Bearer t\r\nAccept-Encoding: gzip\r\n\r\n`);

    await text((await send(url, { method: "GET", headers: goHeaders(url, {}) })).body);
    send.close();
    await text((await send(url, { method: "GET", headers: goHeaders(url, {}) })).body);
    assert.equal(google.requests.length, 3, "started again after close");
});

test("it reaches only https on googleapis.com: another address is refused, never asked", { skip }, async () => {
    const google = await recorder((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n"));
    const send = agyTlsTransport({ appRoot: APP_ROOT, fallback: fallback() });

    closing.push(send);

    for (const url of [`http://127.0.0.1:${google.port}/x`, "https://example.com/x", "https://googleapis.com.example.com/x", "http://daily-cloudcode-pa.googleapis.com/x"]) {
        const answer = await send(url, { headers: goHeaders(url, {}, "{}"), body: "{}" });

        assert.equal(answer.status, 403, url);
        assert.equal(answer.headers.get("x-agy-tls"), "refused");
        assert.match(await text(answer.body), /reaches only https addresses on googleapis\.com/);
    }

    assert.equal(google.requests.length, 0);
});

test("it never keeps the server running: a server that used it ends at once, and the program with it", { skip }, async () => {
    const google = await recorder((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"));
    const module = new URL("../src/server/agy-tls-proxy.ts", import.meta.url).href;
    const script =
        `const { agyTlsTransport } = await import(${JSON.stringify(module)});` +
        `const send = agyTlsTransport({ appRoot: ${JSON.stringify(APP_ROOT)}, fallback: async () => { throw new Error("fallback"); }, allow: ["127.0.0.1:${google.port}"] });` +
        `const answer = await send("http://127.0.0.1:${google.port}/x", { method: "GET", headers: {} });` +
        `for await (const _ of answer.body) {}` +
        `console.log(answer.status);`;
    const server = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    let printed = "";

    server.stdout.on("data", (data: Buffer) => (printed += data.toString()));

    const started = Date.now();
    const code = await new Promise<number | null>((resolve) => server.on("exit", resolve));

    assert.equal(code, 0);
    assert.equal(printed.trim(), "200");
    assert.ok(Date.now() - started < 10_000, `ended after ${Date.now() - started} ms`);
    assert.equal(google.requests.length, 1);
});

test("it dials the address the server's lookup gave, never asking DNS itself (the phone has no /etc/resolv.conf for Go)", { skip }, async () => {
    const google = await recorder((socket) => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"));
    const socket = agyTlsSocket();
    // A name no resolver knows: reached only through X-Agy-Dial.
    const host = `agy-dial.invalid:${google.port}`;
    const child = spawn(binary, [socket, `--allow=${host}`], { stdio: ["pipe", "ignore", "pipe"] });

    closing.push({ close: () => child.stdin.end() });
    await new Promise<void>((resolve) => child.stderr.on("data", (data: Buffer) => data.toString().includes("listening on") && resolve()));

    const status = await new Promise<number>((resolve, reject) => {
        const outgoing = httpRequest({ socketPath: socket, method: "GET", path: "/", headers: { "X-Agy-Target": `http://${host}/v1internal:fetchConfig`, "X-Agy-Dial": "127.0.0.1" } }, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode ?? 0));
        });

        outgoing.on("error", reject);
        outgoing.end();
    });

    assert.equal(status, 200);
    assert.match(google.requests[0]!, new RegExp(`^GET /v1internal:fetchConfig HTTP/1\\.1\\r\\nHost: ${host.replace(".", "\\.")}\\r\\n`));
    assert.doesNotMatch(google.requests[0]!, /X-Agy/i);
});

test("the program ends when the server's pipe to it closes", { skip }, async () => {
    const socket = agyTlsSocket();
    const child = spawn(binary, [socket], { stdio: ["pipe", "ignore", "pipe"] });

    await new Promise<void>((resolve) => child.stderr.on("data", (data: Buffer) => data.toString().includes("listening on") && resolve()));
    assert.ok(existsSync(socket));
    child.stdin.end();

    const code = await new Promise<number | null>((resolve) => child.on("exit", resolve));

    assert.equal(code, 0);
    assert.equal(existsSync(socket), false, "its socket removed");
});
