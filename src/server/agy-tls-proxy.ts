/**
 * Google Antigravity's HTTP/1.1 requests on Go's own TLS and HTTP client (PP-559): `native/agy-tls`, a small Go program
 * the build makes for each platform (`scripts/build-agy-tls.sh`), so the handshake is agy's (JA4
 * t13d1312h1_f57a46bbacb6_f50d94e863eb, measured against agy 1.5.15) where Node's OpenSSL could only come near it
 * (PP-558). It listens on a Unix socket of its own in the app's temporary folder (`os.tmpdir()`: on the phone the app's
 * TMPDIR, as /tmp is not the app's), and reaches only https addresses on googleapis.com; the request goes out as Go
 * writes it (Host, User-Agent, Content-Length, the other headers, Accept-Encoding: gzip), the answer unzipped.
 *
 * Without the program (a checkout that did not build it, another platform) or when it does not start, Antigravity's
 * requests go on `agyTransport` (Node's TLS set close to Go's), said once in the app's log; a program that stops is
 * started again at the next request. It ends with the server: its standard input is the server's.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import http, { type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import type { Socket } from "node:net";
import { join } from "node:path";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import type { WireRequest, WireResponse } from "./agy-wire.ts";

type Send = (url: string, init: WireRequest) => Promise<WireResponse>;

/** The program for this platform, under the app's root, by `process.platform`-`process.arch`. */
export function agyTlsBinary(appRoot: string, platform: string = process.platform, arch: string = process.arch): string {
    return join(appRoot, "native", `${platform}-${arch}`, "agy-tls", "agy-tls");
}

/**
 * The program's socket: in the app's temporary folder, one per server (its process id and a random part), within
 * the 107 bytes a Unix socket's path may have.
 */
export function agyTlsSocket(folder: string = tmpdir()): string {
    return join(folder, `agy-tls-${process.pid}-${randomBytes(4).toString("hex")}.sock`);
}

export type AgyTlsOptions = {
    /** The app's root, holding `native/<platform>-<arch>/agy-tls/agy-tls`. */
    appRoot: string;
    /** The transport used without the program: `agyTransport()`. */
    fallback: Send;
    log?: (line: string) => void;
    /** The program, when not the platform's under `appRoot` (tests). */
    binary?: string;
    /** host:port addresses it may reach over plain http (tests' local servers). */
    allow?: readonly string[];
    /** How long the program may take to listen. */
    startMs?: number;
};

/** A transport through the Go program, with `close` to end it. */
export function agyTlsTransport(options: AgyTlsOptions): Send & { close(): void } {
    const { appRoot, fallback, log = () => {}, allow = [], startMs = 5_000 } = options;
    const binary = options.binary ?? agyTlsBinary(appRoot);
    let child: ChildProcess | undefined;
    let socket: string | undefined;
    let starting: Promise<string | undefined> | undefined;
    /** Why the program is not used, once said; undefined while it may be. */
    let without: string | undefined;

    const fail = (why: string) => {
        if (without === undefined) {
            log(`agy-tls: ${why}; Antigravity's requests use Node's TLS`);
        }

        without = why;

        return undefined;
    };

    const start = (): Promise<string | undefined> => {
        if (!existsSync(binary)) {
            return Promise.resolve(fail(`no ${binary}`));
        }

        const path = agyTlsSocket();

        return new Promise((resolve) => {
            let said = "";
            const proc = spawn(binary, [path, ...allow.map((host) => `--allow=${host}`)], { stdio: ["pipe", "ignore", "pipe"] });

            // It never keeps the server running: once the server ends, its pipe closes and so does the program.
            proc.unref();
            (proc.stdin as Socket | null)?.unref();
            (proc.stderr as Socket | null)?.unref();
            const timer = setTimeout(() => {
                proc.kill();
                resolve(fail(`it did not listen within ${startMs} ms${said === "" ? "" : ` (${said.trim()})`}`));
            }, startMs);

            proc.stderr?.setEncoding("utf8");
            proc.stderr?.on("data", (text: string) => {
                said = (said + text).slice(-500);

                if (said.includes("listening on")) {
                    clearTimeout(timer);
                    child = proc;
                    socket = path;
                    resolve(path);
                }
            });
            proc.on("error", (error) => {
                clearTimeout(timer);
                resolve(fail(`it could not start: ${error.message}`));
            });
            proc.on("exit", (code, signal) => {
                clearTimeout(timer);

                if (child === proc) {
                    log(`agy-tls: it stopped (${code ?? signal}); started again at the next request`);
                    child = undefined;
                    socket = undefined;
                } else {
                    resolve(fail(`it stopped as it started (${code ?? signal}${said === "" ? "" : `: ${said.trim()}`})`));
                }
            });
        });
    };

    const send = (async (url, init) => {
        if (without !== undefined) {
            return fallback(url, init);
        }

        if (socket === undefined) {
            starting ??= start().finally(() => {
                starting = undefined;
            });
        }

        const path = socket ?? (await starting);

        if (path === undefined) {
            return fallback(url, init);
        }

        // The system's resolver (Android's private DNS, a VPN): Go's own finds no /etc/resolv.conf on the phone.
        // A name it cannot find (a proxy that resolves it) is left to Go and the proxy.
        const address = await lookup(new URL(url).hostname).then(({ address: found }) => found, () => undefined);

        return request(path, url, init, address);
    }) as Send & { close(): void };

    send.close = () => {
        child?.stdin?.end();
        child?.kill();
        child = undefined;
        socket = undefined;
    };

    return send;
}

/** One request on the program's socket, its answer as `agyTransport` gives one. */
function request(socket: string, url: string, init: WireRequest, address: string | undefined): Promise<WireResponse> {
    return new Promise<WireResponse>((resolve, reject) => {
        const { Host: _host, ...headers } = init.headers;
        const outgoing = http.request({
            socketPath: socket,
            method: init.method ?? "POST",
            path: "/",
            headers: { ...headers, "X-Agy-Target": url, ...(address === undefined ? {} : { "X-Agy-Dial": address }) },
            ...(init.signal === undefined ? {} : { signal: init.signal }),
        });

        outgoing.on("error", reject);
        outgoing.on("response", (response: IncomingMessage) => {
            const answer = new Headers();

            for (let index = 0; index + 1 < response.rawHeaders.length; index += 2) {
                answer.append(response.rawHeaders[index]!, response.rawHeaders[index + 1]!);
            }

            // Go unzips what it asked gzipped itself; a header the caller set leaves the answer zipped, as agyTransport's.
            const body: AsyncIterable<Uint8Array> = answer.get("content-encoding") === "gzip" ? pipeline(response, createGunzip(), () => {}) : response;

            resolve({ status: response.statusCode ?? 0, headers: answer, body });
        });
        outgoing.end(init.body);
    });
}
