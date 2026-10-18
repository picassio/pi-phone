import assert from "node:assert/strict";
import { createServer } from "node:net";
import { test } from "node:test";
import { NOT_CONNECTED, Tailnet, tailscaleAddress } from "../src/server/tailnet.ts";

const freePort = () =>
    new Promise<number>((resolve) => {
        const probe = createServer().listen(0, "127.0.0.1", () => {
            const { port } = probe.address() as { port: number };

            probe.close(() => resolve(port));
        });
    });

test("the Tailscale listener follows the address: off, waiting for Tailscale, listening, and gone again", async () => {
    const port = await freePort();
    let address: string | undefined;
    const changes: (string | undefined)[] = [];
    let attached = 0;
    let detached = 0;
    const tailnet = new Tailnet({
        port,
        handler: (_request, response) => response.end("served over the tailnet"),
        attach: () => {
            attached++;

            return () => detached++;
        },
        changed: (url) => changes.push(url),
        address: () => address,
        everyMs: 60_000,
    });

    assert.deepEqual(tailnet.status(), { enabled: false });
    assert.deepEqual(await tailnet.set(true), { enabled: true, problem: NOT_CONNECTED }, "on, but Tailscale is not connected");
    assert.deepEqual(changes, []);

    address = "127.0.0.1";
    await tailnet.follow();
    const url = `http://127.0.0.1:${port}`;

    assert.deepEqual(tailnet.status(), { enabled: true, url });
    assert.equal(await (await fetch(url)).text(), "served over the tailnet");
    assert.deepEqual(changes, [url]);
    assert.equal(attached, 1, "terminals are attached to it");

    await tailnet.follow();
    assert.deepEqual(changes, [url], "the same address changes nothing");

    address = undefined;
    await tailnet.follow();
    assert.deepEqual(tailnet.status(), { enabled: true, problem: NOT_CONNECTED });
    assert.deepEqual(changes, [url, undefined]);
    assert.equal(detached, 1);
    await assert.rejects(fetch(url), "nothing listens once Tailscale is gone");

    address = "127.0.0.1";
    await tailnet.follow();
    assert.equal(await (await fetch(url)).text(), "served over the tailnet");
    assert.deepEqual(await tailnet.set(false), { enabled: false }, "off stops it");
    assert.deepEqual(changes, [url, undefined, url, undefined]);
    await assert.rejects(fetch(url));
});

test("the Tailscale address is one in 100.64.0.0/10, or none", () => {
    const found = tailscaleAddress();

    assert.ok(found === undefined || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(found), String(found));
});
