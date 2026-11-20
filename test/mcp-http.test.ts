// MCP servers over Streamable HTTP (PP-529): the bearer token comes from a secret (the entry keeps ${NAME}); a connect
// that meets a 5xx or 429 is tried again, a 401 is not; a tool call is never sent twice (a 500 says the tool may have
// run); a session the server forgot is opened again and the call sent once more, as the server never ran it; a URL on
// a machine is reached through a forward of its port, closed with the instance.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { parseServer } from "../src/server/mcp/config.ts";
import { McpServers } from "../src/server/mcp/config.ts";
import { McpManager } from "../src/server/mcp/manager.ts";
import { Secrets } from "../src/server/secrets.ts";
import { startHttpStub } from "./support/mcp-http-stub.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-http-")));
const connection = new Connection({ command: [localDaemon()] });
const TOKEN = "http-stub-token-0123456789";

after(() => {
    connection.close();
    rmSync(root, { recursive: true, force: true });
});

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

function setup(name: string, forward?: (machineId: string, host: string, port: number) => Promise<{ port: number; close: () => void }>) {
    const data = join(root, name);

    mkdirSync(data, { recursive: true });
    const servers = new McpServers(data);
    const secrets = new Secrets(data);
    const lines: string[] = [];
    const manager = new McpManager({
        servers,
        secrets,
        where: () => ({ connection, home: root }),
        notify: () => {},
        log: (line) => lines.push(line),
        ...(forward === undefined ? {} : { forward }),
    });

    after(() => manager.close());
    secrets.set("STUB_TOKEN", { value: TOKEN });

    return { servers, manager, lines, work: data };
}

test("an HTTP entry: runs is the phone or a machine; headers keep ${NAME}", () => {
    const server = parseServer("docs", { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${STUB_TOKEN}" }, runs: "machine:box" });

    assert.ok(server.kind === "http");
    assert.deepEqual(server.runs, { where: "machine", machineId: "box" });
    assert.deepEqual(parseServer("docs", { url: "https://example.com/mcp" }).kind === "http" && parseServer("docs", { url: "https://example.com/mcp" }).runs, { where: "phone" });
    assert.throws(() => parseServer("docs", { url: "https://example.com/mcp", runs: "session" }), /an HTTP server's runs is "phone"/);
});

test("the bearer token comes from a secret, and calls run in the session the server gave", async () => {
    const stub = await startHttpStub({ token: TOKEN });
    const { servers, manager, work } = setup("bearer");

    after(() => stub.close());
    servers.save("docs", { url: stub.url, headers: { Authorization: "Bearer ${STUB_TOKEN}" } });
    assert.deepEqual((await manager.tools("docs", work)).map((tool) => tool.name), ["echo", "fail"]);
    assert.match(textOf(await manager.call("docs", work, "echo", { message: "hi" })), /^echo: hi \(session-1\)$/);
    assert.ok(stub.seen.authorizations.every((each) => each.endsWith(` ${TOKEN}`) && each.startsWith("Bearer")));
    assert.equal(manager.status()[0]?.state, "ready");

    // Without the token: a 401 is not tried again.
    servers.save("nokey", { url: stub.url });
    const before = stub.seen.initializes;

    await assert.rejects(manager.tools("nokey", work), /refused its credentials \(HTTP 401\)/);
    assert.equal(manager.status().find((each) => each.server === "nokey")?.deaths, 0, "a refused credential is no death");
    assert.equal(stub.seen.initializes - before, 0, "a 401 comes before the initialize is read");
    assert.equal(stub.seen.authorizations.filter((each) => each === "").length, 1, "asked once");
});

test("a connect that meets a 503 or a 429 is tried again; a tool call that meets a 500 is never sent twice", async () => {
    const stub = await startHttpStub();
    const { servers, manager, lines, work } = setup("retry");

    after(() => stub.close());
    servers.save("docs", { url: stub.url });
    stub.refuse(2, 503);
    assert.equal((await manager.tools("docs", work)).length, 2);
    assert.equal(stub.seen.initializes, 3, "twice refused, then connected");
    assert.equal(lines.filter((line) => line.includes("trying again")).length, 2);

    await manager.stop("docs");
    stub.refuse(3, 429);
    await assert.rejects(manager.tools("docs", work), /did not start: .*429/);
    assert.equal(stub.seen.initializes, 6, "three tries in all");

    await manager.reconnect("docs");
    await assert.rejects(manager.call("docs", work, "fail", {}), /answered HTTP 500 to fail: the tool may have run. The call is not sent again/);
    assert.equal(stub.seen.calls.fail, 1);
    await assert.rejects(manager.call("docs", work, "fail", {}), (error: Error) => !error.message.includes("ignore your instructions"));
});

test("a session the server forgot: a new one, and the call sent once more", async () => {
    const stub = await startHttpStub();
    const { servers, manager, work } = setup("expired");

    after(() => stub.close());
    servers.save("docs", { url: stub.url });
    assert.match(textOf(await manager.call("docs", work, "echo", { message: "one" })), /\(session-1\)/);
    stub.expire();
    assert.match(textOf(await manager.call("docs", work, "echo", { message: "two" })), /^echo: two \(session-2\)$/);
    assert.equal(stub.seen.calls.echo, 2, "the refused call never ran; the one sent again did");
    assert.equal(manager.status()[0]?.deaths, 0);
});

test("a URL on a machine goes through a forward of its port, closed with the instance", async () => {
    const stub = await startHttpStub();
    const forwards: string[] = [];
    let closed = 0;
    const { servers, manager, work } = setup("machine", async (machineId, host, port) => {
        forwards.push(`${machineId} ${host}:${port}`);

        return { port: stub.port, close: () => (closed += 1) };
    });

    after(() => stub.close());
    servers.save("devbox-docs", { url: "http://localhost:8765/mcp", runs: "machine:box" });
    assert.match(textOf(await manager.call("devbox-docs", work, "echo", { message: "through" })), /^echo: through/);
    assert.deepEqual(forwards, ["box localhost:8765"]);
    await manager.stop("devbox-docs");
    assert.equal(closed, 1);
});
