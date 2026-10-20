/**
 * The gateway (PP-21): what people reach through Caddy. It signs them in (better-auth, `auth.ts`), keeps invites and
 * people (`store.ts`), and forwards everything else, HTTP and WebSockets alike, to the signed-in person's own pi-phone
 * container, which the controller makes on first use. Forwarded requests carry that container's owner token and none of
 * the browser's cookies or credentials. pi-phone's own sign-in, invites, devices and people are refused there: accounts
 * live here.
 *
 * Routes: `/auth/api/*` better-auth; `/auth/gw/*` the gateway's own (state, setup, invites, people); `/auth/static/*`
 * its page's files; `/auth/*` its page (sign-in, setup, invite, account, people); anything else, the person's pi-phone.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect } from "node:net";
import type { Duplex } from "node:stream";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import QRCode from "qrcode";
import type { GatewayAuth } from "./auth.ts";
import { type GatewayStore, INVITE_MINUTES, ROLES, type Role } from "./store.ts";

/** What the gateway asks the controller (`src/controller/`): a person's pi-phone, by key. */
export interface ControllerClient {
    ensure(key: string, token: string, caps: { memoryMb: number; cpus: number }): Promise<{ host: string; port: number }>;
    stop(key: string): Promise<void>;
    remove(key: string, purge: boolean): Promise<void>;
}

export type GatewayOptions = {
    auth: GatewayAuth;
    store: GatewayStore;
    controller: ControllerClient;
    /** The address people open: `https://…`. */
    origin: string;
    /** The memory and CPU each person's pi-phone gets (phase 2 takes them from roles). */
    caps: { memoryMb: number; cpus: number };
    log: (line: string) => void;
};

type User = { id: string; name: string; email: string; role?: string | null; banned?: boolean | null; twoFactorEnabled?: boolean | null };

