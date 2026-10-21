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
const exists = { network: false, volume: false, container: false, attached: false, running: false, image: "" };
/** The id of the image people run now (a rebuild changes it). */
let imageNow = "sha256:one";
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
                // As Docker does: a 500 for a container that is not on the network.
                if (!exists.attached) {
                    return reply(500, { message: "container is not connected to network pp-net-abc123" });
                }

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
                return exists.container ? reply(200, { State: { Running: exists.running }, Image: exists.image }) : reply(404, { message: "no such container" });
            }

            if (route === "GET /containers/json") {
                // Only person containers are asked for; one whose label is not a person's id is left out.
                assert.match(decodeURIComponent(path), /"label":\["io.piphone.role=person"\]/);

                return reply(200, [
                    { Labels: { "io.piphone.person": "abc123" }, State: exists.running ? "running" : "exited", ImageID: exists.image },
                    { Labels: { "io.piphone.person": "../etc" }, State: "running", ImageID: imageNow },
                ]);
            }

            if (route === "GET /images/pi-phone-server%3Alocal/json") {
                return reply(200, { Id: imageNow });
            }

            // The export helper (PP-35): made, its /data archived, removed.
            if (route === "POST /containers/create" && path.includes("name=pp-export-abc123-")) {
                return reply(201, { Id: "e1" });
            }

            if (/^GET \/containers\/pp-export-abc123-[0-9a-f]{8}\/archive$/.test(route)) {
                response.writeHead(200, { "content-type": "application/x-tar" });
                response.end("TAR-OF-DATA");

                return;
            }

            if (/^DELETE \/containers\/pp-export-abc123-[0-9a-f]{8}$/.test(route)) {
                return reply(204);
            }

            if (route === "POST /containers/create") {
                exists.container = true;
                exists.image = imageNow;
                exists.running = false;

                return reply(201, { Id: "c1" });
            }

            if (route === "POST /containers/pp-user-abc123/update") {
                return reply(200, {});
            }

            if (route === "POST /containers/pp-user-abc123/start") {
                exists.running = true;

                return reply(204);
            }

            if (route === "POST /containers/pp-user-abc123/stop") {
                exists.running = false;

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
    assert.deepEqual(create.body!.Env, [`PI_PHONE_OWNER_TOKEN=${token}`, "PI_PHONE_GATEWAY=1", "PI_PHONE_GATEWAY_URL=http://pi-phone-gateway:8081", "TZ=Asia/Saigon"]);
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
        ["GET /networks/pp-net-abc123", "GET /networks/pp-net-abc123", "GET /volumes/pp-data-abc123", "GET /containers/pp-user-abc123/json", "GET /images/pi-phone-server%3Alocal/json", "POST /containers/pp-user-abc123/update", "POST /containers/pp-user-abc123/start"],
    );
    assert.equal(calls[5]!.body!.Memory, 4096 * 1024 * 1024);

    // A new image (PP-34). Running, it is left as it is, unless renewed: then stopped, made again, started, data kept.
    const steps = () => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path.split("?")[0]}`);

    imageNow = "sha256:two";
    calls.length = 0;
    await controller.ensure("abc123", token, { memoryMb: 4096, cpus: 2 });
    assert.deepEqual(steps(), ["POST /containers/pp-user-abc123/update", "POST /containers/pp-user-abc123/start"], "running, not renewed: left");
    calls.length = 0;
    await controller.ensure("abc123", token, { memoryMb: 4096, cpus: 2 }, true);
    assert.deepEqual(steps(), ["POST /containers/pp-user-abc123/stop", "DELETE /containers/pp-user-abc123", "POST /containers/create", "POST /containers/pp-user-abc123/start"]);
    assert.equal(exists.image, "sha256:two");
    assert.equal(exists.volume, true, "their data stays");

    // Stopped on an older image: made again as it starts.
    imageNow = "sha256:three";
    await controller.stop("abc123");
    calls.length = 0;
    await controller.ensure("abc123", token, { memoryMb: 4096, cpus: 2 });
    assert.deepEqual(steps(), ["DELETE /containers/pp-user-abc123", "POST /containers/create", "POST /containers/pp-user-abc123/start"]);
    assert.equal(exists.image, "sha256:three");
    assert.deepEqual(await controller.list(), [{ id: "abc123", host: "pp-user-abc123", port: 8787, running: true, current: true }]);
    imageNow = "sha256:four";
    assert.equal((await controller.list())[0]!.current, false, "a rebuild: on an older image");

    // Their data, from a helper that is never started: the volume read-only, no network; removed once read.
    calls.length = 0;
    const archive = await controller.export("abc123");
    let read = "";

    for await (const chunk of archive) {
        read += String(chunk);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(read, "TAR-OF-DATA");
    const helper = calls.find((call) => call.path.includes("name=pp-export-"))!;
    const helperHost = helper.body!.HostConfig as Record<string, unknown>;

    assert.deepEqual(helperHost.Mounts, [{ Type: "volume", Source: "pp-data-abc123", Target: "/data", ReadOnly: true }]);
    assert.equal(helperHost.NetworkMode, "none");
    assert.deepEqual((helper.body!.Labels as Record<string, string>)["io.piphone.role"], "export", "not a person container: the list leaves it out");
    assert.ok(!calls.some((call) => call.path.includes("/start")), "never started");
    assert.match(calls.map((call) => `${call.method} ${call.path.split("?")[0]}`).join(" "), /GET \/containers\/pp-export-abc123-\w+\/archive DELETE \/containers\/pp-export-abc123-\w+/);

    // No volume yet: nothing to export.
    exists.volume = false;
    await assert.rejects(controller.export("abc123"), /no data yet/);
    exists.volume = true;

    // Removed: the gateway leaves the network first (Docker keeps one in use); the volume stays unless purged.
    await controller.remove("abc123", false);
    assert.equal(exists.container, false);
    assert.equal(exists.network, false);
    assert.equal(exists.volume, true, "their data stays");
    await controller.remove("abc123", true);
    assert.equal(exists.volume, false);

    // A gateway made again is on none of the networks until its next ensure: removing still works.
    await controller.ensure("abc123", token, { memoryMb: 1024, cpus: 1 });
    exists.attached = false;
    await controller.remove("abc123", false);
    assert.equal(exists.network, false);
    assert.equal(exists.container, false);
});
