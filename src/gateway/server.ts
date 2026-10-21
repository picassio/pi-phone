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
import { CATALOGUE, checkRole, OWNER_ROLE, type Permission } from "./roles.ts";
import { type GatewayStore, INVITE_MINUTES } from "./store.ts";

/** What the gateway asks the controller (`src/controller/`): a person's pi-phone, by key. */
/** A person's container as the controller lists it. */
export type Listed = { id: string; host: string; port: number; running: boolean; current: boolean };

export interface ControllerClient {
    /** `renew`: make it again from the current image even if it runs (PP-34). */
    ensure(key: string, token: string, caps: { memoryMb: number; cpus: number }, renew?: boolean): Promise<{ host: string; port: number }>;
    list(): Promise<Listed[]>;
    stop(key: string): Promise<void>;
    remove(key: string, purge: boolean): Promise<void>;
}

export type GatewayOptions = {
    auth: GatewayAuth;
    store: GatewayStore;
    controller: ControllerClient;
    /** The address people open: `https://…`. */
    origin: string;
    log: (line: string) => void;
    /** The clock (tests move it). */
    now?: () => number;
};

type User = { id: string; name: string; email: string; role?: string | null; banned?: boolean | null; twoFactorEnabled?: boolean | null };

const WEB = resolve(import.meta.dirname, "web");
const WEBAUTHN = resolve(import.meta.dirname, "..", "..", "node_modules", "@simplewebauthn", "browser", "esm");
/** pi-phone's own icon (web/icon.svg). */
const ICON_DIR = resolve(import.meta.dirname, "..", "..", "web");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

/** pi-phone's routes for signing in and managing people: the gateway does these, so they never reach a container. */
const REFUSED = [/^\/login(\/|$|\?)/, /^\/recover(\/|$|\?)/, /^\/api\/(invite|recovery-code|devices|users|sign-out-everywhere|logout|access|tailscale|policy|activity)(\/|$|\?)/];

/** How long a pi-phone found running is taken as running, before the controller is asked again. */
const READY_MS = 60_000;

export class Gateway {
    readonly #options: GatewayOptions;
    readonly #authHandler: ReturnType<typeof toNodeHandler>;
    /** People whose pi-phone the controller said is running, and when. */
    readonly #ready = new Map<string, { host: string; port: number; at: number }>();
    readonly #starting = new Map<string, Promise<{ host: string; port: number }>>();
    /** The policy each person's pi-phone has from this gateway, as JSON, by key (PP-22). */
    readonly #applied = new Map<string, string>();
    /** Requests and WebSockets open to each person's pi-phone now, by key: an open page keeps it up (PP-33). */
    readonly #open = new Map<string, number>();
    /** When each person's pi-phone was last used through this gateway, by key. */
    readonly #used = new Map<string, number>();
    /** Stops under way, by key: a visit waits for one before starting the pi-phone again. */
    readonly #stopping = new Map<string, Promise<void>>();
    readonly #now: () => number;
    /** When this gateway started: a pi-phone it has not seen used counts from then. */
    readonly #since: number;
    #sweeping = false;

    constructor(options: GatewayOptions) {
        this.#options = options;
        this.#authHandler = toNodeHandler(options.auth);
        this.#now = options.now ?? Date.now;
        this.#since = this.#now();
    }

