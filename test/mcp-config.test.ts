// The owner's MCP servers' file (PP-523): entries in the shared `mcpServers` shape with pi-phone's fields, checked as a
// trust boundary; each approved by its fingerprint; `${NAME}` naming secrets; `!command`, legacy SSE, unknown fields and
// names whose tools would collide refused; and the file out of Pi's tools.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fillPlaceholders, fingerprint, hiddenTool, McpServers, parseServer, secretNames, serves } from "../src/server/mcp/config.ts";
import { keyStoreRefusal } from "../src/server/extensions/secrets.ts";

const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));

after(() => rmSync(dir, { recursive: true, force: true }));

const GOPEAK = {
    command: "npx",
    args: ["-y", "gopeak@2.3.8"],
    env: { GODOT_PATH: "~/.local/bin/godot", GOPEAK_TOOL_PROFILE: "compact", API: "Bearer ${GOPEAK_TOKEN}" },
    description: "Godot 4 editor",
    runs: "session",
    folders: ["machine:devbox:/home/ubuntu/ink-studio/"],
    idleMinutes: 45,
    hiddenTools: ["export-*"],
};

test("a valid stdio entry reads with pi-phone's fields and their defaults", () => {
    const server = parseServer("gopeak", GOPEAK);

    assert.equal(server.kind, "stdio");
    assert.ok(server.kind === "stdio");
    assert.deepEqual(server.args, ["-y", "gopeak@2.3.8"]);
    assert.deepEqual(server.runs, { where: "session" });
    assert.deepEqual(server.folders, ["machine:devbox:/home/ubuntu/ink-studio"]);
    assert.equal(server.timeout, 60);
    assert.equal(server.startTimeout, 60);
    assert.equal(server.idleMinutes, 45);
    assert.equal(server.askEachCall, false);
    assert.equal(server.planMode, false);
    assert.equal(server.enabled, true);
    assert.deepEqual(secretNames(server), ["GOPEAK_TOKEN"]);
    assert.equal(fillPlaceholders(server.env.API!, { GOPEAK_TOKEN: "t0ken-value" }), "Bearer t0ken-value");
    assert.throws(() => fillPlaceholders(server.env.API!, {}), /GOPEAK_TOKEN is not given/);
    assert.ok(serves(server, "machine:devbox:/home/ubuntu/ink-studio"));
    assert.ok(serves(server, "machine:devbox:/home/ubuntu/ink-studio/scenes"));
    assert.ok(!serves(server, "machine:devbox:/home/ubuntu/ink-studio-2"));
    assert.ok(!serves(server, "/home/ubuntu/ink-studio"));
    assert.ok(hiddenTool(server, "export-project"));
    assert.ok(!hiddenTool(server, "project-export"));

    const pinned = parseServer("pinned", { command: "node", args: ["server.js"], runs: "machine:abc-123" });

    assert.ok(pinned.kind === "stdio");
    assert.deepEqual(pinned.runs, { where: "machine", machineId: "abc-123" });

    const http = parseServer("docs", { url: "https://example.com/mcp", headers: { Authorization: "Bearer ${DOCS_TOKEN}" } });

    assert.equal(http.kind, "http");
    assert.deepEqual(secretNames(http), ["DOCS_TOKEN"]);
});

