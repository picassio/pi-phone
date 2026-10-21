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
import { DocumentStore, indexer } from "../src/server/doc-store.ts";
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
