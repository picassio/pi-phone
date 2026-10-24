// What the wiki's search by meaning costs (its remote embeddings, para.ts → Spend.wikiUsed): counted for the owner in
// Spend, in the total and on a line of its own, kept across restarts, and nobody's limit.
import { cleanUp, context, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { SpendDoc } from "../src/server/docs.ts";

after(() => cleanUp());

test("the wiki's embeddings are counted in Spend, kept across a restart, and charged to nobody", async () => {
    const dataDir = join(root, "wiki-spend");
    let app = await openApp(scriptedModel(), dataDir);

    app.spend.wikiUsed({ model: "openai/text-embedding-3-small", tokens: 1200, cost: 0.000024 });
    app.spend.wikiUsed({ model: "openai/text-embedding-3-small", tokens: 300, cost: 0.000006 });

    const summary = app.spend.summary(owner(app));

    assert.equal(summary.wiki?.requests, 2);
    assert.equal(summary.wiki?.tokens, 1500);
    assert.ok(Math.abs((summary.wiki?.cost ?? 0) - 0.00003) < 1e-12);
    assert.ok(Math.abs((summary.total ?? 0) - 0.00003) < 1e-12, "in the total");
    assert.ok(summary.people.every((person) => person.spent === 0), "nobody's spend");

    // Stored with the next count, then read back after a restart.
    await until(async () => (await app.harness.snapshot(SpendDoc, context))?.wiki?.requests === 2, "stored", 15_000);
    // Read again once stored: what the count kept must outlive its transaction ("Cannot use a settled overlay").
    assert.equal(app.spend.summary(owner(app)).wiki?.tokens, 1500, "read after the count");
    await app.close();
    app = await openApp(scriptedModel(), dataDir);
    await until(() => app.spend.summary(owner(app)).wiki?.requests === 2, "read back");
    app.spend.wikiUsed({ model: "openai/text-embedding-3-small", tokens: 100, cost: 0.000002 });
    assert.equal(app.spend.summary(owner(app)).wiki?.tokens, 1600, "added to what was stored");
    await app.close();
});
