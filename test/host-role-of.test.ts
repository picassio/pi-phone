// host.roleOf (PP-343, from pi-pocket 0.27's d2454d6): a drop-in asks a person's role by id, as the app decides it, and
// gets nothing for an id that is no person here.
import { type App, cleanUp, openApp, owner, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";

before(async () => {
    const dropIns = join(root, "data", "extensions");

    mkdirSync(dropIns, { recursive: true });
    writeFileSync(
        join(dropIns, "roles.ts"),
        `/** Roles: tells a person's role, for tests. */
export const pocketApi = 2;

export default (host, web) => {
    web.route("POST", "role", (request) => ({ role: host.roleOf(String(request.body.id)) ?? null }));
};
`,
    );
    app = await openApp(scriptedModel());
    await app.setExtensionEnabled(owner(app), "roles.ts", true);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

const roleOf = async (id: string) => {
    const response = await fetch(`${base}/api/x/roles/role`, {
        method: "POST",
        headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1", "content-type": "application/json" },
        body: JSON.stringify({ id }),
    });

    assert.equal(response.status, 200, await response.clone().text());

    return ((await response.json()) as { role: string | null }).role;
};

test("host.roleOf gives a person's role by id, and nothing for an id that is no person", async () => {
    const guest = app.config.addUser("Rae", "guest").user;
    const viewer = app.config.addUser("Vic", "viewer").user;

    assert.equal(await roleOf(owner(app).id), "owner");
    assert.equal(await roleOf(guest.id), "guest");
    assert.equal(await roleOf(viewer.id), "viewer");
    assert.equal(await roleOf("nobody-here"), null);
});
