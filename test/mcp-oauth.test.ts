// OAuth for MCP servers over HTTP (PP-530), against a stub authorization server: a server not signed in says the owner
// must sign in (no death, no call); the sign-in's authorization URL carries PKCE S256, the client registered for it
// and the loopback redirect; the code comes back through the loopback callback (the phone's own browser) or a pasted
// address, and is exchanged for tokens kept in <data>/mcp/oauth.json, 0600, hidden from outputs; an access token the
// server refuses is refreshed once, for every request waiting, and the call goes on; Sign out forgets them.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Connection, localDaemon } from "@earendil-works/pi-env";
import { McpServers } from "../src/server/mcp/config.ts";
import { McpManager } from "../src/server/mcp/manager.ts";
import { McpOAuth } from "../src/server/mcp/oauth.ts";
import { Secrets } from "../src/server/secrets.ts";
import { HiddenValues } from "../src/server/hidden.ts";
import { startOAuthStub, TAIL } from "./support/mcp-oauth-stub.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "mcp-oauth-")));
const connection = new Connection({ command: [localDaemon()] });

after(() => {
    connection.close();
    rmSync(root, { recursive: true, force: true });
});

const textOf = (result: { content: { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

async function setup(name: string) {
    const stub = await startOAuthStub();
    const data = join(root, name);

    mkdirSync(data, { recursive: true });
    const servers = new McpServers(data);
    const hidden = new HiddenValues();
    const secrets = new Secrets(data, Date.now, () => {}, hidden);
    let changes = 0;
    const oauth = new McpOAuth({ dataDir: data, servers, hidden, secret: (each) => secrets.value(each), changed: () => (changes += 1), log: () => {} });
    const manager = new McpManager({
        servers,
        secrets,
        where: () => ({ connection, home: root }),
        notify: () => {},
        log: () => {},
        authProvider: (server) => oauth.authProvider(server),
    });

    after(async () => {
        await manager.close();
        await oauth.close();
        await stub.close();
    });
    servers.save("docs", { url: stub.url, oauth: {} });

    return { stub, servers, secrets, oauth, manager, work: data, hidden, changes: () => changes };
}

/** The browser: follow the authorization URL to the redirect it answers with (the stub signs in at once). */
async function browse(authorizationUrl: string): Promise<string> {
    const answer = await fetch(authorizationUrl, { redirect: "manual" });

    return answer.headers.get("location")!;
}

test("not signed in: the server says the owner must sign in; no death, no call", async () => {
    const { manager, work, stub } = await setup("first");

    await assert.rejects(manager.tools("docs", work), /needs the owner to sign in: Settings › MCP servers › Sign in/);
    assert.equal(manager.status()[0]?.deaths, 0);
    assert.equal(stub.seen.grants.authorization_code, undefined);
});

test("the sign-in: an authorize URL with PKCE and the loopback redirect, the code exchanged through the loopback callback, tokens kept private and hidden", async () => {
    const { oauth, manager, work, stub, hidden, changes } = await setup("loopback");
    const started = await oauth.start("docs");

    assert.equal(started.kind, "redirect");
    assert.ok(started.kind === "redirect");

    const url = new URL(started.authorizationUrl);

    assert.equal(url.origin + url.pathname, `${stub.base}/authorize`);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("client_id"), "client-1");
    assert.match(url.searchParams.get("redirect_uri")!, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.equal(stub.seen.registrations, 1);
    assert.equal(oauth.waiting("docs"), started.authorizationUrl);

    // The phone's browser goes to the loopback callback by itself.
    const redirect = await browse(started.authorizationUrl);
    const page = await fetch(redirect);

    assert.equal(page.status, 200);
    await oauth.settled("docs");
    assert.equal(oauth.waiting("docs"), undefined);
    assert.ok(oauth.signedIn("docs"));
    assert.equal(stub.seen.grants.authorization_code, 1);
    assert.ok(changes() >= 1, "the owner's tabs heard it");

    const file = join(work, "mcp", "oauth.json");

    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.match(readFileSync(file, "utf8"), /"access_token":"at-1-/);
    assert.equal(hidden.for(1).some((each) => each.text === `rt-1-${TAIL}`), true, "the refresh token is hidden from outputs");
    assert.equal(hidden.replace(`token at-1-${TAIL}`, 1), "token [mcp oauth docs]");

    assert.equal(textOf(await manager.call("docs", work, "whoami", {})), `token at-1-${TAIL}`);
});

test("a pasted address completes a sign-in; a refused access token is refreshed once and the call goes on; sign out forgets it", async () => {
    const { oauth, manager, work, stub } = await setup("pasted");
    const started = await oauth.start("docs");

    assert.ok(started.kind === "redirect");

    // A browser elsewhere: the address it ended on, pasted. One that is not this sign-in's is refused.
    const redirect = await browse(started.authorizationUrl);

    await assert.rejects(oauth.complete("docs", redirect.replace(/state=[^&]+/, "state=wrong")), /belongs to a different sign-in/);
    await oauth.complete("docs", redirect);
    assert.ok(oauth.signedIn("docs"));
    assert.equal(textOf(await manager.call("docs", work, "whoami", {})), `token at-1-${TAIL}`);

    // The server stops taking at-1: the provider refreshes once (rt-1 → at-2), and the calls go on.
    stub.expire();
    const [one, two] = await Promise.all([manager.call("docs", work, "whoami", {}), manager.call("docs", work, "whoami", {})]);

    assert.equal(textOf(one), `token at-2-${TAIL}`);
    assert.equal(textOf(two), `token at-2-${TAIL}`);
    assert.equal(stub.seen.grants.refresh_token, 1, "one refresh for both");

    // A start with tokens it can refresh signs in without the browser.
    stub.expire();
    assert.deepEqual(await oauth.start("docs"), { kind: "authorized" });
    assert.equal(stub.seen.grants.refresh_token, 2);

    oauth.signOut("docs");
    assert.ok(!oauth.signedIn("docs"));
    await manager.reconnect("docs");
    await assert.rejects(manager.call("docs", work, "whoami", {}), /needs the owner to sign in/);
});
