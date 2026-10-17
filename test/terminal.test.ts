// Terminals: a shell through pi-env's local daemon, over the app's WebSocket; owner only, from the app's own page.
import { type App, cleanUp, openApp, scriptedModel, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { Auth } from "../src/server/auth.ts";
import { createHandler } from "../src/server/http.ts";
import { attachTerminals } from "../src/server/terminal.ts";

let app: App;
let server: Server;
let close: () => void;
let port: number;

before(async () => {
    // The daemon starts `SHELL`, as PiService sets it in the app: here, the bash on PATH.
    process.env.SHELL = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
    app = await openApp(scriptedModel());
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    close = attachTerminals(server, app, new Auth(app.config));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
});

after(async () => {
    close();
    server.closeAllConnections();
    server.close();
    await app?.close();
    cleanUp();
});

function connect(token: string, origin = `http://127.0.0.1:${port}`): WebSocket {
    const query = new URLSearchParams({ place: work, cols: "80", rows: "24" });

    return new WebSocket(`ws://127.0.0.1:${port}/api/terminal?${query}`, {
        headers: { authorization: `Bearer ${token}`, origin },
    });
}

test("a shell runs in the folder, takes input and size, and says how it exited", async () => {
    const ws = connect(app.config.ownerToken);
    let output = "";
    const exit = new Promise<{ type: string; code?: number; message?: string }>((resolve) => {
        ws.on("message", (data, binary) => {
            if (binary) {
                output += Buffer.from(data as Buffer).toString();
            } else {
                resolve(JSON.parse(String(data)));
            }
        });
    });

    await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
    });
    ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    ws.send(JSON.stringify({ type: "input", data: "echo hi-$((6*7)) $PWD; stty size; exit 3\n" }));

    const ended = await exit;

    assert.deepEqual(ended, { type: "exit", code: 3 });
    assert.match(output, /hi-42 /);
    assert.ok(output.includes(work), output);
    assert.match(output, /30 100/);
});

test("only the owner, and only from the app's own page", async () => {
    const guest = app.config.addUser("Guest", "guest");
    const refused = (socket: WebSocket) =>
        new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => resolve(response.statusCode!)));

    assert.equal(await refused(connect(guest.token)), 403);
    assert.equal(await refused(connect(app.config.ownerToken, "http://evil.example")), 403);
});
