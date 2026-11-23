/**
 * Go TLS proxy for Antigravity (PP-558): makes HTTPS requests with Go's TLS stack (boringcrypto),
 * matching agy's exact TLS fingerprint including ML-KEM post-quantum key exchange and ML-DSA signatures.
 *
 * The `agy-tls` binary listens on a Unix socket. Node.js sends HTTP/1.1 requests with:
 *   X-Agy-Target: https://target.url/path
 * The Go binary makes the HTTPS request and streams the response back.
 *
 * JA4 fingerprint: t13d1312h1_f57a46bbacb6_f50d94e863eb (matches agy 1.5.15 exactly)
 */
import { spawn, ChildProcess } from "node:child_process";
import http from "node:http";
import { join } from "node:path";
import fs from "node:fs";
import { pipeline } from "node:stream";
import { createGunzip } from "node:zlib";
import type { WireRequest, WireResponse } from "./agy-wire.js";

const SOCKET_PATH = "/tmp/agy-tls.sock";

/** Binary paths by platform/arch. The app bundles these in native/agy-tls/. */
const BINARY_PATHS: Record<string, string> = {
    "android-arm64": "native/agy-tls/agy-tls-android-arm64",
    "linux-x64": "native/agy-tls/agy-tls-linux-amd64",
};

let proxy: ChildProcess | null = null;
let proxyReady = false;
let startPromise: Promise<void> | null = null;

/** Get the binary path for the current platform. */
function getBinaryPath(appRoot: string): string | undefined {
    const platform = process.platform === "android" ? "android" : process.platform;
    const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : undefined;
    if (!arch) return undefined;

    const key = `${platform}-${arch}`;
    const relativePath = BINARY_PATHS[key];
    if (!relativePath) return undefined;

    return join(appRoot, relativePath);
}

/** Start the Go TLS proxy if not already running. */
export async function startAgyTlsProxy(appRoot: string): Promise<void> {
    if (proxyReady && proxy) return;
    if (startPromise) return startPromise;

    startPromise = (async () => {
        const binaryPath = getBinaryPath(appRoot);
        if (!binaryPath) {
            throw new Error(`No agy-tls binary for ${process.platform}-${process.arch}`);
        }
        if (!fs.existsSync(binaryPath)) {
            throw new Error(`agy-tls binary not found: ${binaryPath}`);
        }

        // Remove old socket
        try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }

        // Make binary executable
        try { fs.chmodSync(binaryPath, 0o755); } catch { /* ignore */ }

        // Spawn
        proxy = spawn(binaryPath, [SOCKET_PATH], {
            stdio: ["ignore", "pipe", "pipe"],
            detached: false,
        });

        proxy.stderr?.on("data", (data: Buffer) => {
            const msg = data.toString().trim();
            // Suppress "accept: use of closed network connection" spam on shutdown
            if (msg && !msg.includes("accept:") && !msg.includes("shutting down")) {
                console.error(`[agy-tls] ${msg}`);
            }
        });

        proxy.on("error", (err) => {
            console.error(`[agy-tls] process error: ${err.message}`);
            proxyReady = false;
            proxy = null;
        });

        proxy.on("exit", (code) => {
            if (code !== 0 && code !== null) {
                console.error(`[agy-tls] exited with code ${code}`);
            }
            proxyReady = false;
            proxy = null;
        });

        // Wait for socket
        const maxWait = 5000;
        const start = Date.now();
        while (Date.now() - start < maxWait) {
            if (fs.existsSync(SOCKET_PATH)) {
                proxyReady = true;
                console.log("[agy-tls] proxy ready");
                return;
            }
            await new Promise(r => setTimeout(r, 50));
        }
        throw new Error("agy-tls socket not ready after 5s");
    })();

    try {
        await startPromise;
    } finally {
        startPromise = null;
    }
}

/** Stop the Go TLS proxy. */
export function stopAgyTlsProxy(): void {
    if (proxy) {
        proxy.kill("SIGTERM");
        proxy = null;
    }
    proxyReady = false;
    try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
}

/** Check if proxy is running. */
export function isAgyTlsProxyReady(): boolean {
    return proxyReady && proxy !== null;
}

/**
 * Transport that routes requests through the Go TLS proxy.
 * Headers are passed as-is; the Go proxy handles the TLS with agy's fingerprint.
 */
export function agyTlsTransport(appRoot: string): (url: string, init: WireRequest) => Promise<WireResponse> {
    return async (url, init) => {
        // Ensure proxy is started
        if (!proxyReady) {
            await startAgyTlsProxy(appRoot);
        }

        return new Promise<WireResponse>((resolve, reject) => {
            const request = http.request(
                {
                    socketPath: SOCKET_PATH,
                    method: init.method ?? "POST",
                    path: "/",
                    headers: {
                        "X-Agy-Target": url,
                        ...init.headers,
                    },
                    ...(init.signal === undefined ? {} : { signal: init.signal }),
                },
                (response) => {
                    const headers = new Headers();
                    for (let i = 0; i + 1 < response.rawHeaders.length; i += 2) {
                        headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
                    }

                    // Gunzip if gzipped (Go should already handle this, but be defensive)
                    const body: AsyncIterable<Uint8Array> =
                        headers.get("content-encoding") === "gzip"
                            ? pipeline(response, createGunzip(), () => {})
                            : response;

                    resolve({ status: response.statusCode ?? 0, headers, body });
                }
            );

            request.on("error", (err) => {
                // Connection refused means proxy died - mark not ready
                if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
                    proxyReady = false;
                }
                reject(err);
            });

            request.end(init.body);
        });
    };
}
