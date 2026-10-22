#!/usr/bin/env node
/**
 * The server edition's gateway (PP-21, `server.ts`): signs people in and forwards each to their own pi-phone.
 *
 *   PP_ORIGIN=https://devbox.example.ts.net PP_GATEWAY_DATA=/data PP_CONTROLLER_SOCKET=/run/pi-phone/controller.sock \
 *   PP_CONTROLLER_SECRET_FILE=/run/pi-phone/secret node src/gateway/main.ts
 *
 * The first time, it prints the setup token: open `<origin>/auth/setup` and give it to make the owner's account.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeAuth } from "./auth.ts";
import { BoardService } from "./boards.ts";
import { DocService } from "./docs.ts";
import { SocketController } from "./controller-client.ts";
import { Gateway } from "./server.ts";
import { GatewayStore } from "./store.ts";
import { TeamAccounts } from "./team-accounts.ts";
import { trustedProxy } from "./proxy-guard.ts";

const env = (name: string): string => {
    const value = process.env[name];

    if (value === undefined || value === "") {
        throw new Error(`${name} is not set.`);
    }

    return value;
};

const origin = env("PP_ORIGIN").replace(/\/+$/, "");
const data = process.env.PP_GATEWAY_DATA ?? "/data";

mkdirSync(data, { recursive: true, mode: 0o700 });

const db = new DatabaseSync(join(data, "gateway.sqlite"));

db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

const store = new GatewayStore(db);
// The team's boards (PP-39): a database of their own, next to the gateway's.
const boardsDir = join(data, "boards");

mkdirSync(boardsDir, { recursive: true });
// A failed sign-in, or two-factor code, goes to the Audit log with the email tried and the address (PP-26).
const auth = await makeAuth({
    db,
    secret: store.authSecret(),
    origin,
    onSignInFailed: (failure) => store.audit("", "sign-in failed", failure.email, { how: failure.how, ...(failure.ip === undefined ? {} : { ip: failure.ip }) }),
});

const boards = new BoardService(store, boardsDir);
// The team's provider accounts (PP-69): their sign-ins in a model runtime of the gateway's own, next to its data.
const teamAccounts = new TeamAccounts(store, data);

await teamAccounts.open();
const docs = new DocService(store, boards, boardsDir, Date.now, (line) => console.error(line));
const gateway = new Gateway({
    auth,
    store,
    boards,
    docs,
    teamAccounts,
    controller: new SocketController(env("PP_CONTROLLER_SOCKET"), readFileSync(env("PP_CONTROLLER_SECRET_FILE"), "utf8").trim()),
    origin,
    log: (line) => console.error(line),
});
// The public port only from the HTTPS proxy (PP-26), when compose names it; tests and a bare gateway take anyone.
const proxy = process.env.PP_TRUSTED_PROXY;
const fromProxy = proxy === undefined || proxy === "" ? async () => true : trustedProxy(proxy);
const server = createServer(
    (request, response) =>
        void (async () => {
            if (!(await fromProxy(request.socket.remoteAddress))) {
                response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
                response.end("Only through the server's address.\n");

                return;
            }

            await gateway.handle(request, response);
        })(),
);
// The internal port: only people's pi-phones reach it, on their own networks (PP-39). Caddy sends nothing there.
const internal = createServer((request, response) => void gateway.internal(request, response));

internal.listen(Number(process.env.PP_GATEWAY_INTERNAL_PORT ?? 8081), "0.0.0.0");

// Idle pi-phones stop (PP-33).
gateway.sweeping();

server.on(
    "upgrade",
    (request, socket, head) =>
        void (async () => {
            if (!(await fromProxy(request.socket.remoteAddress))) {
                socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");

                return;
            }

            await gateway.upgrade(request, socket, head);
        })(),
);
server.requestTimeout = 15 * 60_000;
server.listen(Number(process.env.PP_GATEWAY_PORT ?? 8080), "0.0.0.0", () => {
    console.log(`pi-phone gateway for ${origin}`);

    if (store.userCount() === 0) {
        console.log(`  Set up the owner: open ${origin}/auth/setup with the setup token ${store.setupToken()}`);
    }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
