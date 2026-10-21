// Search by meaning in documents (PP-49), with a stand-in embedder whose vectors put words of one meaning together: a
// page is split into passages by heading; only passages not yet embedded with the model are embedded (an edit embeds
// again only what changed; a new model, everything); the query finds a page that shares none of its words, merged with
// keyword hits; what embedding cost is counted; and without an embedder, search is by keyword.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { describer, DocumentStore, indexer } from "../src/server/doc-store.ts";
import { type Embedder, passages } from "../src/server/embeddings.ts";

after(() => cleanUp());

const ME = { id: "me", name: "Me" };
// Each meaning, a direction: deploying, money, food.
const MEANINGS: Record<string, number> = { deploy: 0, release: 0, ship: 0, rollout: 0, invoice: 1, budget: 1, cost: 1, lunch: 2, pizza: 2, food: 2 };
const embedded: string[] = [];

function stand(model: string): Embedder {
    return {
        model,
        async embed(texts) {
            embedded.push(...texts);

            return {
                vectors: texts.map((text) => {
                    const vector = [0, 0, 0, 0.01];

                    for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
                        const at = MEANINGS[word];

                        if (at !== undefined) {
                            vector[at]! += 1;
                        }
                    }

                    return vector;
                }),
                tokens: texts.join(" ").length,
                cost: 0.001,
            };
        },
    };
}

test("passages: by heading, then paragraphs, each with the title and folder", () => {
    const parts = passages("Runbook", ["Guides"], "Intro\n\n# Deploy\nShip it.\n\n# Costs\nWatch the budget.");

    assert.equal(parts.length, 3);
    assert.ok(parts.every((part) => part.startsWith("Runbook (Guides)\n")));
    assert.match(parts[1]!, /# Deploy\nShip it\./);
    assert.ok(passages("Long", [], "x".repeat(7000)).every((part) => part.length <= 3200 + 10), "long text cut");
});

test("documents are found by meaning, merged with keywords; only what changed is embedded again", async () => {
    const docs = new DocumentStore(join(mkdtempSync(join(root, "docsearch-")), "documents.sqlite"));
    const spent: number[] = [];
    let embedder: Embedder | undefined = stand("m1");
    const run = indexer(docs, async () => embedder, (usage) => spent.push(usage.cost ?? 0), () => {});
    const settle = async () => {
        run();
        // The run is in the background: give it its turn.
        for (let i = 0; i < 20 && docs.pending(embedder?.model ?? "m1", 1).length > 0; i++) {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };

    docs.write("team", { title: "Release steps", body: "# Rollout\nShip the build to the devbox." }, ME);
    docs.write("team", { title: "Lunch", body: "Pizza on Fridays." }, ME);
    docs.write("team", { title: "Money", body: "Every invoice goes to the budget sheet." }, ME);
    await settle();
    assert.deepEqual(docs.indexed(), { passages: 3, embedded: 3 });
    assert.equal(spent.length, 1, "one batch, its cost counted");

    // "deploy" is on no page; by meaning it finds Release steps first.
    const query = (await stand("m1").embed(["deploy"])).vectors[0]!;
    const hits = docs.hybrid(["team"], "deploy", query, 5);

    assert.equal(hits[0]?.title, "Release steps");
    assert.match(hits[0]!.snippet, /Ship the build/);
    // Without a vector: by keyword only, so nothing.
    assert.deepEqual(docs.hybrid(["team"], "deploy", null, 5), []);
    // Keywords still count: "pizza" finds Lunch.
    assert.equal(docs.hybrid(["team"], "pizza", (await stand("m1").embed(["pizza"])).vectors[0]!, 5)[0]?.title, "Lunch");

    // An edit embeds again only the passage that changed.
    embedded.length = 0;
    const lunch = docs.byTitle("team", "Lunch")!;

    docs.write("team", { id: lunch.id, title: "Lunch", body: "Pizza on Fridays, salad on Mondays." }, ME);
    await settle();
    assert.equal(embedded.length, 1);

    // A new model: everything again.
    embedded.length = 0;
    embedder = stand("m2");
    await settle();
    assert.equal(embedded.length, 3);

    // A store opened again: pages with no passages (saved before search by meaning) are cut when it opens.
    const file = join(mkdtempSync(join(root, "docsearch-")), "documents.sqlite");
    const old = new DocumentStore(file);

    old.write("team", { title: "Old", body: "An invoice." }, ME);
    old.close();
    const raw = new DatabaseSync(file);

    raw.exec("DELETE FROM doc_chunks");
    raw.close();
    const reopened = new DocumentStore(file);

    assert.deepEqual(reopened.indexed(), { passages: 1, embedded: 0 });
    reopened.close();

    // No embedder: nothing pends forever, search is by keyword.
    embedder = undefined;
    run();
    assert.equal(docs.hybrid(["team"], "invoice", null, 5)[0]?.title, "Money");
});

test("images: added without metadata, described, and their pages found by what they show (PP-49)", async () => {
    const docs = new DocumentStore(join(mkdtempSync(join(root, "docimages-")), "documents.sqlite"));
    // A PNG with a tEXt chunk carrying a location.
    const chunk = (type: string, data: string) => {
        const length = Buffer.alloc(4);

        length.writeUInt32BE(data.length);

        return Buffer.concat([length, Buffer.from(type + data, "latin1"), Buffer.alloc(4)]);
    };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", "x".repeat(13)), chunk("tEXt", "GPS\0Bangkok 13.75N"), chunk("IDAT", "px"), chunk("IEND", "")]);
    const image = docs.addImage("team", { name: "network [v2]", data: png.toString("base64") }, ME);

    assert.equal(image.mime, "image/png");
    assert.equal(image.name, "network  v2", "no brackets that would break its markdown");
    assert.equal(image.markdown, `![network  v2](image:${image.id})`);
    assert.ok(!Buffer.from(docs.image("team", image.id).data, "base64").includes("Bangkok"), "location gone");
    assert.throws(() => docs.image("project:x", image.id), /No such image here/, "only in its own place");
    assert.throws(() => docs.addImage("team", { name: "x", data: Buffer.from("<svg/>").toString("base64") }, ME), /Only PNG, JPEG, WebP and GIF/);

    docs.write("team", { title: "Architecture", body: `How it fits together:\n\n${image.markdown}` }, ME);
    assert.deepEqual(docs.search(["team"], "router"), [], "not yet described");

    // Described by a stand-in vision model: its words go into search with the page.
    const seen: string[] = [];
    let indexed = 0;
    const run = describer(docs, async () => ({ model: "v1", describe: async (mime) => (seen.push(mime), "A network diagram: a router, two switches and a firewall.") }), () => indexed++, () => {});

    run();
    for (let i = 0; i < 20 && docs.pendingImages("v1").length > 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.deepEqual(seen, ["image/png"]);
    assert.ok(indexed >= 1, "then embedded");
    assert.equal(docs.image("team", image.id).description, "A network diagram: a router, two switches and a firewall.");
    assert.equal(docs.search(["team"], "router")[0]?.title, "Architecture");
    assert.equal(docs.pendingImages("v1").length, 0);

    // A failed description waits for another model, not this one again.
    const second = docs.addImage("team", { name: "b", data: png.toString("base64") }, ME);

    docs.setDescription(second.id, "v1", "");
    assert.equal(docs.pendingImages("v1").length, 0);
    assert.equal(docs.pendingImages("v2").length, 1);

    // A deleted board: its images go too.
    docs.forgetScope("team");
    assert.throws(() => docs.image("team", image.id), /No such image here/);
    docs.close();
});
