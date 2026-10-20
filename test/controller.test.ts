// The server edition's controller (src/controller/controller.ts) against a stand-in Docker API on a Unix socket: a
// person's pi-phone is made with its own network (the gateway attached), its own volume, and fixed options (no
// capabilities, no new privileges, not privileged, no host mounts beyond the volume, no published ports, the caps
// asked); a second ensure only updates caps and starts it; anything outside the shape is refused before Docker is
// asked; and removing it takes the gateway off the network first, keeping the volume unless purged.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Controller } from "../src/controller/controller.ts";

after(() => cleanUp());

type Call = { method: string; path: string; body: Record<string, unknown> | undefined };

const calls: Call[] = [];
const exists = { network: false, volume: false, container: false, attached: false };
const socket = join(root, "docker.sock");
let docker: Server;

before(async () => {
    docker = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const text = Buffer.concat(chunks).toString();
            const path = (request.url ?? "").replace(/^\/v1\.44/, "");
            const call: Call = { method: request.method ?? "GET", path, body: text === "" ? undefined : (JSON.parse(text) as Record<string, unknown>) };

            calls.push(call);

            const reply = (status: number, body?: unknown) => {
                response.writeHead(status, { "content-type": "application/json" });
                response.end(body === undefined ? "" : JSON.stringify(body));
            };
            const route = `${call.method} ${path.split("?")[0]}`;

            if (route === "GET /networks/pp-net-abc123") {
                return exists.network ? reply(200, { Containers: exists.attached ? { x: { Name: "pi-phone-gateway" } } : {} }) : reply(404, { message: "no such network" });
            }

            if (route === "POST /networks/create") {
                exists.network = true;

                return reply(201, { Id: "n1" });
            }

            if (route === "POST /networks/pp-net-abc123/connect") {
                exists.attached = true;

                return reply(200);
            }

            if (route === "POST /networks/pp-net-abc123/disconnect") {
                exists.attached = false;

                return reply(200);
            }

            if (route === "DELETE /networks/pp-net-abc123") {
                return exists.attached ? reply(403, { message: "network has active endpoints" }) : ((exists.network = false), reply(204));
            }

            if (route === "GET /volumes/pp-data-abc123") {
                return exists.volume ? reply(200, {}) : reply(404, { message: "no such volume" });
            }

            if (route === "POST /volumes/create") {
                exists.volume = true;

                return reply(201, {});
            }

            if (route === "DELETE /volumes/pp-data-abc123") {
                exists.volume = false;

                return reply(204);
            }

            if (route === "GET /containers/pp-user-abc123/json") {
                return exists.container ? reply(200, { State: { Running: true } }) : reply(404, { message: "no such container" });
            }

            if (route === "POST /containers/create") {
                exists.container = true;

                return reply(201, { Id: "c1" });
            }

            if (route === "POST /containers/pp-user-abc123/update") {
                return reply(200, {});
            }

            if (route === "POST /containers/pp-user-abc123/start") {
                return reply(204);
            }

            if (route === "POST /containers/pp-user-abc123/stop") {
                return reply(204);
            }

            if (route === "DELETE /containers/pp-user-abc123") {
                exists.container = false;

                return reply(204);
            }

            reply(500, { message: `unexpected ${route}` });
        });
    });
    await new Promise<void>((resolve) => docker.listen(socket, resolve));
});

after(() => docker?.close());

test("a person's pi-phone: its own network, volume, and a container with fixed options; refused outside the shape", async () => {
    const controller = new Controller({ docker: socket, image: "pi-phone-server:local", gateway: "pi-phone-gateway", timezone: "Asia/Saigon" });
    const token = "t".repeat(32);

    // Refused before Docker is asked.
    await assert.rejects(controller.ensure("Bad_ID", token, { memoryMb: 1024, cpus: 1 }), /6 to 40 lowercase/);
    await assert.rejects(controller.ensure("abc123", token, { memoryMb: 64, cpus: 1 }), /memoryMb/);
    await assert.rejects(controller.ensure("abc123", token, { memoryMb: 1024, cpus: 64 }), /cpus/);
    await assert.rejects(controller.ensure("abc123", "short", { memoryMb: 1024, cpus: 1 }), /owner token/);
    await assert.rejects(controller.ensure("../etc", token, { memoryMb: 1024, cpus: 1 }), /6 to 40 lowercase/);
    assert.equal(calls.length, 0);

    assert.deepEqual(await controller.ensure("abc123", token, { memoryMb: 2048, cpus: 1.5 }), { container: "pp-user-abc123", host: "pp-user-abc123", port: 8787, running: true });

    const create = calls.find((call) => call.method === "POST" && call.path.startsWith("/containers/create"))!;
    const host = create.body!.HostConfig as Record<string, unknown>;

    assert.equal(create.path, "/containers/create?name=pp-user-abc123");
    assert.equal(create.body!.Image, "pi-phone-server:local", "the one image");
    assert.deepEqual(create.body!.Env, [`PI_PHONE_OWNER_TOKEN=${token}`, "PI_PHONE_GATEWAY=1", "TZ=Asia/Saigon"]);
    assert.deepEqual(host.CapDrop, ["ALL"]);
    assert.deepEqual(host.SecurityOpt, ["no-new-privileges"]);
    assert.equal(host.Privileged, false);
    assert.deepEqual(host.PortBindings, {}, "nothing published");
    assert.equal(host.Binds, undefined, "no host folders");
    assert.deepEqual(host.Mounts, [{ Type: "volume", Source: "pp-data-abc123", Target: "/data" }]);
    assert.equal(host.NetworkMode, "pp-net-abc123");
    assert.equal(host.Memory, 2048 * 1024 * 1024);
    assert.equal(host.NanoCpus, 1.5e9);
    assert.ok(calls.some((call) => call.path === "/networks/pp-net-abc123/connect" && call.body?.Container === "pi-phone-gateway"), "the gateway joins the person's network");

    // Again: the caps updated, started, nothing made twice.
    calls.length = 0;
    await controller.ensure("abc123", token, { memoryMb: 4096, cpus: 2 });
    assert.deepEqual(
        calls.map((call) => `${call.method} ${call.path}`),
        ["GET /networks/pp-net-abc123", "GET /networks/pp-net-abc123", "GET /volumes/pp-data-abc123", "GET /containers/pp-user-abc123/json", "POST /containers/pp-user-abc123/update", "POST /containers/pp-user-abc123/start"],
    );
    assert.equal(calls[4]!.body!.Memory, 4096 * 1024 * 1024);

    // Removed: the gateway leaves the network first (Docker keeps one in use); the volume stays unless purged.
    await controller.remove("abc123", false);
    assert.equal(exists.container, false);
    assert.equal(exists.network, false);
    assert.equal(exists.volume, true, "their data stays");
    await controller.remove("abc123", true);
    assert.equal(exists.volume, false);
});