test("invalid entries are refused with what is wrong", () => {
    const refused: [string, unknown, RegExp][] = [
        ["a", { command: "x", env: { TOKEN: "!op read op://vault/token" } }, /"!" \(a command whose output is the value\) is not supported/],
        ["a", { url: "https://example.com/mcp", headers: { Authorization: "!gh auth token" } }, /is not supported/],
        ["a", { type: "sse", url: "https://example.com/sse" }, /legacy SSE transport is not supported/],
        ["a", { command: "x", foo: 1 }, /foo is not a field of a stdio server/],
        ["a", { url: "https://example.com/mcp", runs: "phone" }, /runs is not a field of a http server/],
        ["a", { command: "x", args: [1] }, /args must be an array of strings/],
        ["a b", { command: "x" }, /invalid server name/],
        ["a", { command: "x", env: { A: "${lower}" } }, /\$\{lower\} is not a secret's name/],
        ["a", { command: "x", runs: "devbox" }, /runs is "session", "phone" or "machine:<machine id>"/],
        ["a", { command: "x", folders: ["work"] }, /not an absolute path/],
        ["a", { command: "x", cwd: "relative/dir" }, /cwd is an absolute path/],
        ["a", { command: "x", timeout: 601 }, /timeout/],
        ["a", { command: "x", idleMinutes: 0 }, /idleMinutes/],
        ["a", { command: "x", askEachCall: "yes" }, /askEachCall is true or false/],
        ["a", { url: "https://example.com/mcp", headers: { Authorization: "Bearer x" }, oauth: {} }, /either oauth or an Authorization header/],
    ];

    for (const [name, raw, why] of refused) {
        assert.throws(() => parseServer(name, raw), why, JSON.stringify(raw));
    }
});

test("the fingerprint changes with the entry (args, env, folders), not with on and off", () => {
    const base = parseServer("gopeak", GOPEAK);
    const print = fingerprint(base);

    assert.match(print, /^[0-9a-f]{64}$/);
    assert.equal(fingerprint(parseServer("gopeak", { ...GOPEAK })), print);
    // The same entry with its keys in another order is the same entry.
    assert.equal(fingerprint(parseServer("gopeak", Object.fromEntries(Object.entries(GOPEAK).reverse()))), print);
    assert.notEqual(fingerprint(parseServer("gopeak", { ...GOPEAK, args: ["-y", "gopeak@latest"] })), print);
    assert.notEqual(fingerprint(parseServer("gopeak", { ...GOPEAK, env: { ...GOPEAK.env, EXTRA: "1" } })), print);
    assert.notEqual(fingerprint(parseServer("gopeak", { ...GOPEAK, folders: [] })), print);
    assert.notEqual(fingerprint(parseServer("gopeak2", GOPEAK)), print);
    assert.equal(fingerprint(parseServer("gopeak", { ...GOPEAK, enabled: false })), print);
});

test("the file: saved approved and private, an entry changed outside the app does not run, collisions and broken files", () => {
    const data = join(dir, "data");
    const servers = new McpServers(data);
    let changes = 0;

    servers.onChange(() => changes++);
    servers.save("gopeak", GOPEAK);
    servers.save("docs", { url: "https://example.com/mcp" });

    assert.equal(changes, 2);
    assert.deepEqual(servers.list().map((server) => [server.name, server.approved]), [["docs", true], ["gopeak", true]]);
    assert.ok(servers.runnable("gopeak"));
    assert.equal(statSync(servers.file).mode & 0o777, 0o600);
    assert.deepEqual(servers.servingIn("machine:devbox:/home/ubuntu/ink-studio").map((server) => server.name), ["docs", "gopeak"]);
    assert.deepEqual(servers.servingIn("/data/work").map((server) => server.name), ["docs"]);

    // Off: kept, still approved, not runnable; on again without a new approval.
    servers.setEnabled("gopeak", false);
    assert.ok(!servers.runnable("gopeak"));
    assert.ok(servers.get("gopeak")!.approved);
    servers.setEnabled("gopeak", true);
    assert.ok(servers.runnable("gopeak"));

    // A name whose tools would be named as another's (- and _ are one in tool names) is refused.
    servers.save("go-peak-2", { command: "x" });
    assert.throws(() => servers.save("go_peak_2", { command: "y" }), /would be named as those of "go-peak-2"/);

    // Someone edits the file (args to @latest): the entry reads again, but is not the approved one, so it does not run.
    const file = JSON.parse(readFileSync(servers.file, "utf8")) as { mcpServers: Record<string, { args: string[] }> };

    file.mcpServers.gopeak!.args = ["-y", "gopeak@latest"];
    file.mcpServers.bad = { command: "x", env: { A: "!curl evil" } } as never;
    file.mcpServers.go_peak_2 = { command: "z" } as never;
    writeFileSync(servers.file, JSON.stringify(file));

    const again = new McpServers(data);

    assert.equal(again.get("gopeak")!.approved, false);
    assert.ok(!again.runnable("gopeak"));
    assert.deepEqual(again.servingIn("machine:devbox:/home/ubuntu/ink-studio").map((server) => server.name), ["docs", "go-peak-2"]);
    assert.deepEqual(
        again.problems().map((problem) => problem.name),
        ["bad", "go_peak_2"],
    );
    assert.ok(again.remove("docs"));
    assert.ok(!again.remove("docs"));

    // A file that is not JSON is moved aside, and the app starts with none.
    const broken = join(dir, "broken");

    mkdirSync(join(broken, "mcp"), { recursive: true });
    writeFileSync(join(broken, "mcp", "servers.json"), '{"mcpServers": {"x": {"headers": {"Authorization": "Bearer abc');
    const lines: string[] = [];
    const fresh = new McpServers(broken, (line) => lines.push(line), () => 42);

    assert.deepEqual(fresh.list(), []);
    assert.ok(existsSync(join(broken, "mcp", "servers.json.broken-42")));
    assert.ok(!readdirSync(join(broken, "mcp")).includes("servers.json"));
    assert.match(lines.join("\n"), /is not valid JSON/);
    assert.doesNotMatch(lines.join("\n"), /Bearer/);
});

test("Pi's tools stay out of the MCP servers' file", () => {
    const where = { dataDir: "/home/me/.pi-pocket", home: "/home/me", cwd: "/home/me/work" };

    assert.match(keyStoreRefusal("read", { path: "/home/me/.pi-pocket/mcp/servers.json" }, where) ?? "", /keeps its keys/);
    assert.match(keyStoreRefusal("write", { path: "~/.pi-pocket/mcp/servers.json", content: "{}" }, where) ?? "", /keeps its keys/);
    assert.match(keyStoreRefusal("bash", { command: "cat ~/.pi-pocket/mcp/servers.json" }, where) ?? "", /keeps its keys/);
    assert.equal(keyStoreRefusal("read", { path: "/home/me/work/.mcp.json" }, where), undefined);
});
