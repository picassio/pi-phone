#!/usr/bin/env node
/**
 * The server edition's controller (PP-21, `controller.ts`): serves the gateway on a Unix socket in a folder only the
 * two share (deploy/compose.yaml), and asks a shared secret on every request too.
 *
 *   PP_DOCKER_SOCKET=/var/run/docker.sock PP_USER_IMAGE=pi-phone-server:local PP_GATEWAY_CONTAINER=pi-phone-gateway \
 *   PP_CONTROLLER_SOCKET=/run/pi-phone/controller.sock PP_CONTROLLER_SECRET_FILE=/run/pi-phone/secret node src/controller/main.ts
 *
 * Routes (JSON): GET /people, GET /people/<id>, POST /people/<id>/ensure { token, caps: { memoryMb, cpus }, renew? }, POST /people/<id>/stop,
 * POST /people/<id>/remove { purge }, GET /people/<id>/export (a tar of their /data, streamed).
 */
import { chmodSync, chownSync, existsSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { Controller, ControllerError } from "./controller.ts";

const env = (name: string): string => {
    const value = process.env[name];

    if (value === undefined || value === "") {
        throw new Error(`${name} is not set.`);
    }

    return value;
};

const socket = env("PP_CONTROLLER_SOCKET");
const secret = Buffer.from(readFileSync(env("PP_CONTROLLER_SECRET_FILE"), "utf8").trim());
const controller = new Controller({
    docker: process.env.PP_DOCKER_SOCKET ?? "/var/run/docker.sock",
    image: env("PP_USER_IMAGE"),
    gateway: env("PP_GATEWAY_CONTAINER"),
    timezone: process.env.TZ ?? "UTC",
});

const read = async (request: import("node:http").IncomingMessage): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of request) {
        size += (chunk as Buffer).length;

        if (size > 64 * 1024) {
            throw new ControllerError(413, "Too large.");
        }

        chunks.push(chunk as Buffer);
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const value = text === "" ? {} : (JSON.parse(text) as unknown);

    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new ControllerError(400, "Send a JSON object.");
    }

    return value as Record<string, unknown>;
};

const server = createServer((request, response) => {
    const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
    };

    void (async () => {
        try {
            const given = Buffer.from(String(request.headers["x-controller-secret"] ?? ""));

            if (given.length !== secret.length || !timingSafeEqual(given, secret)) {
                throw new ControllerError(401, "Not the gateway.");
            }

            const path = new URL(request.url ?? "/", "http://controller").pathname;

            if (path === "/people" && request.method === "GET") {
                return reply(200, { people: await controller.list() });
            }

            const match = /^\/people\/([^/]+)(?:\/(ensure|stop|remove|export))?$/.exec(path);

            if (match === null) {
                throw new ControllerError(404, "No such route.");
            }

            const [, id, action] = match as unknown as [string, string, string | undefined];

            if (action === "export" && request.method === "GET") {
                const archive = await controller.export(id);

                response.writeHead(200, { "content-type": "application/x-tar" });
                archive.pipe(response);
                response.once("close", () => archive.destroy());

                return;
            }

            if (action === undefined && request.method === "GET") {
                const person = await controller.status(id);

                return reply(person === undefined ? 404 : 200, person ?? { error: "No container yet." });
            }

            if (request.method !== "POST") {
                throw new ControllerError(405, "POST only.");
            }

            const body = await read(request);

            if (action === "ensure") {
                return reply(200, await controller.ensure(id, String(body.token ?? ""), Controller.caps(body.caps), body.renew === true));
            }

            if (action === "stop") {
                await controller.stop(id);

                return reply(200, { ok: true });
            }

            await controller.remove(id, body.purge === true);

            return reply(200, { ok: true });
        } catch (error) {
            const status = error instanceof ControllerError ? error.status : 500;

            reply(status, { error: error instanceof Error ? error.message : String(error) });
        }
    })();
});

if (existsSync(socket)) {
    rmSync(socket);
}

server.listen(socket, () => {
    // The gateway's group only (PP_GATEWAY_GID, the image's node user by default): the folder is shared, the socket is not anyone's.
    chownSync(socket, 0, Number(process.env.PP_GATEWAY_GID ?? 1000));
    chmodSync(socket, 0o660);
    console.log(`controller: serving the gateway on ${socket}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => server.close(() => process.exit(0)));
}
