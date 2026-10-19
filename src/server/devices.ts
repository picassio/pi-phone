/**
 * Signed-in devices (owner's decisions of 2026-10-19, wiki: pi-phone-sign-in-management): what a device is called, from
 * the browser that signed in, and whether it is the phone's own app.
 */
import type { IncomingMessage } from "node:http";

/** The address a request comes from, without IPv4's IPv6 dress. */
export function addressOf(request: IncomingMessage): string {
    return (request.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
}

const loopback = (address: string) => /^(127\.|::1$)/.test(address);

/** The phone's own app: its WebView (`; wv)` in its user agent) from this phone. */
export function isApp(agent: string, address: string): boolean {
    return /; wv\)/.test(agent) && loopback(address);
}

/** A browser's name and system from its user agent, in a few words: "Chrome on Windows"; the app by name. */
export function deviceName(agent: string, address: string): string {
    if (isApp(agent, address)) {
        return "pi-phone app";
    }

    const browser = /Edg\//.test(agent)
        ? "Edge"
        : /SamsungBrowser\//.test(agent)
          ? "Samsung Internet"
          : /OPR\//.test(agent)
            ? "Opera"
            : /Firefox\//.test(agent)
              ? "Firefox"
              : /Chrome\//.test(agent)
                ? "Chrome"
                : /Safari\//.test(agent)
                  ? "Safari"
                  : "A browser";
    const system = /Windows/.test(agent)
        ? "Windows"
        : /Android/.test(agent)
          ? "Android"
          : /iPhone|iPad/.test(agent)
            ? "iOS"
            : /Mac OS X/.test(agent)
              ? "macOS"
              : /CrOS/.test(agent)
                ? "ChromeOS"
                : /Linux/.test(agent)
                  ? "Linux"
                  : "";

    return system === "" ? browser : `${browser} on ${system}`;
}
