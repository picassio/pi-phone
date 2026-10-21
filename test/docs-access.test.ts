// Documents as a pi-phone reaches them (PP-46): Mine in its own store, each phone board's documents there too (no team
// server), and on the team server the team's and shared boards' at the gateway, with search put together from both.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Docs } from "../src/server/docs-access.ts";
import { Projects } from "../src/server/projects.ts";

after(() => cleanUp());

const ME = { id: "u-owner", name: "Owner" };

test("on the phone: Mine and each board's documents, kept here", async () => {
    const dir = mkdtempSync(join(root, "docs-phone-"));
    const projects = new Projects(dir, () => [{ ...ME, role: "owner" }]);

    projects.create({ kind: "person", person: { ...ME, role: "owner" } }, { key: "PP", name: "pi-phone" });

    const docs = new Docs({ dataDir: dir, me: () => ME, teamServer: undefined, projects });

    assert.deepEqual((await docs.scopes()).map((scope) => scope.id), ["mine", "project:PP"]);
    const note = (await docs.call("mine", "write", [{ title: "Ideas", body: "Ship documents." }])) as { scope: string; updatedByName: string };

    assert.deepEqual([note.scope, note.updatedByName], ["mine", "Owner"]);
    const plan = (await docs.call("project:PP", "write", [{ title: "Plan", body: "Ship the board docs." }], true)) as { scope: string; updatedByName: string };

    assert.deepEqual([plan.scope, plan.updatedByName], ["project:PP", "Pi (Owner)"], "a board's, by its key; Pi named");
    assert.deepEqual((await docs.search("ship")).map((hit) => [hit.scope, hit.title]).sort(), [["mine", "Ideas"], ["project:PP", "Plan"]]);
    await assert.rejects(docs.call("team", "tree", []), /not a place for documents here/);
    await assert.rejects(docs.call("mine", "drop", []), /not something documents do/);
    docs.close();
    projects.close();
});

test("on the team server: the team's and shared boards' documents at the gateway, Mine here", async () => {
    const asked: { method: string; args: unknown[]; pi?: unknown }[] = [];
    const gateway = (async (_url: string, init: { body: string }) => {
        const call = JSON.parse(init.body) as { method: string; args: unknown[]; pi?: unknown };

        asked.push(call);
        const value =
            call.method === "scopes"
                ? [{ id: "team", name: "Team", write: false }]
                : call.method === "search"
                  ? [{ scope: "team", pageId: "t1", title: "Onboarding", path: [], snippet: "**ship** it" }]
                  : { scope: "team", title: "Onboarding" };

        return new Response(JSON.stringify({ value }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const docs = new Docs({ dataDir: mkdtempSync(join(root, "docs-team-")), me: () => ME, teamServer: { url: "http://gateway:8081", token: "t".repeat(32) }, fetch: gateway });

    assert.deepEqual((await docs.scopes()).map((scope) => scope.id), ["mine", "team"]);
    await docs.call("team", "page", ["t1"]);
    await docs.call("team", "write", [{ title: "x", body: "y" }], true);
    assert.deepEqual(asked.slice(1).map((call) => [call.method, call.args[0], call.pi !== undefined]), [["page", "team", false], ["write", "team", true]], "the scope goes first; Pi says so");
    await docs.call("mine", "write", [{ title: "Ship notes", body: "ship" }]);
    assert.deepEqual((await docs.search("ship")).map((hit) => hit.scope).sort(), ["mine", "team"], "both places");
    docs.close();
});

test("Mine searched by meaning with the person's embedder: indexed after a save, the query embedded, both counted (PP-49)", async () => {
    const dir = mkdtempSync(join(root, "docs-meaning-"));
    const spent: number[] = [];
    // Stand-in vectors: "deploy" and "ship" mean the same; anything else, another thing.
    const embedder = {
        model: "stand/in",
        async embed(texts: string[]) {
            return { vectors: texts.map((text) => (/deploy|ship/i.test(text) ? [1, 0] : [0, 1])), tokens: texts.length };
        },
    };
    const docs = new Docs({ dataDir: dir, me: () => ME, teamServer: undefined, embedder: async () => embedder, spent: (usage) => spent.push(usage.tokens) });

    await docs.call("mine", "write", [{ title: "Release", body: "Ship it on Fridays." }]);
    await docs.call("mine", "write", [{ title: "Lunch", body: "Pizza." }]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.deepEqual(await docs.meaning(), { mine: true, team: null });
    assert.deepEqual((await docs.search("deploy")).map((hit) => hit.title), ["Release"], "found by meaning, not words");
    assert.ok(spent.length >= 2, "indexing and the query both counted");
    docs.close();
});

test("images in Mine described by the person's chosen model, and the page found by what they show (PP-49)", async () => {
    const dir = mkdtempSync(join(root, "docs-images-"));
    const asked: string[] = [];
    let model: string | undefined;
    const docs = new Docs({
        dataDir: dir,
        me: () => ME,
        teamServer: undefined,
        vision: async () => (model === undefined ? undefined : { model, describe: async (mime, _data, prompt) => (asked.push(`${mime}: ${prompt.slice(0, 20)}`), "A whiteboard sketch of the release train.") }),
    });
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00\x2c\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02\x44\x01\x00\x3b", "latin1");
    const image = (await docs.call("mine", "addImage", [{ name: "sketch", data: gif.toString("base64") }], true)) as { markdown: string; byName: string };

    assert.equal(image.byName, "Pi (Owner)");
    await docs.call("mine", "write", [{ title: "Retro", body: `Notes.\n\n${image.markdown}` }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(asked, [], "no model chosen: nothing sent");
    assert.deepEqual(await docs.search("whiteboard"), []);

    model = "anthropic/claude-sonnet-4-5";
    docs.describeImages();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(asked, ["image/gif: Describe this image "]);
    assert.deepEqual((await docs.search("whiteboard")).map((hit) => hit.title), ["Retro"]);
    docs.close();
});
