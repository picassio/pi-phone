// Running MCP servers (PP-524): one instance per (server, place, folder), started on the first call through pi-env's
// daemon (openProcess + PipeTransport); the idle stop ends its process; a dead server starts again on the next call,
// and three deaths in five minutes mark it failed; a timeout says the tool may still run; secrets fill `${NAME}`;
// a changed entry stops its instances; the cap stops the oldest; list_changed is heard.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { McpServers } from "../src/server/mcp/config.ts";
import { McpManager } from "../src/server/mcp/manager.ts";
import { Secrets } from "../src/server/secrets.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-manager-")));
const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");
const connection = new Connection({ command: [localDaemon()] });

after(() => {
    connection.close();
    rmSync(root, { recursive: true, force: true });
});

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);

        return true;
    } catch {
        return false;
    }
};

const until = async (check: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;

    while (!check()) {
        if (Date.now() > end) {
            throw new Error("timed out");
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");
const pidOf = (text: string) => Number(/pid=(\d+)/.exec(text)![1]);

function setup(name: string, options: { maxInstances?: number; now?: () => number } = {}) {
    const data = join(root, name);

    mkdirSync(data, { recursive: true });
    const servers = new McpServers(data);
    const secrets = new Secrets(data);
    const notices: string[] = [];
    const manager = new McpManager({
        servers,
        secrets,
        where: (machineId) => {
            if (machineId !== undefined) {
                throw new Error(`no machine ${machineId} here`);
            }

            return { connection, home: root, path: process.env.PATH ?? "" };
        },
        notify: (message) => notices.push(message),
        log: () => {},
        ...options,
    });

    after(() => manager.close());

    return { servers, secrets, manager, notices, work: data };
}

const stub = (extra: Record<string, unknown> = {}) => ({ command: process.execPath, args: [STUB], ...extra });

test("a server starts on its first call, in the session's folder, and later calls share it", async () => {
    const { servers, manager, work } = setup("lazy");

    servers.save("stub", stub({ env: { GODOT_PATH: "~/godot" } }));
    assert.deepEqual(manager.status(), [], "nothing runs before a call");

    const first = textOf(await manager.call("stub", work, "echo", { message: "hi" }));
    const second = textOf(await manager.call("stub", work, "echo", { message: "again" }));

    assert.match(first, /^echo: hi pid=\d+ token=- godot=.*\/godot cwd=/);
    assert.ok(first.includes(`godot=${root}/godot`), "~ is the home where it runs");
    assert.ok(first.endsWith(`cwd=${work}`), first);
    assert.equal(pidOf(first), pidOf(second));
    assert.deepEqual(
        manager.status().map(({ server, state, calls, pid }) => ({ server, state, calls, pid })),
        [{ server: "stub", state: "ready", calls: 2, pid: pidOf(first) }],
    );
    assert.deepEqual((await manager.tools("stub", work)).slice(0, 2).map((tool) => tool.name), ["echo", "png"]);
});

test("the idle stop ends the server's process; the next call starts it again", async () => {
    const { servers, manager, work } = setup("idle");

    servers.save("stub", stub({ idleMinutes: 0.01 }));

    const pid = pidOf(textOf(await manager.call("stub", work, "echo", { message: "x" })));

    assert.ok(alive(pid));
    await until(() => manager.status()[0]!.state === "stopped");
    await until(() => !alive(pid));

    const again = pidOf(textOf(await manager.call("stub", work, "echo", { message: "y" })));

    assert.notEqual(again, pid);
    assert.equal(manager.status()[0]!.deaths, 0, "an idle stop is not a death");
});

test("a server that dies in a call: the call says the tool may have run, and the next call opens it again", async () => {
    const { servers, manager, work } = setup("dies");

    servers.save("stub", stub());

    const pid = pidOf(textOf(await manager.call("stub", work, "echo", { message: "x" })));

    await assert.rejects(manager.call("stub", work, "die", {}), /stopped while die ran: the tool may have run. The call is not sent again/);
    assert.equal(manager.status()[0]!.deaths, 1);

    const started = Date.now();
    const again = pidOf(textOf(await manager.call("stub", work, "echo", { message: "y" })));

    assert.notEqual(again, pid);
    assert.ok(Date.now() - started >= 900, "it waited its backoff (1 s) first");
});

test("three deaths in five minutes mark the server failed and tell the owner, until a reconnect", async () => {
    let offset = 0;
    const { servers, manager, notices, work } = setup("failed", { now: () => Date.now() + offset });

    servers.save("stub", stub({ env: { STUB_EXIT: "1" } }));

    for (let death = 1; death <= 3; death++) {
        await assert.rejects(manager.call("stub", work, "echo", { message: "x" }), /did not start/);
        // Past the backoff, within the five minutes.
        offset += 60_000;
    }

    assert.equal(manager.status()[0]!.state, "failed");
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /The MCP server stub failed: it died 3 times in 5 minutes.*reconnect it in Settings › MCP servers/);
    await assert.rejects(manager.call("stub", work, "echo", { message: "x" }), /failed: .*stays down until the owner reconnects it/);

    // The owner fixes the entry (a new approval) and reconnects: it runs.
    servers.save("stub", stub());
    await manager.reconnect("stub");
    assert.match(textOf(await manager.call("stub", work, "echo", { message: "back" })), /echo: back/);
});

test("a call that times out is cancelled, says the tool may still run, and the server stays up", async () => {
    const { servers, manager, work } = setup("timeout");

    servers.save("stub", stub({ timeout: 0.5 }));
    await assert.rejects(manager.call("stub", work, "slow", { ms: 3000 }), /did not answer in 0.5 s. The call was cancelled, but the tool may still run on the server/);
    assert.match(textOf(await manager.call("stub", work, "echo", { message: "still here" })), /still here/);
    assert.equal(manager.status()[0]!.deaths, 0);
});

test("secrets fill ${NAME} where the folder may use them; elsewhere the server does not start", async () => {
    const { servers, secrets, manager, work } = setup("secrets");
    const elsewhere = join(root, "elsewhere");

    secrets.set("STUB_TOKEN", { value: "stub-token-0123456789", folders: [work] });
    servers.save("stub", stub({ env: { STUB_TOKEN: "Bearer ${STUB_TOKEN}" } }));
    assert.match(textOf(await manager.call("stub", work, "echo", { message: "x" })), /token=Bearer stub-token-0123456789/);
    assert.ok(secrets.get("STUB_TOKEN")!.usedAt !== undefined);
    await assert.rejects(manager.call("stub", elsewhere, "echo", { message: "x" }), /needs the secret STUB_TOKEN, which is not set or may not be used in this folder/);

    secrets.set("STUB_TOKEN", { ask: true });
    await manager.stop("stub");
    await assert.rejects(manager.call("stub", work, "echo", { message: "x" }), /asks before each use/);
});

test("a changed entry stops its instances, an off server and other folders are refused, the cap stops the oldest", async () => {
    const { servers, manager, work } = setup("changes", { maxInstances: 1 });

    servers.save("stub", stub({ folders: [work] }));

    const pid = pidOf(textOf(await manager.call("stub", work, "echo", { message: "x" })));

    servers.save("stub", stub({ folders: [work], env: { GODOT_PATH: "/opt/godot" } }));
    await until(() => !alive(pid));
    assert.deepEqual(manager.status(), []);
    await assert.rejects(manager.call("stub", join(root, "other"), "echo", { message: "x" }), /does not serve this session's folder/);

    servers.setEnabled("stub", false);
    await assert.rejects(manager.call("stub", work, "echo", { message: "x" }), /is off/);
    servers.setEnabled("stub", true);

    servers.save("second", stub());

    const one = pidOf(textOf(await manager.call("stub", work, "echo", { message: "x" })));
    const two = pidOf(textOf(await manager.call("second", work, "echo", { message: "x" })));

    assert.notEqual(one, two);
    await until(() => !alive(one));
    assert.deepEqual(
        manager.status().map(({ server, state }) => [server, state]),
        [
            ["stub", "stopped"],
            ["second", "ready"],
        ],
    );
});

test("a server's tools are listed when it starts, and again on its list_changed", async () => {
    const { servers, manager, work } = setup("changed");
    const heard: [string, boolean][] = [];

    manager.onTools((server, tools) => heard.push([server, tools.some((tool) => tool.name === "extra")]));
    servers.save("stub", stub());
    assert.ok(!(await manager.tools("stub", work)).some((tool) => tool.name === "extra"));
    assert.deepEqual(heard, [["stub", false]], "listed once as it started, not again for tools()");
    await manager.call("stub", work, "grow", {});
    await until(() => heard.length === 2);
    assert.deepEqual(heard[1], ["stub", true]);
    assert.ok((await manager.tools("stub", work)).some((tool) => tool.name === "extra"));
});
