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
import { SocketController } from "./controller-client.ts";
import { Gateway } from "./server.ts";
import { GatewayStore } from "./store.ts";

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
const auth = await makeAuth({ db, secret: store.authSecret(), origin });

const boards = new BoardService(store, boardsDir);
const gateway = new Gateway({
    auth,
    store,
    boards,
    controller: new SocketController(env("PP_CONTROLLER_SOCKET"), readFileSync(env("PP_CONTROLLER_SECRET_FILE"), "utf8").trim()),
    origin,
    log: (line) => console.error(line),
});
const server = createServer((request, response) => void gateway.handle(request, response));
// The internal port: only people's pi-phones reach it, on their own networks (PP-39). Caddy sends nothing there.
const internal = createServer((request, response) => void gateway.internal(request, response));

internal.listen(Number(process.env.PP_GATEWAY_INTERNAL_PORT ?? 8081), "0.0.0.0");

// Idle pi-phones stop (PP-33).
gateway.sweeping();

server.on("upgrade", (request, socket, head) => void gateway.upgrade(request, socket, head));
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
