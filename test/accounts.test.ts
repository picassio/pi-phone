// More accounts of a provider (accounts.ts): each its own provider, with its own sign-in; a session on an account's
// model uses it; the default account is untouched; accounts outlive a restart; only the owner manages them.
import { type App, cleanUp, lastText, newSession, openApp, owner, root, say, scriptedModel } from "./helpers.ts";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai/providers/faux";
import { createHandler } from "../src/server/http.ts";

let requested: Message[] = [];
const model = scriptedModel((request) => {
    requested = (request as { messages: Message[] }).messages;

    return fauxAssistantMessage([fauxText(`echo: ${lastText(request as never).text}`)]);
});
const dataDir = join(root, "accounts-data");
let app: App;

after(async () => {
    await app?.close();
    cleanUp();
});

test("an account is a provider of its own: its models, its name, a session on it; renamed, restarted, removed", async () => {
    app = await openApp(model, dataDir);
    const account = app.accounts.add("faux", "Work");

    assert.equal(account.id, "faux~work");
    assert.equal(app.accounts.add("faux", "Work").id, "faux~work-2", "a second of the same name gets its own id");
    await app.accounts.remove("faux~work-2");
    assert.throws(() => app.accounts.add("nope", "X"), /Accounts are for faux/);

    // Signed in (a key for this run), as an account is once someone signs in to it from Providers. Pi checks a new
    // sign-in in the background, as the app's model refresh waits for it.
    await app.models.setRuntimeApiKey("faux~work", "work-key");
    await app.models.getAvailable();
    const listed = await app.modelList();

    assert.ok(listed.some((each) => each.provider === "faux~work" && each.id === "faux-1" && each.account === "Work"));
    assert.ok(listed.some((each) => each.provider === "faux" && each.account === "Default"), "the original is the default account");
    assert.deepEqual(
        app.providers.list(true).find((each) => each.id === "faux~work")?.account,
        { name: "Work", of: "faux" },
    );

    // A session on the account's model runs on it.
    const id = await newSession(app);

    await app.commands.configure(id, owner(app), { model: { provider: "faux~work", modelId: "faux-2" } });
    await say(app, id, "hello from work");
    assert.match(lastText({ messages: requested } as never).text, /hello from work/);

    app.accounts.rename("faux~work", "Office");
    assert.equal(app.accounts.get("faux~work")?.name, "Office", "renamed, the same id");

    // A restart registers it again before sessions resume.
    await app.close();
    app = await openApp(model, dataDir);
    assert.ok(app.models.getProvider("faux~work"), "registered as the app opens");
    assert.equal(JSON.parse(readFileSync(join(dataDir, "accounts.json"), "utf8")).accounts[0].name, "Office");
    await say(app, id, "after the restart");
    assert.match(lastText({ messages: requested } as never).text, /after the restart/);

    await app.accounts.remove("faux~work");
    assert.equal(app.models.getProvider("faux~work"), undefined);
    assert.equal(app.accounts.list().length, 0);
    assert.ok(existsSync(join(dataDir, "accounts.json")));
});

test("only the owner adds, renames, or removes accounts", async () => {
    const server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const guest = app.config.addUser("Guest accounts", "guest");
    const call = (token: string, route: string, body: unknown) =>
        fetch(`http://127.0.0.1:${port}/api/${route}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "x-pocket": "1", "content-type": "application/json" },
            body: JSON.stringify(body),
        });

    try {
        assert.equal((await call(guest.token, "accounts", { provider: "faux", name: "Mine" })).status, 403);
        const made = await call(app.config.ownerToken, "accounts", { provider: "faux", name: "Team" });

        assert.equal(made.status, 200, await made.clone().text());
        assert.equal(((await made.json()) as { account: { id: string } }).account.id, "faux~team");
        assert.equal((await call(guest.token, "accounts/faux~team", { name: "X" })).status, 403);
        assert.equal((await call(guest.token, "accounts/faux~team/remove", {})).status, 403);
        assert.equal((await call(app.config.ownerToken, "accounts/faux~team", { name: "Team 2" })).status, 200);
        assert.equal((await call(app.config.ownerToken, "accounts/faux~team/remove", {})).status, 200);
        assert.equal(app.accounts.list().length, 0);
    } finally {
        server.closeAllConnections();
        server.close();
        app.config.removeUser(guest.user.id);
    }
});
