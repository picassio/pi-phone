// The server edition's gateway (src/gateway/), with better-auth on an in-memory database, a stand-in controller, and a
// stand-in pi-phone behind it: the owner is set up only with the setup token and only once; signing in forwards to your
// own pi-phone with its owner token and none of your cookies; another person reaches only theirs; pi-phone's own sign-in
// and invites are refused; an invite makes one account, with its role, once; TOTP asks for a code after the password; a
// person the owner disables is signed out and their pi-phone stopped; and a WebSocket from another page is refused.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { served } from "./gateway-served.ts";

after(() => cleanUp());

/** What the stand-in pi-phone was asked: by path, its headers. */
const asked: { path: string; headers: IncomingHttpHeaders }[] = [];
/** The policies the gateway sent, by the pi-phone token they went with (PP-22). */
const policies: Record<string, { permissions: string[]; models: string[]; spendLimit: number | null; role: string }> = {};
const controllerCalls: string[] = [];
/** The caps each person's pi-phone was last started with, by key. */
const capsOf: Record<string, { memoryMb: number; cpus: number }> = {};
let upstream: Server;
let upstreamPort = 0;
let gateway: Server;
let origin = "";
let store: GatewayStore;

const controller: ControllerClient = {
    ensure: async (key, _token, caps) => {
        controllerCalls.push(`ensure ${key}`);
        capsOf[key] = caps;

        return { host: "127.0.0.1", port: upstreamPort };
    },
    list: async () => [],
    export: async () => Readable.from([]),
    stop: async (key) => void controllerCalls.push(`stop ${key}`),
    remove: async (key, purge) => void controllerCalls.push(`remove ${key} ${purge}`),
};

