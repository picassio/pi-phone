// A folder the server cannot read is a 403 with words, not a 500 (PP-381, from pi-pocket 0.28 cd013d5).
import { type App, cleanUp, openApp, root, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createHandler } from "../src/server/http.ts";

let app: App;
let server: Server;
let base = "";

before(async () => {
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test("listing a folder the server may not read answers 403, saying so", async () => {
    const locked = join(root, "locked-folder");

    mkdirSync(locked, { mode: 0o000 });

    try {
        const response = await fetch(`${base}/api/fs?path=${encodeURIComponent(locked)}`, { headers: { authorization: `Bearer ${app.config.ownerToken}`, "x-pocket": "1" } });
        const body = (await response.json()) as { error?: string };

        // Root reads every folder: there the listing works.
        if (process.getuid?.() === 0) {
            assert.equal(response.status, 200);
        } else {
            assert.equal(response.status, 403);
            assert.equal(body.error, `pi-phone cannot read ${locked}.`);
        }
    } finally {
        chmodSync(locked, 0o700);
    }
});