const WEB = resolve(import.meta.dirname, "web");
const WEBAUTHN = resolve(import.meta.dirname, "..", "..", "node_modules", "@simplewebauthn", "browser", "esm");
/** pi-phone's own icon (web/icon.svg). */
const ICON_DIR = resolve(import.meta.dirname, "..", "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** pi-phone's routes for signing in and managing people: the gateway does these, so they never reach a container. */
const REFUSED = [/^\/login(\/|$|\?)/, /^\/recover(\/|$|\?)/, /^\/api\/(invite|recovery-code|devices|users|sign-out-everywhere|logout|access|tailscale)(\/|$|\?)/];

/** How long a pi-phone found running is taken as running, before the controller is asked again. */
const READY_MS = 60_000;

export class Gateway {
    readonly #options: GatewayOptions;
    readonly #authHandler: ReturnType<typeof toNodeHandler>;
    /** People whose pi-phone the controller said is running, and when. */
    readonly #ready = new Map<string, { host: string; port: number; at: number }>();
    readonly #starting = new Map<string, Promise<{ host: string; port: number }>>();

    constructor(options: GatewayOptions) {
        this.#options = options;
        this.#authHandler = toNodeHandler(options.auth);
    }

    async #user(request: IncomingMessage): Promise<User | undefined> {
        const session = await this.#options.auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
        const user = session?.user as User | undefined;

        return user === undefined || user.banned === true ? undefined : user;
    }

    /** A person's pi-phone, running: started (made on first use) by the controller once a minute at most. */
    async #upstream(user: User, fresh = false): Promise<{ host: string; port: number; token: string }> {
        const box = this.#options.store.box(user.id);
        const known = this.#ready.get(box.key);

        if (!fresh && known !== undefined && Date.now() - known.at < READY_MS) {
            return { ...known, token: box.token };
        }

        let starting = this.#starting.get(box.key);

        if (starting === undefined) {
            starting = this.#options.controller.ensure(box.key, box.token, this.#options.caps).finally(() => this.#starting.delete(box.key));
            this.#starting.set(box.key, starting);
        }

        const place = await starting;

        this.#ready.set(box.key, { ...place, at: Date.now() });

        return { ...place, token: box.token };
    }

    /** Headers for a forwarded request: the browser's, without its cookies and credentials, with the container's token. */
    #forwarded(request: IncomingMessage, upstream: { host: string; port: number; token: string }): Record<string, string | string[]> {
        const headers: Record<string, string | string[]> = {};

        for (const [name, value] of Object.entries(request.headers)) {
            if (value !== undefined && !["cookie", "authorization", "host", "x-forwarded-proto", "x-forwarded-host", "x-forwarded-for", "connection"].includes(name)) {
                headers[name] = value;
            }
        }

        const url = new URL(this.#options.origin);

        headers.host = `${upstream.host}:${upstream.port}`;
        headers.authorization = `Bearer ${upstream.token}`;
        headers["x-forwarded-proto"] = url.protocol.replace(":", "");
        headers["x-forwarded-host"] = url.host;

        return headers;
    }

    /** One HTTP request. */
    async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const path = (request.url ?? "/").split("?")[0]!;

        try {
            if (path.startsWith("/auth/api/")) {
                return await this.#authHandler(request, response);
            }

            if (path.startsWith("/auth/gw/")) {
                return await this.#gatewayRoute(request, response, path.slice("/auth/gw/".length));
            }

            if (path.startsWith("/auth/static/")) {
                return this.#static(response, path.slice("/auth/static/".length));
            }

            if (path === "/auth" || path.startsWith("/auth/")) {
                return this.#static(response, "index.html");
            }

            const user = await this.#user(request);

            if (user === undefined) {
                if (request.method === "GET" && !path.startsWith("/api/")) {
                    return redirect(response, `/auth/sign-in?next=${encodeURIComponent(request.url ?? "/")}`);
                }

                return json(response, 401, { error: "Sign in first: /auth/sign-in" });
            }

            if (REFUSED.some((pattern) => pattern.test(request.url ?? "/"))) {
                if (request.method === "GET" && (path === "/login" || path === "/recover")) {
                    return redirect(response, "/auth/account");
                }

                return json(response, 403, { error: "Accounts, invites and devices are managed on the gateway: /auth/account" });
            }

            await this.#forward(request, response, user);
        } catch (error) {
            this.#options.log(`gateway: ${request.method} ${path}: ${String(error)}`);

            if (!response.headersSent) {
                json(response, 500, { error: "The gateway could not answer." });
            }
        }
    }

    async #forward(request: IncomingMessage, response: ServerResponse, user: User, retried = false): Promise<void> {
        const upstream = await this.#upstream(user, retried);

        await new Promise<void>((done) => {
            const sent = httpRequest({ host: upstream.host, port: upstream.port, method: request.method, path: request.url, headers: this.#forwarded(request, upstream) }, (answer) => {
                const headers = { ...answer.headers };

                delete headers["set-cookie"];
                response.writeHead(answer.statusCode ?? 502, headers);
                answer.pipe(response);
                answer.on("end", () => done());
                answer.on("error", () => done());
            });

            sent.on("error", (error: NodeJS.ErrnoException) => {
                // Not there yet (made a moment ago, or starting again): asked once more, then "starting".
                if (!retried && !response.headersSent) {
                    this.#ready.delete(this.#options.store.box(user.id).key);
                }

                if (!response.headersSent) {
                    if (request.method === "GET" && (request.headers.accept ?? "").includes("text/html")) {
                        response.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "3", "cache-control": "no-store" });
                        response.end(STARTING);
                    } else {
                        json(response, 503, { error: `Your pi-phone is starting (${error.code ?? error.message}): try again in a moment.` });
                    }
                }

                done();
            });
            request.pipe(sent);
            response.on("close", () => sent.destroy());
        });
    }

    /** A WebSocket (the terminal): the same person, the same container, piped both ways. */
    async upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
        try {
            const user = await this.#user(request);

            if (user === undefined || REFUSED.some((pattern) => pattern.test(request.url ?? "/"))) {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

                return;
            }

            // A WebSocket from another site carries its own Origin: only the gateway's own pages may open one.
            if (request.headers.origin !== this.#options.origin) {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

                return;
            }

            const upstream = await this.#upstream(user);
            const headers = this.#forwarded(request, upstream);
            const lines = [`${request.method} ${request.url} HTTP/1.1`, "connection: upgrade", ...Object.entries(headers).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((each) => `${name}: ${each}`))];
            const inner = netConnect(upstream.port, upstream.host, () => {
                inner.write(`${lines.join("\r\n")}\r\n\r\n`);

                if (head.length > 0) {
                    inner.write(head);
                }

                inner.pipe(socket);
                socket.pipe(inner);
            });

            inner.on("error", () => socket.destroy());
            socket.on("error", () => inner.destroy());
        } catch (error) {
            this.#options.log(`gateway: upgrade ${request.url}: ${String(error)}`);
            socket.destroy();
        }
    }

    #static(response: ServerResponse, file: string): void {
        const swa = file.startsWith("webauthn/");
        const root = file === "icon.svg" ? ICON_DIR : swa ? WEBAUTHN : WEB;
        const path = normalize(join(root, swa ? file.slice("webauthn/".length) : file));

        if (!(path === root || path.startsWith(root + sep)) || !existsSync(path) || !statSync(path).isFile()) {
            return json(response, 404, { error: "No such file." });
        }

        response.writeHead(200, {
            "content-type": TYPES[extname(path)] ?? "application/octet-stream",
            "cache-control": "no-cache",
            "x-frame-options": "DENY",
            "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        });
        createReadStream(path).pipe(response);
    }

    /** The gateway's own routes, for its page. */
    async #gatewayRoute(request: IncomingMessage, response: ServerResponse, route: string): Promise<void> {
        const { auth, store } = this.#options;
        const method = request.method ?? "GET";
        const user = await this.#user(request);
        const owner = user?.role === "owner";

        // What the page needs: whether the owner is still to be set up, and who is signed in.
        if (route === "state" && method === "GET") {
            return json(response, 200, {
                setup: store.userCount() === 0,
                me: user === undefined ? null : { id: user.id, name: user.name, email: user.email, role: user.role ?? "member", twoFactor: user.twoFactorEnabled === true },
            });
        }

        // The owner's first account, with the setup token from the gateway's log; once there is one, never again.
        if (route === "setup" && method === "POST") {
            const body = await readBody(request);

            if (store.userCount() > 0) {
                return json(response, 409, { error: "The owner is set up already: sign in." });
            }

            if (!store.setupTokenIs(String(body.setupToken ?? ""))) {
                return json(response, 403, { error: "That is not the setup token in the gateway's log." });
            }

            await auth.api.createUser({ body: { name: String(body.name ?? "Owner"), email: String(body.email ?? ""), password: String(body.password ?? ""), role: "owner" } });

            return json(response, 200, { ok: true });
        }

        // An invite as its link shows it, and spending it for a new account.
        const invite = /^invite\/([A-Za-z0-9_-]{10,64})$/.exec(route);

        if (invite !== null) {
            const live = store.liveInvite(invite[1]!);

            if (method === "GET") {
                return json(response, live === undefined ? 404 : 200, live === undefined ? { error: "This invite is used, expired, or never was." } : { role: live.role, expiresAt: live.expiresAt });
            }

            if (method === "POST") {
                const body = await readBody(request);

                if (live === undefined) {
                    return json(response, 404, { error: "This invite is used, expired, or never was." });
                }

                const made = (await auth.api.createUser({ body: { name: String(body.name ?? ""), email: String(body.email ?? ""), password: String(body.password ?? ""), role: live.role } })) as { user: { id: string } };

                if (!store.useInvite(live.code, made.user.id)) {
                    await auth.api.removeUser({ body: { userId: made.user.id } });

                    return json(response, 409, { error: "Someone used this invite a moment ago." });
                }

                return json(response, 200, { ok: true });
            }
        }

        if (user === undefined) {
            return json(response, 401, { error: "Sign in first." });
        }

        // A QR code for an authenticator app (setting up two-factor): drawn here, so the secret leaves for nowhere else.
        if (route === "qr" && method === "POST") {
            const text = String((await readBody(request)).text ?? "");

            if (!text.startsWith("otpauth://") || text.length > 1024) {
                return json(response, 400, { error: "An otpauth:// address only." });
            }

            return json(response, 200, { svg: `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(text, { type: "svg", margin: 1 })).toString("base64")}` });
        }

        if (!owner) {
            return json(response, 403, { error: "Only the owner manages people and invites." });
        }

        if (route === "invites" && method === "GET") {
            return json(response, 200, { invites: store.invites(), minutes: INVITE_MINUTES, roles: ROLES });
        }

        if (route === "invites" && method === "POST") {
            const body = await readBody(request);
            const made = store.createInvite(String(body.role ?? "member") as Role, user.id, Number(body.minutes ?? 24 * 60));

            return json(response, 200, { ...made, url: `${this.#options.origin}/auth/invite/${made.code}` });
        }

        const cancel = /^invites\/([A-Za-z0-9_-]{10,64})\/cancel$/.exec(route);

        if (cancel !== null && method === "POST") {
            store.cancelInvite(cancel[1]!);

            return json(response, 200, { ok: true });
        }

        if (route === "people" && method === "GET") {
            const listed = (await auth.api.listUsers({ query: { limit: 200 }, headers: fromNodeHeaders(request.headers) })) as { users: User[] };

            return json(response, 200, {
                people: listed.users.map((each) => ({ id: each.id, name: each.name, email: each.email, role: each.role ?? "member", banned: each.banned === true, twoFactor: each.twoFactorEnabled === true, box: store.boxOf(each.id)?.key ?? null })),
            });
        }

        const act = /^people\/([A-Za-z0-9_-]{6,64})\/(reset-password|reset-two-factor|disable|enable|remove)$/.exec(route);

        if (act !== null && method === "POST") {
            const [, id, action] = act as unknown as [string, string, string];
            const headers = fromNodeHeaders(request.headers);

            if (id === user.id && action !== "reset-password") {
                return json(response, 400, { error: "Not on your own account." });
            }

            if (action === "reset-password") {
                const body = await readBody(request);

                await auth.api.setUserPassword({ body: { userId: id, newPassword: String(body.password ?? "") }, headers });
                await auth.api.revokeUserSessions({ body: { userId: id }, headers });
            } else if (action === "reset-two-factor") {
                store.resetTwoFactor(id);
                await auth.api.revokeUserSessions({ body: { userId: id }, headers });
            } else if (action === "disable") {
                await auth.api.banUser({ body: { userId: id, banReason: "disabled by the owner" }, headers });
                const box = store.boxOf(id);

                if (box !== undefined) {
                    this.#ready.delete(box.key);
                    await this.#options.controller.stop(box.key);
                }
            } else if (action === "enable") {
                await auth.api.unbanUser({ body: { userId: id }, headers });
            } else {
                const box = store.boxOf(id);

                if (box !== undefined) {
                    this.#ready.delete(box.key);
                    // The account goes; their data (the volume) stays, for an export or a return.
                    await this.#options.controller.remove(box.key, false);
                }

                await auth.api.removeUser({ body: { userId: id }, headers });
            }

            return json(response, 200, { ok: true });
        }

        return json(response, 404, { error: "No such route." });
    }
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, to: string): void {
    response.writeHead(303, { location: to, "cache-control": "no-store" });
    response.end();
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        size += (chunk as Buffer).length;

        if (size > 64 * 1024) {
            throw new Error("Too large.");
        }

        chunks.push(chunk as Buffer);
    }

    const text = Buffer.concat(chunks).toString("utf8");

    return text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
}

const STARTING = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3"><title>Starting…</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1a1b26;color:#c0caf5;font:16px system-ui">Starting your pi-phone…</body>`;
