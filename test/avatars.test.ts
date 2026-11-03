// Profile pictures (PP-353, from pi-pocket #205): set, shown to others by version, refused when not a picture, removed;
// only for people who may see their owner; Pi sets one with the setting people.photo.
import { cleanUp, home, newSession, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";
import { appSettings } from "../src/server/settings-registry.ts";

let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let base = "";
let ownerToken = "";
let guest = { id: "", token: "" };

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

before(async () => {
    app = await openApp(scriptedModel(), join(root, "avatar-data"));
    const handler = createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} });

    server = createServer((request, response) => {
        void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    ownerToken = app.config.ownerToken;
    const added = app.config.addUser("Gale", "guest");

    guest = { id: added.user.id, token: added.token };
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const call = (token: string, path: string, method: string, body?: Buffer) =>
    fetch(`${base}${path}`, {
        method,
        ...(body === undefined ? {} : { body: new Uint8Array(body) }),
        headers: { authorization: `Bearer ${token}`, "x-pocket": "1" },
    });
const people = async () => (await (await call(ownerToken, "/api/me", "GET")).json()).users as { id: string; avatar?: number }[];

test("a picture is set, seen by others, and removed", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const version = (await people()).find((each) => each.id === guest.id)?.avatar;

    assert.equal(typeof version, "number");
    const seen = await call(ownerToken, `/api/avatar/${guest.id}?v=${version}`, "GET");

    assert.equal(seen.status, 200);
    assert.equal(seen.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await seen.arrayBuffer()), PNG);

    assert.equal((await call(guest.token, "/api/me/avatar", "DELETE")).status, 200);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
    assert.equal((await call(ownerToken, `/api/avatar/${guest.id}`, "GET")).status, 404);
});

test("only pictures of an allowed type and size are kept", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", Buffer.from("<svg onload=x>"))).status, 415);
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", Buffer.alloc(0))).status, 400);
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))).status, 413);
    assert.equal((await people()).find((each) => each.id === guest.id)?.avatar, undefined);
});

test("a picture is for people who share a session with its owner, and for people signed in", async () => {
    assert.equal((await call(guest.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const mine = await newSession(app);
    const other = await newSession(app);
    const sam = app.config.addUser("Sam", "guest", [String(mine)]);
    const eve = app.config.addUser("Eve", "guest", [String(other)]);

    app.config.updateUser(guest.id, { sessions: [String(other)] });

    assert.equal((await call(eve.token, `/api/avatar/${guest.id}`, "GET")).status, 200);
    // Sam shares no session with the owner of the picture: it is as if the person did not exist.
    assert.equal((await call(sam.token, `/api/avatar/${guest.id}`, "GET")).status, 404);
    assert.equal((await fetch(`${base}/api/avatar/${guest.id}`)).status, 401);
    assert.equal((await fetch(`${base}/api/me/avatar`, { method: "POST", body: new Uint8Array(PNG) })).status, 401);
    app.config.updateUser(guest.id, { sessions: undefined });
    await call(guest.token, "/api/me/avatar", "DELETE");
});

test("removing a person removes their picture, from the app's data folder", async () => {
    const gone = app.config.addUser("Gone", "guest");

    assert.equal((await call(gone.token, "/api/me/avatar", "POST", PNG)).status, 200);
    const file = join(app.dataDir, "avatars", gone.user.id);

    assert.equal(existsSync(file), true);
    app.removeUser(owner(app), gone.user.id);
    assert.equal(existsSync(file), false);
});

test("Pi sets a person's picture from a file on the phone, and takes it away (people.photo)", async () => {
    const setting = appSettings(app).settings.find((each) => each.id === "people.photo")!;
    const folder = join(home, "pictures");
    const path = join(folder, "gale.png");

    mkdirSync(folder, { recursive: true });
    writeFileSync(path, PNG);
    assert.equal(setting.target, "person");
    assert.equal(await setting.read("Gale"), "none");

    await setting.apply(owner(app), path, "Gale");
    assert.match(await setting.read("Gale"), /^set \d{4}-/);
    assert.deepEqual(Buffer.from(await (await call(ownerToken, `/api/avatar/${guest.id}`, "GET")).arrayBuffer()), PNG);

    assert.throws(() => setting.apply(owner(app), join(folder, "missing.png"), "Gale"), { status: 400 });
    writeFileSync(join(folder, "notes.txt"), "not a picture");
    assert.throws(() => setting.apply(owner(app), join(folder, "notes.txt"), "Gale"), { status: 415 });

    await setting.apply(owner(app), "none", "Gale");
    assert.equal(await setting.read("Gale"), "none");
    assert.equal((await call(ownerToken, `/api/avatar/${guest.id}`, "GET")).status, 404);
});
