// Settings › MCP servers (PP-528): the owner's API (a guest gets 403) adds, changes, turns on and off, tests (its
// tools' count), reconnects, stops and removes a server, and imports a Claude/Cursor mcpServers block; every change
// reaches the owner's tabs (`mcp-servers`); Pi's settings and app actions do the same through the same methods.
import { cleanUp, fakeTab, openApp, owner, root, scriptedModel, until, work } from "./helpers.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { appSettings } from "../src/server/settings-registry.ts";
import { createHandler } from "../src/server/http.ts";
import { startOAuthStub, TAIL } from "./support/mcp-oauth-stub.ts";

const STUB = join(import.meta.dirname, "support", "mcp-stub.ts");

after(cleanUp);

test("the page's API, its events, and Pi's settings for MCP servers", async () => {
    const app = await openApp(scriptedModel(), join(root, "mcp-page-data"));
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Gil", "guest");
    const call = async (path: string, method = "GET", body?: unknown, token = app.config.ownerToken) => {
        const response = await fetch(`http://127.0.0.1:${port}/api/${path}`, {
            method,
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

        return { status: response.status, body: (await response.json()) as Record<string, unknown> & { servers?: { name: string; enabled: boolean; approved: boolean; tools?: number; instances: unknown[]; command: string }[] } };
    };
    const tab = fakeTab(undefined, owner(app));
    const guestTab = fakeTab(undefined, guest.user);

    await app.attach(tab.client);
    await app.attach(guestTab.client);

    try {
        assert.equal((await call("mcp", "GET", undefined, guest.token)).status, 403);
        assert.equal((await call("mcp/stub", "PUT", { entry: { command: process.execPath } }, guest.token)).status, 403);
        assert.deepEqual((await call("mcp")).body.servers, []);

        // Add: approved as the owner wrote it, and every owner tab hears it.
        const heard = () => tab.events.filter((each) => each.event === "mcp-servers").length;
        const before = heard();
        const added = await call("mcp/stub", "PUT", { entry: { command: process.execPath, args: [STUB], folders: [work], description: "A test server" } });

        assert.equal(added.status, 200, JSON.stringify(added.body));
        assert.deepEqual(
            added.body.servers?.map(({ name, enabled, approved }) => ({ name, enabled, approved })),
            [{ name: "stub", enabled: true, approved: true }],
        );
        await until(() => heard() > before, "the owner's tab hears the change");
        assert.equal(guestTab.events.filter((each) => each.event === "mcp-servers").length, 0, "a guest's tab does not");
        assert.equal((await call("mcp/bad", "PUT", { entry: { type: "sse", url: "https://example.com/sse" } })).status, 400);

        // Test connection: started for the folder, its tools counted.
        const tested = await call("mcp/stub/test", "POST", { folder: work });

        assert.equal(tested.body.ok, true, JSON.stringify(tested.body));
        assert.equal((tested.body.tools as string[]).length, 9);
        assert.equal((await call("mcp")).body.servers?.[0]?.tools, 9);
        assert.equal((await call("mcp/stub/test", "POST", {})).status, 400, "a folder is needed");

        // Off and on; stop and reconnect.
        assert.equal((await call("mcp/stub/enabled", "POST", { enabled: false })).body.servers?.[0]?.enabled, false);
        assert.equal((await call("mcp/stub/enabled", "POST", { enabled: true })).body.servers?.[0]?.enabled, true);
        assert.equal((await call("mcp/stub/stop", "POST", {})).status, 200);
        assert.equal((await call("mcp/stub/reconnect", "POST", {})).body.servers?.[0]?.instances.length, 0);

        // Import a Claude-style block: a new one saved, one that exists kept unless replaced, a bad one said.
        const block = JSON.stringify({ mcpServers: { stub: { command: "node" }, docs: { url: "https://example.com/mcp" }, broken: { command: "x", env: { A: "!op read x" } } } });
        const imported = await call("mcp/import", "POST", { text: block });

        assert.deepEqual(imported.body.saved, ["docs"]);
        assert.deepEqual(
            (imported.body.errors as { name: string; error: string }[]).map((each) => each.name),
            ["stub", "broken"],
        );
        assert.match(JSON.stringify(imported.body.errors), /stub is set up already: tick Replace/);
        assert.deepEqual((await call("mcp/import", "POST", { text: JSON.stringify({ stub: { command: process.execPath, args: [STUB] } }), replace: true })).body.saved, ["stub"]);
        assert.equal((await call("mcp/import", "POST", { text: "not json" })).status, 400);

        // Pi's settings and app actions: the same methods.
        const { settings, actions, targets } = appSettings(app);
        const enabled = settings.find((each) => each.id === "mcp.enabled")!;

        assert.deepEqual(await targets["mcp-server"](), ["docs", "stub"]);
        assert.equal(await enabled.read("docs"), "on");
        await enabled.apply(owner(app), "off", "docs");
        assert.equal(app.mcpServers.get("docs")?.enabled, false);
        assert.throws(() => enabled.read("nope"), /There is no MCP server nope/);

        const test = actions.find((each) => each.id === "mcp.test")!;

        assert.match(await test.run(owner(app), { name: "stub", folder: work }), /^stub: 9 tools in \d+\.\d s: echo, png/);
        assert.match(await actions.find((each) => each.id === "mcp.stop")!.run(owner(app), { name: "stub" }), /Stopped stub/);
        assert.match(await actions.find((each) => each.id === "mcp.reconnect")!.run(owner(app), { name: "stub" }), /Reconnected stub/);

        // Changed outside the app: the setting does not turn it on (its card shows the entry), the page does.
        app.mcpServers.setEnabled("docs", false);
        const file = join(app.dataDir, "mcp", "servers.json");
        const stored = JSON.parse(readFileSync(file, "utf8")) as { mcpServers: Record<string, Record<string, unknown>> };

        stored.mcpServers.docs!.url = "https://example.com/other";
        writeFileSync(file, JSON.stringify(stored));
        await app.close();
    } finally {
        server.closeAllConnections();
        server.close();
    }

    const again = await openApp(scriptedModel(), join(root, "mcp-page-data"));
    const stub = await startOAuthStub();
    const oauthServer = createServer(createHandler({ app: again, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => oauthServer.listen(0, "127.0.0.1", resolve));
    const oauthPort = (oauthServer.address() as { port: number }).port;
    const post = async (path: string, body: unknown, token = again.config.ownerToken) => {
        const response = await fetch(`http://127.0.0.1:${oauthPort}/api/${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });

        return { status: response.status, body: (await response.json()) as Record<string, unknown> & { servers?: { name: string; oauth?: { signedIn: boolean; waiting?: string } }[] } };
    };

    // OAuth (PP-530): the page starts a sign-in, the owner pastes where the browser ended, and signs out; a guest may not.
    try {
        again.mcpPage.save("issues", { url: stub.url, oauth: {} });
        assert.deepEqual(again.mcpPage.view().servers.find((each) => each.name === "issues")?.oauth, { signedIn: false });
        assert.equal((await post("mcp/issues/sign-in", {}, again.config.addUser("Gus", "guest").token)).status, 403);

        const started = await post("mcp/issues/sign-in", {});

        assert.equal(started.body.kind, "redirect");
        assert.match(String(started.body.authorizationUrl), new RegExp(`^${stub.base}/authorize\\?`));
        assert.equal(again.mcpPage.view().servers.find((each) => each.name === "issues")?.oauth?.waiting, started.body.authorizationUrl);

        const ended = (await fetch(String(started.body.authorizationUrl), { redirect: "manual" })).headers.get("location")!;
        const done = await post("mcp/issues/sign-in/complete", { url: ended });

        assert.deepEqual(done.body.servers?.find((each) => each.name === "issues")?.oauth, { signedIn: true });
        assert.equal((await post("mcp/issues/test", { folder: work })).body.ok, true);
        assert.ok(!JSON.stringify(again.mcpPage.view()).includes(TAIL), "no token on the page");

        const action = appSettings(again).actions.find((each) => each.id === "mcp.signIn")!;

        assert.match(await action.run(owner(again), { name: "issues" }), /signed in again with its stored sign-in/);
        assert.deepEqual((await post("mcp/issues/sign-out", {})).body.servers?.find((each) => each.name === "issues")?.oauth, { signedIn: false });
        assert.match(await action.run(owner(again), { name: "issues" }), new RegExp(`^Ask the owner to open this address and sign in: ${stub.base}/authorize`));
    } finally {
        oauthServer.closeAllConnections();
        oauthServer.close();
        await stub.close();
    }


    try {
        const enabled = appSettings(again).settings.find((each) => each.id === "mcp.enabled")!;

        assert.equal(again.mcpServers.get("docs")?.approved, false);
        await assert.rejects(async () => enabled.apply(owner(again), "on", "docs"), /changed since it was approved: turn it on with mcp_server_set/);
        assert.equal(again.mcpPage.enable("docs", true).approved, true, "the page is the owner's own hand");
        await again.mcpPage.remove("docs");
        assert.equal(again.mcpServers.get("docs"), undefined);
    } finally {
        await again.close();
    }
});