before(async () => {
    upstream = createServer((request, response) => {
        if (request.url === "/api/policy" && request.method === "POST") {
            const chunks: Buffer[] = [];

            request.on("data", (chunk: Buffer) => chunks.push(chunk));
            request.on("end", () => {
                policies[String(request.headers.authorization)] = JSON.parse(Buffer.concat(chunks).toString());
                response.writeHead(200, { "content-type": "application/json" });
                response.end("{}");
            });

            return;
        }

        asked.push({ path: request.url ?? "/", headers: request.headers });
        response.writeHead(200, { "content-type": "text/plain", "set-cookie": "pocket_auth=leak; Path=/" });
        response.end(`pi-phone for ${request.headers.authorization}`);
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;

    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);
    gateway = createServer();
    await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;

    const auth = await makeAuth({ db, secret: store.authSecret(), origin });

    const handler = new Gateway({ auth, store, controller, ...served(store), origin, log: (line) => console.error(line) });

    gateway.on("request", (request, response) => void handler.handle(request, response));
    gateway.on("upgrade", (request, socket, head) => void handler.upgrade(request, socket, head));
});

after(() => {
    upstream?.close();
    gateway?.closeAllConnections();
    gateway?.close();
});

/** A browser: its cookies, and requests from the gateway's own page (its Origin). */
function browser() {
    let cookies: Record<string, string> = {};
    const go = async (path: string, body?: unknown, method?: string) => {
        const response = await fetch(`${origin}${path}`, {
            method: method ?? (body === undefined ? "GET" : "POST"),
            redirect: "manual",
            headers: {
                origin,
                accept: "application/json",
                cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join("; "),
                ...(body === undefined ? {} : { "content-type": "application/json" }),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        for (const line of response.headers.getSetCookie()) {
            const [pair] = line.split(";");
            const [name, ...value] = pair!.split("=");

            cookies = { ...cookies, [name!.trim()]: value.join("=") };

            if (/Max-Age=0/i.test(line)) {
                delete cookies[name!.trim()];
            }
        }

        const text = await response.text();
        let data: Record<string, unknown> = {};

        try {
            data = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
        } catch {
            data = { text };
        }

        return { status: response.status, location: response.headers.get("location"), data, setCookie: response.headers.getSetCookie() };
    };

    return { go, cookies: () => cookies };
}

/** The TOTP code for an otpauth:// secret now (RFC 6238: SHA-1, 30 s, 6 digits). */
function totp(uri: string): string {
    const secret = new URL(uri).searchParams.get("secret")!;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let bits = "";

    for (const char of secret.replace(/=+$/, "").toUpperCase()) {
        bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
    }

    const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
    const counter = Buffer.alloc(8);

    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));

    const mac = createHmac("sha1", key).update(counter).digest();
    const offset = mac[mac.length - 1]! & 0xf;

    return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

test("the owner's setup, sign-in, forwarding to your own pi-phone, invites, TOTP, and disabling", async () => {
    const owner = browser();

    // Before any account: the page says to set up; nobody is signed in; pi-phone is behind the sign-in.
    assert.deepEqual((await owner.go("/auth/gw/state")).data, { setup: true, me: null });
    assert.equal((await owner.go("/")).status, 303);
    assert.match((await fetch(`${origin}/`, { redirect: "manual" })).headers.get("location") ?? "", /^\/auth\/sign-in\?next=%2F$/);
    assert.equal((await owner.go("/api/me")).status, 401);
    assert.equal((await owner.go("/auth/gw/setup", { setupToken: "wrong", name: "Tuan", email: "tuan@example.com", password: "a long password 1" })).status, 403);
    assert.equal((await owner.go("/auth/gw/setup", { setupToken: store.setupToken(), name: "Tuan", email: "tuan@example.com", password: "a long password 1" })).status, 200);
    assert.equal((await owner.go("/auth/gw/setup", { setupToken: store.setupToken(), name: "Again", email: "again@example.com", password: "a long password 1" })).status, 409, "only once");
    // No sign-up but by invite or setup.
    assert.notEqual((await browser().go("/auth/api/sign-up/email", { name: "X", email: "x@example.com", password: "a long password 1" })).status, 200);

    assert.equal((await owner.go("/auth/api/sign-in/email", { email: "tuan@example.com", password: "a long password 1" })).status, 200);
    const me = (await owner.go("/auth/gw/state")).data.me as { id: string; role: string };

    assert.equal(me.role, "owner");

    // Forwarded to the owner's own pi-phone: its token, no cookies of the browser's, none of the container's back.
    const proxied = await owner.go("/s/1?x=1");
    const box = store.boxOf(me.id)!;

    assert.equal(proxied.status, 200);
    assert.equal(proxied.data.text, `pi-phone for Bearer ${box.token}`);
    assert.deepEqual(proxied.setCookie, [], "the container's cookies stay behind");
    assert.equal(asked.at(-1)!.path, "/s/1?x=1");
    assert.equal(asked.at(-1)!.headers.cookie, undefined, "the gateway's cookies are not forwarded");
    assert.equal(asked.at(-1)!.headers["x-forwarded-proto"], "http");
    assert.equal(controllerCalls.filter((call) => call === `ensure ${box.key}`).length, 1, "started once, then known");
    await owner.go("/api/sessions");
    assert.equal(controllerCalls.filter((call) => call === `ensure ${box.key}`).length, 1);

    // pi-phone's own sign-in and people: the gateway's.
    assert.equal((await owner.go("/api/invite", {})).status, 403);
    assert.equal((await owner.go("/api/devices")).status, 403);
    assert.equal((await owner.go("/login?token=x")).location, "/auth/account");

    // An invite: one account, with its role, once.
    const invite = (await owner.go("/auth/gw/invites", { role: "member", minutes: 1440 })).data as { code: string; url: string };

    assert.match(invite.url, new RegExp(`^${origin}/auth/invite/`));
    assert.equal((await browser().go(`/auth/gw/invite/${invite.code}`)).data.role, "Member", "the role by its name");

    const member = browser();

    assert.equal((await member.go(`/auth/gw/invite/${invite.code}`, { name: "Han", email: "han@example.com", password: "another long one 2" })).status, 200);
    assert.equal((await browser().go(`/auth/gw/invite/${invite.code}`, { name: "Eve", email: "eve@example.com", password: "another long one 3" })).status, 404, "used");
    assert.equal((await member.go("/auth/api/sign-in/email", { email: "han@example.com", password: "another long one 2" })).status, 200);

    const han = (await member.go("/auth/gw/state")).data.me as { id: string; role: string };

    assert.equal(han.role, "member");
    assert.equal((await member.go("/auth/gw/people")).status, 403, "only the owner manages people");

    // Han reaches Han's pi-phone, not the owner's.
    const hanBox = store.boxOf(han.id) ?? store.box(han.id);

    assert.equal((await member.go("/")).data.text, `pi-phone for Bearer ${hanBox.token}`);
    assert.notEqual(hanBox.token, box.token);
    assert.notEqual(hanBox.key, box.key);

    // TOTP: on after a code, then asked for after the password.
    const enabled = (await member.go("/auth/api/two-factor/enable", { password: "another long one 2" })).data as { totpURI: string };

    assert.match(enabled.totpURI, /^otpauth:\/\/totp\//);
    assert.match(String((await member.go("/auth/gw/qr", { text: enabled.totpURI })).data.svg), /^data:image\/svg\+xml;base64,/);
    assert.equal((await member.go("/auth/api/two-factor/verify-totp", { code: totp(enabled.totpURI) })).status, 200);
    await member.go("/auth/api/sign-out", {});
    assert.equal((await member.go("/")).status, 303, "signed out");

    const again = browser();
    const first = await again.go("/auth/api/sign-in/email", { email: "han@example.com", password: "another long one 2" });

    assert.equal(first.data.twoFactorRedirect, true);
    assert.equal((await again.go("/")).status, 303, "not in before the code");
    assert.equal((await again.go("/auth/api/two-factor/verify-totp", { code: totp(enabled.totpURI) })).status, 200);
    assert.equal((await again.go("/")).status, 200);

    // The owner sees people, resets Han's 2FA, then disables Han: signed out, pi-phone stopped.
    const listed = (await owner.go("/auth/gw/people")).data.people as { id: string; twoFactor: boolean }[];

    assert.equal(listed.find((each) => each.id === han.id)?.twoFactor, true);
    assert.equal((await owner.go(`/auth/gw/people/${han.id}/reset-two-factor`, {})).status, 200);
    assert.equal(((await owner.go("/auth/gw/people")).data.people as { id: string; twoFactor: boolean }[]).find((each) => each.id === han.id)?.twoFactor, false);
    assert.equal((await owner.go(`/auth/gw/people/${han.id}/disable`, {})).status, 200);
    assert.ok(controllerCalls.includes(`stop ${hanBox.key}`));
    assert.equal((await again.go("/")).status, 303, "a disabled person is out");
    assert.equal((await owner.go(`/auth/gw/people/${me.id}/disable`, {})).status, 400, "not yourself");
});

test("custom roles (PP-22): the owner's catalogue, a role's caps and permissions, no pi-phone for a viewer, the last owner kept, and the audit log", async () => {
    const owner = browser();

    assert.equal((await owner.go("/auth/api/sign-in/email", { email: "tuan@example.com", password: "a long password 1" })).status, 200);

    const listed = (await owner.go("/auth/gw/roles")).data as { roles: { id: string; builtin: boolean; memoryMb: number }[]; catalogue: { group: string }[] };

    assert.deepEqual(listed.roles.map((role) => role.id), ["owner", "admin", "member", "viewer"], "the owner's, then the seeded ones");
    assert.equal(listed.roles[0]!.builtin, true);
    assert.deepEqual(listed.catalogue.map((group) => group.group), ["People", "Server", "Documents", "Their own pi-phone", "Sharing"]);

    // A role of the owner's own: checked, then used for an invite; its caps reach the controller.
    const bad = await owner.go("/auth/gw/roles", { name: "Bad", permissions: ["no.such"], memoryMb: 1024, cpus: 1 });

    assert.equal(bad.status, 400);
    assert.match(String(bad.data.error), /No such permission: no\.such/);

    const contractor = (await owner.go("/auth/gw/roles", { name: "Contractor", permissions: ["pi.use", "web.search", "people.manage", "people.invite"], memoryMb: 1536, cpus: 0.5, models: ["anthropic/claude-haiku-5-5"], spendLimit: 20 })).data as { id: string };

    assert.equal(contractor.id, "contractor");

    const invite = (await owner.go("/auth/gw/invites", { role: "contractor", minutes: 60 })).data as { code: string };
    const worker = browser();

    assert.equal((await worker.go(`/auth/gw/invite/${invite.code}`, { name: "Kim", email: "kim@example.com", password: "kims long password" })).status, 200);
    await worker.go("/auth/api/sign-in/email", { email: "kim@example.com", password: "kims long password" });

    const kim = (await worker.go("/auth/gw/state")).data.me as { id: string; role: string; permissions: string[] };

    assert.equal(kim.role, "contractor");
    assert.equal((await worker.go("/")).status, 200);
    assert.deepEqual(capsOf[store.boxOf(kim.id)!.key], { memoryMb: 1536, cpus: 0.5 }, "the role's caps");
    // Kim's pi-phone got Kim's role's policy before anything else (PP-22), and Kim can't send one.
    assert.deepEqual(policies[`Bearer ${store.boxOf(kim.id)!.token}`], { permissions: ["pi.use", "web.search", "people.manage", "people.invite"], models: ["anthropic/claude-haiku-5-5"], spendLimit: 20, role: "Contractor" });
    assert.equal((await worker.go("/api/policy", { permissions: ["browser.use"], models: [], spendLimit: null, role: "x" })).status, 403);

    // Kim's role manages people (not better-auth's admin): Kim resets a member's password, but not an owner's, and
    // invites neither an owner nor changes roles.
    const people = (await worker.go("/auth/gw/people")).data.people as { id: string; email: string; role: string }[];
    const han = people.find((each) => each.email === "han@example.com")!;
    const tuan = people.find((each) => each.email === "tuan@example.com")!;

    assert.equal((await worker.go(`/auth/gw/people/${han.id}/reset-password`, { password: "a brand new one 4" })).status, 200);
    assert.equal((await worker.go(`/auth/gw/people/${tuan.id}/reset-password`, { password: "a brand new one 5" })).status, 403, "not an owner's");
    assert.equal((await worker.go("/auth/gw/invites", { role: "owner", minutes: 60 })).status, 403, "only an owner invites an owner");
    assert.equal((await worker.go("/auth/gw/roles", { name: "Mine", permissions: [], memoryMb: 512, cpus: 1 })).status, 403, "roles.manage is not theirs");
    assert.equal((await worker.go("/auth/gw/audit")).status, 403);

    // A viewer has no pi-phone of their own. (Han was disabled by the test before: enabled again first.)
    assert.equal((await owner.go(`/auth/gw/people/${han.id}/enable`, {})).status, 200);
    assert.equal((await owner.go(`/auth/gw/people/${han.id}/role`, { role: "viewer" })).status, 200);

    const viewer = browser();

    await viewer.go("/auth/api/sign-in/email", { email: "han@example.com", password: "a brand new one 4" });
    assert.equal((await viewer.go("/api/me")).status, 403);
    assert.equal(((await viewer.go("/auth/gw/state")).data.me as { role: string }).role, "viewer");

    // A role someone has is not deleted; the last owner is not demoted; changing a role's caps applies on the next start.
    assert.equal((await owner.go("/auth/gw/roles/viewer/delete", {})).status, 409);
    assert.equal((await owner.go(`/auth/gw/people/${tuan.id}/role`, { role: "member" })).status, 400, "not on your own account");
    assert.equal((await owner.go("/auth/gw/roles/contractor", { name: "Contractor", permissions: ["pi.use"], memoryMb: 3072, cpus: 1 })).status, 200);
    await worker.go("/api/sessions");
    assert.deepEqual(capsOf[store.boxOf(kim.id)!.key], { memoryMb: 3072, cpus: 1 });
    assert.deepEqual(policies[`Bearer ${store.boxOf(kim.id)!.token}`]!.permissions, ["pi.use"], "the changed role's policy was sent again");
    assert.equal((await worker.go(`/auth/gw/people/${han.id}/reset-password`, { password: "x".repeat(12) })).status, 403, "the role no longer manages people");

    // The audit log: who did what.
    const log = (await owner.go("/auth/gw/audit")).data.entries as { action: string; actor: string }[];

    for (const action of ["role created", "invite made", "joined", "reset-password", "role given", "role changed"]) {
        assert.ok(log.some((entry) => entry.action === action), action);
    }
});

test("a WebSocket opens only from the gateway's own page, signed in", async () => {
    const { request } = await import("node:http");
    const upgrade = (headers: Record<string, string>) =>
        new Promise<string>((resolve) => {
            const sent = request(`${origin}/api/terminal`, { headers: { connection: "upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers } });

            sent.on("upgrade", () => resolve("upgraded"));
            sent.on("response", (response) => resolve(String(response.statusCode)));
            sent.on("error", (error) => resolve(error.message));
            sent.on("socket", (socket) => socket.on("data", (data: Buffer) => resolve(data.toString().split("\r\n")[0]!)));
            sent.end();
        });

    assert.match(await upgrade({ origin }), /403/, "not signed in");
    assert.match(await upgrade({ origin: "http://evil.example" }), /403/);
});
