// Terminals: a shell through pi-env's local daemon, over the app's WebSocket; owner only, from the app's own page. The
// shell outlives its socket: another takes it up by id, with what it wrote meanwhile.
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

type Message = { type: string; id?: string; code?: number; message?: string };

/** A socket to a new shell, or to shell `id`; what it is told, and all it was sent as output. */
function connect(token: string, { origin = `http://127.0.0.1:${port}`, id }: { origin?: string; id?: string } = {}) {
    const query = new URLSearchParams(id ? { id } : { place: work, cols: "80", rows: "24" });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/terminal?${query}`, {
        headers: { authorization: `Bearer ${token}`, origin },
    });
    const told: Message[] = [];
    const waiting: { type: string; resolve: (message: Message) => void }[] = [];
    const seen = { output: "" };

    ws.on("message", (data, binary) => {
        if (binary) {
            seen.output += Buffer.from(data as Buffer).toString();

            return;
        }

        const message = JSON.parse(String(data)) as Message;

        told.push(message);

        for (const each of waiting.splice(0)) {
            if (each.type === message.type) {
                each.resolve(message);
            } else {
                waiting.push(each);
            }
        }
    });

    const next = (type: string) =>
        new Promise<Message>((resolve) => {
            const already = told.find((each) => each.type === type);

            if (already) {
                resolve(already);
            } else {
                waiting.push({ type, resolve });
            }
        });
    const until = async (pattern: RegExp) => {
        for (let tries = 0; tries < 200 && !pattern.test(seen.output); tries++) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        assert.match(seen.output, pattern);
    };
    const input = (data: string) => ws.send(JSON.stringify({ type: "input", data }));

    return { ws, next, until, input, seen };
}

test("a shell runs in the folder, takes input and size, and says how it exited", async () => {
    const shell = connect(app.config.ownerToken);
    const ready = await shell.next("ready");

    assert.ok(ready.id);
    shell.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    shell.input("echo hi-$((6*7)) $PWD; stty size; exit 3\n");

    assert.deepEqual(await shell.next("exit"), { type: "exit", code: 3 });
    assert.match(shell.seen.output, /hi-42 /);
    assert.ok(shell.seen.output.includes(work), shell.seen.output);
    assert.match(shell.seen.output, /30 100/);
});

test("a shell runs on without its page, and the page takes it up again with what it wrote", async () => {
    const first = connect(app.config.ownerToken);
    const { id } = await first.next("ready");

    first.input("export MARK=kept-$((40+2))\n");
    await first.until(/export MARK[^]*export MARK[^]*\$/);
    first.ws.close();
    await new Promise((resolve) => first.ws.once("close", resolve));

    const again = connect(app.config.ownerToken, { id });

    assert.equal((await again.next("ready")).id, id);
    again.input("echo $MARK\n");
    await again.until(/kept-42/);
    assert.match(again.seen.output, /export MARK/, "what it wrote before comes again");

    // End: the shell stops, and its id is gone.
    again.ws.send(JSON.stringify({ type: "close" }));
    await new Promise((resolve) => again.ws.once("close", resolve));
    const late = connect(app.config.ownerToken, { id });

    await late.next("gone");
});

test("only the owner, and only from the app's own page", async () => {
    const guest = app.config.addUser("Guest", "guest");
    const refused = (socket: WebSocket) =>
        new Promise<number>((resolve) => socket.once("unexpected-response", (_request, response) => resolve(response.statusCode!)));

    assert.equal(await refused(connect(guest.token).ws), 403);
    assert.equal(await refused(connect(app.config.ownerToken, { origin: "http://evil.example" }).ws), 403);
});
