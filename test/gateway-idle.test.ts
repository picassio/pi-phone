// Idle pi-phones stop (PP-33), with the gateway on an in-memory database, a stand-in controller, a stand-in pi-phone
// and a clock the test moves: a pi-phone used a moment ago, one at work, and one with a page open stay up; one idle for
// the server's minutes stops; the next visit starts it again; 0 minutes never stops; the setting is the server.manage
// role's; browsers can't ask a pi-phone what it is doing; and an always-on pi-phone is kept running and started by itself.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";

after(() => cleanUp());

let clock = Date.now();
let busy = false;
let running = false;
let upstream: Server;
let upstreamPort = 0;
let server: Server;
let origin = "";
let store: GatewayStore;
let gateway: Gateway;
let key = "";
const calls: string[] = [];
const PASSWORD = "a long enough password";

const controller: ControllerClient = {
    ensure: async (id) => {
        calls.push(`ensure ${id}`);
        key = id;
        running = true;

        return { host: "127.0.0.1", port: upstreamPort };
    },
    list: async () => (key === "" ? [] : [{ id: key, host: "127.0.0.1", port: upstreamPort, running, current: true }]),
    stop: async (id) => {
        calls.push(`stop ${id}`);
        running = false;
    },
    remove: async () => undefined,
};

before(async () => {
    upstream = createServer((request, response) => {
        if (request.url === "/api/activity") {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify(busy ? { busy: true, why: "A session: writing an answer" } : { busy: false }));

            return;
        }

        // A page's event stream: open until the page goes.
        if (request.url === "/api/events") {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(": open\n\n");

            return;
        }

        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    upstreamPort = (upstream.address() as { port: number }).port;

    const db = new DatabaseSync(":memory:");

    store = new GatewayStore(db);
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    gateway = new Gateway({ auth: await makeAuth({ db, secret: store.authSecret(), origin }), store, controller, origin, log: () => undefined, now: () => clock });
    server.on("request", (request, response) => void gateway.handle(request, response));
});

after(() => {
    upstream?.closeAllConnections();
    upstream?.close();
    server?.closeAllConnections();
    server?.close();
});

let cookie = "";

const go = async (path: string, body?: unknown, signal?: AbortSignal) => {
    const response = await fetch(`${origin}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, accept: "application/json", cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal === undefined ? {} : { signal }),
    });
    const made = response.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ");

    cookie = made === "" ? cookie : made;

    return response;
};

const minutes = (count: number) => (clock += count * 60_000);

test("idle pi-phones stop, and start again on the next visit", async () => {
    assert.equal((await go("/auth/gw/setup", { setupToken: store.setupToken(), name: "Owner", email: "owner@example.test", password: PASSWORD })).status, 200);
    assert.equal((await go("/auth/api/sign-in/email", { email: "owner@example.test", password: PASSWORD })).status, 200);
    assert.equal((await go("/api/sessions")).status, 200);
    assert.deepEqual(calls, [`ensure ${key}`]);
    assert.equal(store.idleMinutes(), 30, "30 minutes until changed");

    // Used a moment ago: up.
    minutes(5);
    await gateway.sweep();
    assert.equal(running, true);

    // Idle long enough, but at work: up.
    minutes(30);
    busy = true;
    await gateway.sweep();
    assert.equal(running, true, "busy keeps it up");
    busy = false;

    // A page open (its event stream): up, however long.
    const page = new AbortController();
    const stream = await go("/api/events", undefined, page.signal);

    assert.equal(stream.status, 200);
    minutes(120);
    await gateway.sweep();
    assert.equal(running, true, "an open page keeps it up");
    page.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The page went a moment ago: up; 30 minutes later, idle and not at work: stopped.
    await gateway.sweep();
    assert.equal(running, true);
    minutes(31);
    await gateway.sweep();
    assert.equal(running, false, "idle: stopped");
    assert.equal(calls.at(-1), `stop ${key}`);

    // The next visit starts it again.
    assert.equal((await go("/api/sessions")).status, 200);
    assert.equal(running, true);
    assert.equal(calls.at(-1), `ensure ${key}`);

    // Browsers can't ask what it is doing.
    assert.equal((await go("/api/activity")).status, 403);

    // 0 minutes: never stops. The owner sets it on the Server page.
    const set = await go("/auth/gw/server", { idleMinutes: 0 });

    assert.equal(set.status, 200);
    assert.deepEqual(((await set.json()) as { idleMinutes: number; containers: unknown }).containers, { all: 1, running: 1, outdated: 0 });
    minutes(600);
    await gateway.sweep();
    assert.equal(running, true, "0: never");
    assert.equal((await go("/auth/gw/server", { idleMinutes: 2000 })).status, 400);
    assert.match(JSON.stringify(store.auditLog()), /server settings/);
});

test("always on: never stopped when idle, and started by itself", async () => {
    assert.equal((await go("/auth/gw/server", { idleMinutes: 30 })).status, 200);

    const me = store.users()[0]!;
    const set = await go(`/auth/gw/people/${me.id}/always-on`, { on: true });

    assert.equal(set.status, 200);
    assert.equal(((await (await go("/auth/gw/people")).json()) as { people: { alwaysOn: boolean }[] }).people[0]!.alwaysOn, true);

    // Idle for hours: kept.
    minutes(300);
    await gateway.sweep();
    assert.equal(running, true, "always on: not stopped");

    // Stopped some other way (the server restarted, say): the next sweep starts it, without a visit.
    running = false;
    calls.length = 0;
    minutes(2);
    await gateway.sweep();
    assert.equal(running, true, "always on: started again");
    assert.deepEqual(calls, [`ensure ${key}`]);

    // Off again: idle stops it as before.
    assert.equal((await go(`/auth/gw/people/${me.id}/always-on`, { on: false })).status, 200);
    minutes(31);
    await gateway.sweep();
    assert.equal(running, false, "not always on: stopped when idle");
    assert.match(JSON.stringify(store.auditLog()), /"always on"/);
});
