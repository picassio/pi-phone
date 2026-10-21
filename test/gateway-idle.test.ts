// Idle pi-phones stop (PP-33), with the gateway on an in-memory database, a stand-in controller, a stand-in pi-phone
// and a clock the test moves: a pi-phone used a moment ago, one at work, and one with a page open stay up; one idle for
// the server's minutes stops; the next visit starts it again; 0 minutes never stops; the setting is the server.manage
// role's; browsers can't ask a pi-phone what it is doing; an always-on pi-phone is kept running and started by itself;
// a new image renews running ones that are not at work; and a person's data and the whole server download as .tar.gz.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { gunzipSync } from "node:zlib";
import { tarStream } from "../src/gateway/tar.ts";
import { after, before, test } from "node:test";
import { makeAuth } from "../src/gateway/auth.ts";
import { type ControllerClient, Gateway } from "../src/gateway/server.ts";
import { GatewayStore } from "../src/gateway/store.ts";
import { served } from "./gateway-served.ts";

after(() => cleanUp());

let clock = Date.now();
let busy = false;
let running = false;
/** Whether the container is of the image people run now (PP-34). */
let current = true;
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
    ensure: async (id, _token, _caps, renew) => {
        calls.push(renew === true ? `renew ${id}` : `ensure ${id}`);
        key = id;
        running = true;
        current = current || renew === true;

        return { host: "127.0.0.1", port: upstreamPort };
    },
    list: async () => (key === "" ? [] : [{ id: key, host: "127.0.0.1", port: upstreamPort, running, current }]),
    stop: async (id) => {
        calls.push(`stop ${id}`);
        running = false;
    },
    remove: async () => undefined,
    // A person's data as the controller streams it: a tar of their /data.
    export: async (id) => {
        calls.push(`export ${id}`);

        return Readable.from([await personTar()]);
    },
};

/** The stand-in's tar of a person's /data. */
async function personTar(): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const text = Buffer.from("a session's data");

    for await (const chunk of tarStream([{ name: "data/pocket/session.txt", size: text.length, data: text }])) {
        chunks.push(chunk);
    }

    return Buffer.concat(chunks);
}

/** A tar's files, by name. */
function untar(archive: Buffer): Record<string, Buffer> {
    const files: Record<string, Buffer> = {};

    for (let at = 0; at + 512 <= archive.length && archive[at] !== 0; ) {
        const name = archive.subarray(at, at + 100).toString("ascii").replace(/\0.*$/s, "");
        const size = parseInt(archive.subarray(at + 124, at + 136).toString("ascii"), 8);

        files[name] = archive.subarray(at + 512, at + 512 + size);
        at += 512 + Math.ceil(size / 512) * 512;
    }

    return files;
}

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
    gateway = new Gateway({ auth: await makeAuth({ db, secret: store.authSecret(), origin }), store, controller, ...served(store), origin, log: () => undefined, now: () => clock });
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

test("a new image: running pi-phones are made again from it when not at work", async () => {
    assert.equal((await go("/auth/gw/server", { idleMinutes: 0 })).status, 200);
    assert.equal((await go("/api/sessions")).status, 200);
    current = false;
    calls.length = 0;

    // At work: waits.
    busy = true;
    await gateway.sweep();
    assert.deepEqual(calls, [], "busy: not now");
    assert.equal(((await (await go("/auth/gw/server")).json()) as { containers: { outdated: number } }).containers.outdated, 1);

    // Not at work: made again from the new image, and given its role's policy again.
    busy = false;
    await gateway.sweep();
    assert.deepEqual(calls, [`renew ${key}`]);
    assert.equal(current, true);

    // Once is enough.
    await gateway.sweep();
    assert.deepEqual(calls, [`renew ${key}`]);
    assert.equal((await go("/api/sessions")).status, 200);
});

test("a gateway made again (an update) reaches people's running pi-phones before asking them, so it can stop and renew them", async () => {
    const db = new DatabaseSync(":memory:");
    const fresh = new Gateway({ auth: await makeAuth({ db, secret: store.authSecret(), origin }), store, controller, ...served(store), origin, log: () => undefined, now: () => clock });

    running = true;
    current = false;
    busy = false;
    calls.length = 0;
    await fresh.sweep();
    assert.deepEqual(calls, [`ensure ${key}`, `renew ${key}`], "reached through the controller first, then made again");
});

test("a person's data, and the whole server, as .tar.gz downloads (PP-35)", async () => {
    const me = store.users()[0]!;
    const exported = await go(`/auth/gw/people/${me.id}/export`);

    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-disposition") ?? "", /^attachment; filename="pi-phone-owner-\d{4}-\d{2}-\d{2}\.tar\.gz"$/);
    assert.deepEqual(untar(gunzipSync(Buffer.from(await exported.arrayBuffer())))["data/pocket/session.txt"]?.toString(), "a session's data");
    assert.equal((await go("/auth/gw/people/nobody123456/export")).status, 404);

    const backup = await go("/auth/gw/backup");

    assert.equal(backup.status, 200);
    const files = untar(gunzipSync(Buffer.from(await backup.arrayBuffer())));

    assert.deepEqual(Object.keys(files), ["manifest.json", "gateway.sqlite", `people/${key}.tar`]);
    assert.equal(files["gateway.sqlite"]!.subarray(0, 15).toString(), "SQLite format 3", "a copy of the gateway's database");
    assert.deepEqual(JSON.parse(files["manifest.json"]!.toString()).people, [{ key, email: "owner@example.test", name: "Owner" }]);
    assert.equal(untar(files[`people/${key}.tar`]!)["data/pocket/session.txt"]?.toString(), "a session's data");
    assert.match(JSON.stringify(store.auditLog()), /"exported".*|"server backup"/);
});