    /** A request or WebSocket to a person's pi-phone opened (+1) or ended (-1). */
    #use(key: string, delta: 1 | -1): void {
        this.#open.set(key, Math.max(0, (this.#open.get(key) ?? 0) + delta));
        this.#used.set(key, this.#now());
    }

    /** Stop a person's pi-phone; their next visit waits for it, then starts it again. */
    async #stop(key: string, why: string): Promise<void> {
        const stopping = (async () => {
            this.#ready.delete(key);
            this.#applied.delete(key);
            await this.#options.controller.stop(key);
            this.#options.log(`gateway: stopped ${key} (${why})`);
        })().finally(() => this.#stopping.delete(key));

        this.#stopping.set(key, stopping);
        await stopping;
    }

    /** What a person's pi-phone says it is doing (`/api/activity`), or undefined when it does not answer. */
    async #activity(place: { host: string; port: number }, token: string): Promise<{ busy: boolean; why?: string } | undefined> {
        return new Promise((resolve) => {
            const call = httpRequest({ host: place.host, port: place.port, method: "GET", path: "/api/activity", timeout: 5000, headers: { host: `${place.host}:${place.port}`, authorization: `Bearer ${token}`, "x-pocket": "1" } }, (answer) => {
                const chunks: Buffer[] = [];

                answer.on("data", (chunk: Buffer) => chunks.push(chunk));
                answer.on("end", () => {
                    try {
                        resolve(answer.statusCode === 200 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { busy: boolean; why?: string }) : undefined);
                    } catch {
                        resolve(undefined);
                    }
                });
            });

            call.on("error", () => resolve(undefined));
            call.on("timeout", () => call.destroy());
            call.end();
        });
    }

    /**
     * What a running pi-phone is doing, as the sweep asks. One this gateway has not reached yet goes through the controller
     * first: a gateway made again (an update, a restart) is on none of the people's networks until then.
     */
    async #doing(userId: string, place: { host: string; port: number }, token: string): Promise<{ busy: boolean; why?: string } | undefined> {
        const key = this.#options.store.box(userId).key;

        if (!this.#ready.has(key)) {
            const person = this.#options.store.users().find((each) => each.id === userId);

            if (person === undefined) {
                return undefined;
            }

            try {
                await this.#upstream(person);
            } catch (error) {
                this.#options.log(`gateway: reaching ${key}: ${String(error)}`);

                return undefined;
            }
        }

        return this.#activity(place, token);
    }

    /**
     * One look at everyone's pi-phone (every minute, `sweeping`): a running one stops when nothing is open to it, it was
     * not used for the server's idle minutes, and it says it is not at work (PP-33). One that does not answer is left.
     */
    async sweep(): Promise<void> {
        if (this.#sweeping) {
            return;
        }

        this.#sweeping = true;

        try {
            const minutes = this.#options.store.idleMinutes();
            const kept = new Set(this.#options.store.alwaysOnPeople());
            const listed = await this.#options.controller.list();

            // Always on: started when it is not running (stopped before, or never yet), with its role's policy.
            for (const userId of kept) {
                const box = this.#options.store.boxOf(userId);

                await this.#keepUp(userId, box === undefined || !listed.some((each) => each.id === box.key && each.running));
            }

            const stopped = new Set<string>();

            for (const each of minutes === 0 ? [] : listed) {
                const box = this.#options.store.boxByKey(each.id);

                if (!each.running || box === undefined || kept.has(box.userId) || (this.#open.get(each.id) ?? 0) > 0 || this.#stopping.has(each.id) || this.#starting.has(each.id)) {
                    continue;
                }

                if (this.#now() - (this.#used.get(each.id) ?? this.#since) < minutes * 60_000) {
                    continue;
                }

                const doing = await this.#doing(box.userId, each, box.token);

                if (doing === undefined || doing.busy) {
                    continue;
                }

                await this.#stop(each.id, `idle for ${minutes} min`);
                stopped.add(each.id);
            }

            // A new image (PP-34): running pi-phones of an older one are made again from it, one at a time, each answering
            // before the next; one at work waits for a later sweep. Stopped ones are made again as they next start.
            for (const each of listed) {
                const box = this.#options.store.boxByKey(each.id);

                if (!each.running || each.current || box === undefined || stopped.has(each.id) || this.#stopping.has(each.id) || this.#starting.has(each.id)) {
                    continue;
                }

                const doing = await this.#doing(box.userId, each, box.token);

                if (doing === undefined || doing.busy) {
                    continue;
                }

                await this.#renew(box.userId);
            }
        } catch (error) {
            this.#options.log(`gateway: sweep: ${String(error)}`);
        } finally {
            this.#sweeping = false;
        }
    }

    /**
     * Keep a person's pi-phone running (always on): started if it is not, and given their role's policy, tried for a
     * while as it starts, so it never works without the role's limits for long. Not for someone disabled, or whose role
     * has no pi-phone.
     */
    async #keepUp(userId: string, stopped: boolean): Promise<void> {
        const person = this.#options.store.users().find((each) => each.id === userId);

        if (person === undefined || person.banned || !this.#options.store.can(person.id, person.role, "pi.use") || this.#stopping.has(this.#options.store.box(userId).key)) {
            return;
        }

        try {
            const upstream = await this.#upstream(person, stopped);

            for (let tries = 0; tries < 15 && !(await this.#policy(person, upstream)); tries++) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }
        } catch (error) {
            this.#options.log(`gateway: keeping ${userId}'s pi-phone up: ${String(error)}`);
        }
    }

    /**
     * Make a person's pi-phone again from the current image (PP-34), keeping their data. A visit meanwhile waits for it.
     * Done once it has their role's policy again, so the next one waits for this one to answer (a minute at most).
     */
    async #renew(userId: string): Promise<void> {
        const person = this.#options.store.users().find((each) => each.id === userId);

        if (person === undefined) {
            return;
        }

        const box = this.#options.store.box(userId);
        const role = this.#options.store.roleOf(person.id, person.role);
        const renewing = this.#options.controller.ensure(box.key, box.token, { memoryMb: role.memoryMb, cpus: role.cpus }, true).finally(() => this.#starting.delete(box.key));

        this.#ready.delete(box.key);
        this.#applied.delete(box.key);
        this.#starting.set(box.key, renewing);

        try {
            const place = await renewing;

            this.#ready.set(box.key, { ...place, at: Date.now() });

            for (let tries = 0; tries < 30 && !(await this.#policy(person, { ...place, token: box.token })); tries++) {
                await new Promise((resolve) => setTimeout(resolve, 2000));
            }

            this.#options.log(`gateway: ${box.key} on the new image`);
        } catch (error) {
            this.#options.log(`gateway: ${box.key} to the new image: ${String(error)}`);
        }
    }

    /** Sweep every minute; returns how to stop. */
    sweeping(): () => void {
        const timer = setInterval(() => void this.sweep(), 60_000);

        timer.unref();

        return () => clearInterval(timer);
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

        // Stopping (idle) a moment ago: started again once that is done.
        await this.#stopping.get(box.key);

        let starting = this.#starting.get(box.key);

        if (starting === undefined) {
            // The memory and CPU of the person's role (PP-22); a changed role is applied on the next start.
            const role = this.#options.store.roleOf(user.id, user.role);

            starting = this.#options.controller.ensure(box.key, box.token, { memoryMb: role.memoryMb, cpus: role.cpus }).finally(() => this.#starting.delete(box.key));
            this.#starting.set(box.key, starting);
        }

        const place = await starting;

        this.#ready.set(box.key, { ...place, at: Date.now() });

        return { ...place, token: box.token };
    }

    /**
     * Send a person's pi-phone their role's policy (PP-22), unless it has it already: their permissions, models, and spend
     * cap, which it applies at once. False when it could not be sent (still starting): nothing is forwarded until it is,
     * so a pi-phone never serves its person without their role's limits.
     */
    async #policy(user: User, upstream: { host: string; port: number; token: string }): Promise<boolean> {
        const role = this.#options.store.roleOf(user.id, user.role);
        const policy = JSON.stringify({ permissions: role.permissions, models: role.models, spendLimit: role.spendLimit, role: role.name });
        const key = this.#options.store.box(user.id).key;

        if (this.#applied.get(key) === policy) {
            return true;
        }

        const sent = await new Promise<boolean>((resolve) => {
            const call = httpRequest(
                { host: upstream.host, port: upstream.port, method: "POST", path: "/api/policy", timeout: 5000, headers: { host: `${upstream.host}:${upstream.port}`, authorization: `Bearer ${upstream.token}`, "x-pocket": "1", "content-type": "application/json", "content-length": Buffer.byteLength(policy) } },
                (answer) => {
                    answer.resume();
                    resolve(answer.statusCode === 200);
                },
            );

            call.on("error", () => resolve(false));
            call.on("timeout", () => call.destroy());
            call.end(policy);
        });

        if (sent) {
            this.#applied.set(key, policy);
        }

        return sent;
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

            // A role without a pi-phone of its own (Viewer): only the gateway's pages, and what others share with them.
            if (!this.#options.store.can(user.id, user.role, "pi.use")) {
                if (request.method === "GET" && (request.headers.accept ?? "").includes("text/html")) {
                    response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                    response.end(NO_PI);

                    return;
                }

                return json(response, 403, { error: "Your role has no pi-phone of its own." });
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
        const key = this.#options.store.box(user.id).key;

        // In use while the request is open (a page's event stream stays open as long as the page).
        this.#use(key, 1);

        try {
            await this.#forwardTo(request, response, user, retried);
        } finally {
            this.#use(key, -1);
        }
    }

    async #forwardTo(request: IncomingMessage, response: ServerResponse, user: User, retried: boolean): Promise<void> {
        const upstream = await this.#upstream(user, retried);

        // Not before it has the person's role's policy (PP-22).
        if (!(await this.#policy(user, upstream))) {
            if (request.method === "GET" && (request.headers.accept ?? "").includes("text/html")) {
                response.writeHead(503, { "content-type": "text/html; charset=utf-8", "retry-after": "3", "cache-control": "no-store" });
                response.end(STARTING);
            } else {
                json(response, 503, { error: "Your pi-phone is starting: try again in a moment." });
            }

            return;
        }

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

            if (user === undefined || REFUSED.some((pattern) => pattern.test(request.url ?? "/")) || !this.#options.store.can(user.id, user.role, "pi.use")) {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

                return;
            }

            // A WebSocket from another site carries its own Origin: only the gateway's own pages may open one.
            if (request.headers.origin !== this.#options.origin) {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

                return;
            }

            const upstream = await this.#upstream(user);

            if (!(await this.#policy(user, upstream))) {
                socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");

                return;
            }

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
            const key = this.#options.store.box(user.id).key;

            this.#use(key, 1);
            socket.once("close", () => this.#use(key, -1));

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

    /** The gateway's own routes, for its page. Each checks a permission of the person's role (PP-22). */
    async #gatewayRoute(request: IncomingMessage, response: ServerResponse, route: string): Promise<void> {
        const { auth, store } = this.#options;
        const method = request.method ?? "GET";
        const user = await this.#user(request);
        const role = user === undefined ? undefined : store.roleOf(user.id, user.role);
        const can = (permission: Permission) => role?.permissions.includes(permission) === true;
        const isOwner = role?.id === OWNER_ROLE.id;

        // What the page needs: whether the owner is still to be set up, and who is signed in, with their role.
        if (route === "state" && method === "GET") {
            return json(response, 200, {
                setup: store.userCount() === 0,
                me:
                    user === undefined || role === undefined
                        ? null
                        : { id: user.id, name: user.name, email: user.email, role: role.id, roleName: role.name, permissions: role.permissions, twoFactor: user.twoFactorEnabled === true },
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

            const made = (await auth.api.createUser({ body: { name: String(body.name ?? "Owner"), email: String(body.email ?? ""), password: String(body.password ?? ""), role: "owner" } })) as { user: { id: string } };

            store.audit(made.user.id, "setup", made.user.id);

            return json(response, 200, { ok: true });
        }

        // An invite as its link shows it, and spending it for a new account with its role.
        const invite = /^invite\/([A-Za-z0-9_-]{10,64})$/.exec(route);

        if (invite !== null) {
            const live = store.liveInvite(invite[1]!);

            if (method === "GET") {
                return json(response, live === undefined ? 404 : 200, live === undefined ? { error: "This invite is used, expired, or never was." } : { role: store.role(live.role)?.name ?? live.role, expiresAt: live.expiresAt });
            }

            if (method === "POST") {
                const body = await readBody(request);

                if (live === undefined || store.role(live.role) === undefined) {
                    return json(response, 404, { error: "This invite is used, expired, or never was." });
                }

                const made = (await auth.api.createUser({ body: { name: String(body.name ?? ""), email: String(body.email ?? ""), password: String(body.password ?? ""), role: live.role === OWNER_ROLE.id ? "owner" : "member" } })) as { user: { id: string } };

                if (!store.useInvite(live.code, made.user.id)) {
                    await (await auth.$context).internalAdapter.deleteUser(made.user.id);

                    return json(response, 409, { error: "Someone used this invite a moment ago." });
                }

                store.setRoleOf(made.user.id, live.role);
                store.audit(made.user.id, "joined", made.user.id, { role: live.role, invitedBy: live.createdBy });

                return json(response, 200, { ok: true });
            }
        }

        if (user === undefined || role === undefined) {
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

        // Roles: who may see them (to invite or assign), and who may change them.
        if (route === "roles" && method === "GET") {
            if (!can("people.invite") && !can("people.manage") && !can("roles.manage")) {
                return json(response, 403, { error: "Your role does not see roles." });
            }

            // Everyone by the role they have now (someone never given one has Member's).
            const counts: Record<string, number> = {};

            for (const each of store.users()) {
                const id = store.roleOf(each.id, each.role).id;

                counts[id] = (counts[id] ?? 0) + 1;
            }

            return json(response, 200, { roles: store.roles(), counts, catalogue: CATALOGUE });
        }

        if (route === "roles" && method === "POST") {
            if (!can("roles.manage")) {
                return json(response, 403, { error: "Your role does not change roles." });
            }

            const body = await readBody(request);
            const base = String(body.name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role";
            let id = base;

            for (let n = 2; store.role(id) !== undefined; n += 1) {
                id = `${base}-${n}`;
            }

            let made;

            try {
                made = checkRole(body, id);
            } catch (error) {
                return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }

            store.saveRole(made);
            store.audit(user.id, "role created", id, { role: made });

            return json(response, 200, made);
        }

        const roleRoute = /^roles\/([a-z0-9-]{1,48})(\/delete)?$/.exec(route);

        if (roleRoute !== null && method === "POST") {
            const [, id, remove] = roleRoute as unknown as [string, string, string | undefined];

            if (!can("roles.manage")) {
                return json(response, 403, { error: "Your role does not change roles." });
            }

            if (id === OWNER_ROLE.id || store.role(id) === undefined) {
                return json(response, id === OWNER_ROLE.id ? 400 : 404, { error: id === OWNER_ROLE.id ? "The owner's role is built in." : "No such role." });
            }

            if (remove !== undefined) {
                // Anyone with it now, given it or by default (Member), keeps it from going.
                if (store.users().some((each) => store.roleOf(each.id, each.role).id === id) || !store.deleteRole(id)) {
                    return json(response, 409, { error: "People still have this role: give them another first." });
                }

                store.audit(user.id, "role deleted", id);

                return json(response, 200, { ok: true });
            }

            let changed;

            try {
                changed = checkRole(await readBody(request), id);
            } catch (error) {
                return json(response, 400, { error: error instanceof Error ? error.message : String(error) });
            }

            store.saveRole(changed);
            store.audit(user.id, "role changed", id, { role: changed });
            this.#recap(id);

            return json(response, 200, changed);
        }

        // The server's settings (PP-33): when idle pi-phones stop; and how many there are, running and on an old image.
        if (route === "server") {
            if (!can("server.manage")) {
                return json(response, 403, { error: "Your role does not manage the server." });
            }

            if (method === "POST") {
                const minutes = Number((await readBody(request)).idleMinutes);

                if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
                    return json(response, 400, { error: "Idle minutes are a whole number from 0 (never stop) to 1440." });
                }

                store.setIdleMinutes(minutes);
                store.audit(user.id, "server settings", undefined, { idleMinutes: minutes });
            }

            const listed = await this.#options.controller.list();

            return json(response, 200, {
                idleMinutes: store.idleMinutes(),
                containers: { all: listed.length, running: listed.filter((each) => each.running).length, outdated: listed.filter((each) => !each.current).length },
            });
        }

        if (route === "audit" && method === "GET") {
            if (!can("audit.view")) {
                return json(response, 403, { error: "Your role does not see the audit log." });
            }

            return json(response, 200, { entries: store.auditLog() });
        }

        if (route === "invites" && method === "GET") {
            if (!can("people.invite")) {
                return json(response, 403, { error: "Your role does not invite people." });
            }

            return json(response, 200, { invites: store.invites(), minutes: INVITE_MINUTES });
        }

        if (route === "invites" && method === "POST") {
            const body = await readBody(request);
            const roleId = String(body.role ?? "member");

            if (!can("people.invite")) {
                return json(response, 403, { error: "Your role does not invite people." });
            }

            if (roleId === OWNER_ROLE.id && !isOwner) {
                return json(response, 403, { error: "Only an owner invites an owner." });
            }

            const made = store.createInvite(roleId, user.id, Number(body.minutes ?? 24 * 60));

            store.audit(user.id, "invite made", made.code.slice(0, 6), { role: roleId, expiresAt: made.expiresAt });

            return json(response, 200, { ...made, url: `${this.#options.origin}/auth/invite/${made.code}` });
        }

        const cancel = /^invites\/([A-Za-z0-9_-]{10,64})\/cancel$/.exec(route);

        if (cancel !== null && method === "POST") {
            if (!can("people.invite")) {
                return json(response, 403, { error: "Your role does not invite people." });
            }

            store.cancelInvite(cancel[1]!);
            store.audit(user.id, "invite cancelled", cancel[1]!.slice(0, 6));

            return json(response, 200, { ok: true });
        }

        if (route === "people" && method === "GET") {
            if (!can("people.manage") && !can("people.invite")) {
                return json(response, 403, { error: "Your role does not see people." });
            }

            return json(response, 200, {
                people: store.users().map((each) => {
                    const theirs = store.roleOf(each.id, each.role);

                    return { id: each.id, name: each.name, email: each.email, role: theirs.id, roleName: theirs.name, banned: each.banned === true, twoFactor: each.twoFactorEnabled === true, box: store.boxOf(each.id)?.key ?? null, alwaysOn: store.alwaysOn(each.id) };
                }),
            });
        }

        // Always on (PP-33): a person's pi-phone never stops when idle, and starts by itself. The server's to decide (your own too).
        const keep = /^people\/([A-Za-z0-9_-]{6,64})\/always-on$/.exec(route);

        if (keep !== null && method === "POST") {
            if (!can("server.manage")) {
                return json(response, 403, { error: "Your role does not manage the server." });
            }

            const id = keep[1]!;

            if (!store.users().some((each) => each.id === id)) {
                return json(response, 404, { error: "No such person." });
            }

            const on = (await readBody(request)).on === true;

            store.setAlwaysOn(id, on);
            store.audit(user.id, on ? "always on" : "not always on", id);

            if (on) {
                await this.#keepUp(id, true);
            }

            return json(response, 200, { ok: true, alwaysOn: on });
        }

        const act = /^people\/([A-Za-z0-9_-]{6,64})\/(reset-password|reset-two-factor|disable|enable|remove|role)$/.exec(route);

        if (act !== null && method === "POST") {
            const [, id, action] = act as unknown as [string, string, string];
            const body = await readBody(request);

            if (!can("people.manage")) {
                return json(response, 403, { error: "Your role does not manage people." });
            }

            const target = store.users().find((each) => each.id === id);

            if (target === undefined) {
                return json(response, 404, { error: "No such person." });
            }

            const targetRole = store.roleOf(target.id, target.role);

            if (id === user.id && action !== "reset-password") {
                return json(response, 400, { error: "Not on your own account." });
            }

            if (targetRole.id === OWNER_ROLE.id && !isOwner) {
                return json(response, 403, { error: "Only an owner acts on an owner." });
            }

            if (action === "role") {
                const roleId = String(body.role ?? "");

                if (store.role(roleId) === undefined) {
                    return json(response, 400, { error: `There is no role ${roleId}.` });
                }

                if (roleId === OWNER_ROLE.id && !isOwner) {
                    return json(response, 403, { error: "Only an owner makes an owner." });
                }

                // Never no owner: the last one keeps the role.
                if (targetRole.id === OWNER_ROLE.id && roleId !== OWNER_ROLE.id && this.#owners() <= 1) {
                    return json(response, 409, { error: "This is the only owner: make someone else owner first." });
                }

                store.setAuthRole(id, roleId === OWNER_ROLE.id ? "owner" : "member");
                store.setRoleOf(id, roleId);
                store.audit(user.id, "role given", id, { from: targetRole.id, to: roleId });
                this.#forgetReady(id);

                return json(response, 200, { ok: true });
            }

            // better-auth's own adapter, its hashing and sessions: the gateway's roles decided who may (its admin API wants an
            // admin of its own, which a person with a custom role is not).
            const ctx = await auth.$context;

            if (action === "reset-password") {
                const password = String(body.password ?? "");

                if (password.length < 10 || password.length > 256) {
                    return json(response, 400, { error: "A password is 10 to 256 characters." });
                }

                await ctx.internalAdapter.updatePassword(id, await ctx.password.hash(password));
                await ctx.internalAdapter.deleteUserSessions(id);
            } else if (action === "reset-two-factor") {
                store.resetTwoFactor(id);
                await ctx.internalAdapter.deleteUserSessions(id);
            } else if (action === "disable") {
                await ctx.internalAdapter.updateUser(id, { banned: true, banReason: "disabled" });
                await ctx.internalAdapter.deleteUserSessions(id);
                const box = store.boxOf(id);

                if (box !== undefined) {
                    await this.#stop(box.key, "disabled");
                }
            } else if (action === "enable") {
                await ctx.internalAdapter.updateUser(id, { banned: false, banReason: null, banExpires: null });
            } else {
                if (targetRole.id === OWNER_ROLE.id && this.#owners() <= 1) {
                    return json(response, 409, { error: "This is the only owner." });
                }

                const box = store.boxOf(id);

                if (box !== undefined) {
                    this.#ready.delete(box.key);
                    // The account goes; their data (the volume) stays, for an export or a return.
                    await this.#options.controller.remove(box.key, false);
                }

                store.forgetAuthExtras(id);
                store.setAlwaysOn(id, false);
                await ctx.internalAdapter.deleteUser(id);
                store.forgetRoleOf(id);
            }

            store.audit(user.id, action, id);

            return json(response, 200, { ok: true });
        }

        return json(response, 404, { error: "No such route." });
    }

    /** How many owners there are. */
    #owners(): number {
        return this.#options.store.ownerCount();
    }

    /** A person's pi-phone is asked for again on their next request (their role, and so its caps, changed). */
    #forgetReady(userId: string): void {
        const box = this.#options.store.boxOf(userId);

        if (box !== undefined) {
            this.#ready.delete(box.key);
        }
    }

    /** Everyone with role `roleId` gets its caps on their next request. */
    #recap(roleId: string): void {
        for (const [userId] of this.#options.store.peopleWithRole(roleId)) {
            this.#forgetReady(userId);
        }
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

const NO_PI = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>pi-phone</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1a1b26;color:#c0caf5;font:16px system-ui;text-align:center;padding:24px"><div><p>Your role has no pi-phone of its own: you see what others share with you.</p><p><a style="color:#7aa2f7" href="/auth/account">Your account</a></p></div></body>`;

const STARTING = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="3"><title>Starting…</title><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#1a1b26;color:#c0caf5;font:16px system-ui">Starting your pi-phone…</body>`;
