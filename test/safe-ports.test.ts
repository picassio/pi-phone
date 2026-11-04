// No test server on a port fetch refuses (PP-404, test/support/safe-ports.ts). The cause: fetch fails at once on the
// Fetch standard's blocked ports ("bad port"), and a server listening on port 0 can be given one where the system's
// ephemeral range starts low (the devbox's: 1024–65535; 36 of 60,000 listens there got one). The helper, which
// helpers.ts loads for every test, lets go of such a port quietly and takes another: the server's callback and
// `listening` come once, for the port it keeps, and no `close`; a port named outright listens as asked.
import { cleanUp } from "./helpers.ts";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, test } from "node:test";
import { BAD_PORTS, refusePortsForTest } from "./support/safe-ports.ts";

after(() => {
    refusePortsForTest(undefined);
    cleanUp();
});

const portOf = (server: Server) => (server.address() as { port: number }).port;
const closed = (server: Server) => new Promise((resolve) => server.close(resolve));

test("fetch refuses the Fetch standard's blocked ports before it connects: the flake's cause", async () => {
    for (const port of [6000, 6667, 2049, 10080]) {
        assert.ok(BAD_PORTS.has(port));
        await assert.rejects(fetch(`http://127.0.0.1:${port}/`), (error: Error & { cause?: Error }) => error.message === "fetch failed" && error.cause?.message === "bad port", String(port));
    }
});

test("a server asked for any port lets go of refused ones quietly and keeps a port fetch reaches, its callback and listening once", async () => {
    const offered: number[] = [];

    // The first three ports the system gives are refused, as a blocked port would be.
    refusePortsForTest((port) => {
        if (offered.length < 3) {
            offered.push(port);

            return true;
        }

        return false;
    });

    const server = createServer((_request, response) => response.end("ok"));
    const heard = { listening: 0, callback: 0, close: 0 };

    server.on("listening", () => heard.listening++);
    server.on("close", () => heard.close++);

    try {
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => {
            heard.callback++;
            resolve();
        }));
        await new Promise((resolve) => setTimeout(resolve, 50));

        assert.equal(offered.length, 3, "three ports were refused");
        assert.ok(!offered.includes(portOf(server)), `it keeps another port than ${offered.join(", ")}: ${portOf(server)}`);
        assert.deepEqual(heard, { listening: 1, callback: 1, close: 0 });
        assert.equal(await (await fetch(`http://127.0.0.1:${portOf(server)}/`)).text(), "ok");
    } finally {
        refusePortsForTest(undefined);
        await closed(server);
    }

    assert.equal(heard.close, 1, "its own close is heard");
});

test("the other ways to ask for any port are kept from refused ones too; a port named outright listens as asked", async () => {
    const offered: number[] = [];
    const refuseFirst = () =>
        refusePortsForTest((port) => {
            if (offered.length % 2 === 0) {
                offered.push(port);

                return true;
            }

            offered.push(-1);

            return false;
        });

    for (const ask of [(server: Server, done: () => void) => server.listen({ port: 0, host: "127.0.0.1" }, done), (server: Server, done: () => void) => server.listen(done)]) {
        refuseFirst();

        const server = createServer();

        await new Promise<void>((resolve) => ask(server, resolve));
        assert.ok(!offered.includes(portOf(server)), "a refused port is not kept");
        refusePortsForTest(undefined);
        await closed(server);
        offered.length = 0;
    }

    // A port named outright is the caller's to choose: listened on as asked, even one the test refuses.
    const first = createServer();

    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    const named = portOf(first);

    await closed(first);
    refusePortsForTest((port) => port === named);

    const again = createServer();

    try {
        await new Promise<void>((resolve) => again.listen(named, "127.0.0.1", resolve));
        assert.equal(portOf(again), named);
    } finally {
        refusePortsForTest(undefined);
        await closed(again);
    }
});
