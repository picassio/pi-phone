/**
 * Reaching the phone over Tailscale (DESIGN.md section 4, multiplayer): the server always listens on 127.0.0.1 for the
 * app's WebView, and, when the owner turns this on, also on the phone's Tailscale address, so people on the owner's
 * tailnet open invite links. The Tailscale app on the phone owns the VPN; its address comes and goes with it, so it is
 * looked up every few seconds and the second listener follows it. Nothing listens on the phone's other networks.
 */
import { createServer, type RequestListener, type Server } from "node:http";
import { networkInterfaces } from "node:os";

/** Tailscale hands out addresses in 100.64.0.0/10. */
function isTailscaleAddress(address: string): boolean {
    const [first, second] = address.split(".").map(Number);

    return first === 100 && second !== undefined && second >= 64 && second <= 127;
}

/** The phone's Tailscale address while the Tailscale app is connected, else undefined. */
export function tailscaleAddress(): string | undefined {
    const candidates = Object.entries(networkInterfaces()).flatMap(([name, list]) =>
        (list ?? [])
            .filter((net) => net.family === "IPv4" && !net.internal && isTailscaleAddress(net.address))
            .map((net) => ({ name, address: net.address })),
    );

    return (candidates.find((each) => /tailscale|tun/i.test(each.name)) ?? candidates[0])?.address;
}

export type TailnetStatus = {
    enabled: boolean;
    /** Where people on the tailnet reach the server, while it listens there. */
    url?: string;
    /** Why it does not listen, while it is on. */
    problem?: string;
};

export type TailnetOptions = {
    port: number;
    handler: RequestListener;
    /** Attach what else the server answers (terminals' WebSockets) to a listener; returns its detach. */
    attach: (server: Server) => () => void;
    /** The address changed (a URL while it listens, else undefined). */
    changed: (url: string | undefined) => void;
    /** How to find the address; tests stand one in. */
    address?: () => string | undefined;
    everyMs?: number;
};

export const NOT_CONNECTED = "Tailscale is not connected on this phone: open the Tailscale app and connect.";

export class Tailnet {
    readonly #options: TailnetOptions;
    #enabled = false;
    #timer: ReturnType<typeof setInterval> | undefined;
    #listening: { address: string; server: Server; detach: () => void } | undefined;
    #problem: string | undefined;
    /** One follow at a time: a listener opening or closing finishes before the next look. */
    #busy: Promise<void> = Promise.resolve();

    constructor(options: TailnetOptions) {
        this.#options = options;
    }

    status(): TailnetStatus {
        return {
            enabled: this.#enabled,
            ...(this.#listening === undefined ? {} : { url: this.#url(this.#listening.address) }),
            ...(this.#enabled && this.#problem !== undefined ? { problem: this.#problem } : {}),
        };
    }

    /** Turn it on or off; resolves once the listener follows. */
    async set(enabled: boolean): Promise<TailnetStatus> {
        this.#enabled = enabled;
        clearInterval(this.#timer);
        this.#timer = undefined;

        if (enabled) {
            this.#timer = setInterval(() => void this.follow(), this.#options.everyMs ?? 10_000);
            this.#timer.unref();
        }

        await this.follow();

        return this.status();
    }

    /** Listen on the Tailscale address as it is now, or stop when it is gone or this is off. */
    follow(): Promise<void> {
        this.#busy = this.#busy.then(() => this.#follow());

        return this.#busy;
    }

    async close(): Promise<void> {
        await this.set(false);
    }

    #url(address: string): string {
        return `http://${address}:${this.#options.port}`;
    }

    async #follow(): Promise<void> {
        const address = this.#enabled ? (this.#options.address ?? tailscaleAddress)() : undefined;

        if (this.#listening?.address === address && (address !== undefined || this.#listening === undefined)) {
            this.#problem = address === undefined && this.#enabled ? NOT_CONNECTED : this.#problem;

            return;
        }

        const before = this.#listening?.address;

        if (this.#listening !== undefined) {
            const { server, detach } = this.#listening;

            this.#listening = undefined;
            detach();
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }

        if (address === undefined) {
            this.#problem = this.#enabled ? NOT_CONNECTED : undefined;
        } else {
            const server = createServer(this.#options.handler);

            server.requestTimeout = 15 * 60_000;
            server.headersTimeout = 60_000;

            try {
                await new Promise<void>((resolve, reject) => {
                    server.once("error", reject);
                    server.listen(this.#options.port, address, () => {
                        server.off("error", reject);
                        resolve();
                    });
                });
                server.on("error", (error) => console.error("Tailscale listener:", error));
                this.#listening = { address, server, detach: this.#options.attach(server) };
                this.#problem = undefined;
            } catch (error) {
                this.#problem = `Could not listen on ${address}:${this.#options.port}: ${(error as Error).message}`;
            }
        }

        if (this.#listening?.address !== before) {
            this.#options.changed(this.#listening === undefined ? undefined : this.#url(this.#listening.address));
        }
    }
}
