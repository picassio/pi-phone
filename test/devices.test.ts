// Signed-in devices (config.ts StoredDevice, auth.ts, app.ts devices): each sign-in is a device with a token of its own,
// a person's token is never handed out, one device signs out alone, the owner sees and signs out everyone's devices and
// others only their own, old-style cookies become devices, and the phone's app stays one device.
import { type App, cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Auth } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base: string;

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const FIREFOX = "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0";
const APP = "Mozilla/5.0 (Linux; Android 16; SM-F966; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36";

before(async () => {
    app = await openApp(scriptedModel(), join(root, "devices-data"));
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server.closeAllConnections();
    server.close();
    await app?.close();
    cleanUp();
});

const cookieOf = (response: Response) =>
    decodeURIComponent(/pocket_auth=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "");

/** Open a login link as a browser would: the device's cookie. */
async function logIn(token: string, agent: string): Promise<string> {
    const response = await fetch(`${base}/login?token=${encodeURIComponent(token)}`, {
        redirect: "manual",
        headers: { "user-agent": agent },
    });

    assert.equal(response.status, 303);

    return cookieOf(response);
}

const asCookie = (cookie: string, path: string, body?: unknown) =>
    fetch(`${base}/api/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { cookie: `pocket_auth=${cookie}`, "x-pocket": "1", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

type Listed = { id: string; name: string; user: { id: string }; current?: true; app?: true; address?: string };
const devices = async (cookie: string) => ((await (await asCookie(cookie, "devices")).json()) as { devices: Listed[] }).devices;

test("a login link makes a device of its own: named from its browser, its cookie never the person's token", async () => {
    const laptop = await logIn(app.config.ownerToken, CHROME);

    assert.notEqual(laptop, app.config.ownerToken);
    assert.equal((await asCookie(laptop, "me")).status, 200);

    const mine = (await devices(laptop)).find((each) => each.current);

    assert.equal(mine?.name, "Chrome on Windows");
    assert.equal(mine?.address, "127.0.0.1");
    assert.equal(mine?.user.id, owner(app).id);
});

test("one device signs out alone; its cookie is refused, another of the same person's still works", async () => {
    const first = await logIn(app.config.ownerToken, CHROME);
    const second = await logIn(app.config.ownerToken, FIREFOX);
    const id = app.config.deviceByToken(first)!.id;

    assert.equal((await asCookie(second, `devices/${id}/sign-out`, {})).status, 200);
    assert.equal((await asCookie(first, "me")).status, 401);
    assert.equal((await asCookie(second, "me")).status, 200);
    assert.equal((await asCookie(second, `devices/${id}/sign-out`, {})).status, 404, "gone");
});

test("invited people see and sign out only their own devices; the owner sees and signs out theirs", async () => {
    const guest = app.config.addUser("Gail", "guest");

    try {
        const gail = await logIn(guest.token, FIREFOX);
        const gailPhone = await logIn(guest.token, CHROME);
        const ownerDevice = await logIn(app.config.ownerToken, CHROME);
        const seen = await devices(gail);

        assert.ok(seen.length === 2 && seen.every((each) => each.user.id === guest.user.id), "only her own");
        assert.equal((await asCookie(gail, `devices/${app.config.deviceByToken(ownerDevice)!.id}/sign-out`, {})).status, 403);
        assert.ok((await devices(ownerDevice)).some((each) => each.user.id === guest.user.id), "the owner sees hers");
        assert.equal((await asCookie(ownerDevice, `devices/${app.config.deviceByToken(gailPhone)!.id}/sign-out`, {})).status, 200);
        assert.equal((await asCookie(gailPhone, "me")).status, 401);
        assert.equal((await asCookie(gail, "me")).status, 200);

        // Removing her removes her devices.
        app.removeUser(owner(app), guest.user.id);
        assert.equal(app.config.devices(guest.user.id).length, 0);
        assert.equal((await asCookie(gail, "me")).status, 401);
    } finally {
        app.config.removeUser(guest.user.id);
    }
});

test("a browser signed in before devices (its cookie the person's token) works, and becomes a device on its next load", async () => {
    const before = app.config.devices().length;
    const response = await fetch(`${base}/api/me`, {
        headers: { cookie: `pocket_auth=${app.config.ownerToken}`, "user-agent": CHROME },
    });
    const upgraded = cookieOf(response);

    assert.equal(response.status, 200);
    assert.ok(upgraded !== "" && upgraded !== app.config.ownerToken, "a device's cookie instead");
    assert.equal(app.config.devices().length, before + 1);
    assert.equal((await asCookie(upgraded, "me")).status, 200);

    // A Bearer header with the person's token (the phone's service, the renderer) is not a browser: no device.
    const service = await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${app.config.ownerToken}` } });

    assert.equal(service.status, 200);
    assert.equal(cookieOf(service), "");
});

test("the phone's app stays one device, however often it signs in", async () => {
    await logIn(app.config.ownerToken, APP);
    await logIn(app.config.ownerToken, APP);
    const apps = app.config.devices(owner(app).id).filter((each) => each.app === true);

    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.name, "pi-phone app");
});

test("an owner invite signs a device in as the owner with a token of its own", async () => {
    const auth = new Auth(app.config);
    const { code } = auth.createInvite(owner(app), { role: "owner" });
    const response = await fetch(`${base}/join/${code}`, {
        method: "POST",
        redirect: "manual",
        body: "",
        headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "user-agent": FIREFOX },
    });
    const cookie = cookieOf(response);

    assert.equal(response.status, 303);
    assert.notEqual(cookie, app.config.ownerToken);
    assert.equal(app.config.deviceByToken(cookie)?.userId, owner(app).id);
});

test("Sign out every device: every other one of yours goes, this one stays, your token is new; others are untouched", async () => {
    const guest = app.config.addUser("Gus", "guest");

    try {
        const keep = await logIn(app.config.ownerToken, CHROME);
        const other = await logIn(app.config.ownerToken, FIREFOX);
        const gus = await logIn(guest.token, FIREFOX);
        const old = app.config.ownerToken;

        assert.equal((await asCookie(keep, "sign-out-everywhere", {})).status, 200);
        assert.equal((await asCookie(keep, "me")).status, 200, "the one asking stays");
        assert.equal((await asCookie(other, "me")).status, 401);
        assert.notEqual(app.config.ownerToken, old);
        assert.equal((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${old}` } })).status, 401);
        assert.equal((await asCookie(gus, "me")).status, 200, "invited people stay");
        assert.deepEqual(
            app.config.devices(owner(app).id).map((each) => each.id),
            [app.config.deviceByToken(keep)!.id],
        );

        // A guest signs out their own other devices.
        const gusAgain = await logIn(guest.token, CHROME);

        assert.equal((await asCookie(gusAgain, "sign-out-everywhere", {})).status, 200);
        assert.equal((await asCookie(gus, "me")).status, 401);
        assert.equal((await asCookie(gusAgain, "me")).status, 200);
        assert.equal((await asCookie(keep, "me")).status, 200, "the owner's untouched");
    } finally {
        app.config.removeUser(guest.user.id);
    }
});
