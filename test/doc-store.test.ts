// The document store (PP-46): folders that nest (never inside themselves), pages named once a scope, every save a
// version to look at and restore, exact edits, backlinks, deletes kept to restore, keyword search across the scopes
// asked for, and each scope apart from the others.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { DocumentStore } from "../src/server/doc-store.ts";

after(() => cleanUp());

const ANNA = { id: "anna", name: "Anna" };
const PI = { id: "binh", name: "Pi (Binh)" };

test("documents: folders, pages, versions, links, deletes and search, by scope", () => {
    let clock = 1_000;
    const docs = new DocumentStore(join(mkdtempSync(join(root, "docs-")), "documents.sqlite"), () => clock++);

    // Folders nest, never inside themselves; names once a level.
    const guides = docs.makeFolder("team", null, "Guides");
    const deploy = docs.makeFolder("team", guides.id, "Deploy");

    assert.throws(() => docs.makeFolder("team", null, "guides"), /already a folder/);
    assert.throws(() => docs.changeFolder("team", guides.id, { parentId: deploy.id }), /inside itself/);
    assert.throws(() => docs.makeFolder("nowhere", null, "x"), /not a place documents are kept/);

    // Pages: named once a scope; every save a version.
    const page = docs.write("team", { folderId: deploy.id, title: "Devbox", body: "We deploy with compose." }, ANNA);

    assert.deepEqual(page.path, ["Guides", "Deploy"]);
    assert.throws(() => docs.write("team", { title: "devbox", body: "x" }, ANNA), /already a page called Devbox/);
    assert.equal(docs.write("mine", { title: "Devbox", body: "mine" }, ANNA).scope, "mine", "another scope, another page");
    const edited = docs.edit("team", page.id, [{ oldText: "compose", newText: "docker compose on the devbox" }], PI);

    assert.deepEqual([edited.body, edited.updatedByName], ["We deploy with docker compose on the devbox.", "Pi (Binh)"]);
    assert.deepEqual(docs.history("team", page.id).map((version) => version.byName), ["Pi (Binh)", "Anna"], "newest first");
    assert.throws(() => docs.edit("team", page.id, [{ oldText: "nowhere", newText: "x" }], PI), /not on Devbox/);

    // Backlinks: [[Title]] and [[Title|words]], in the scope.
    const runbook = docs.write("team", { title: "Runbook", body: "See [[Devbox|the devbox page]] first." }, ANNA);

    docs.write("team", { title: "Other", body: "Nothing about it." }, ANNA);
    assert.deepEqual(docs.backlinks("team", page.id).map((each) => each.id), [runbook.id]);

    // Search by words across the scopes asked for, with where the page is.
    const hits = docs.search(["team"], "dock");

    assert.deepEqual(hits.map((hit) => [hit.title, hit.path.join("/")]), [["Devbox", "Guides/Deploy"]]);
    assert.match(hits[0]!.snippet, /\*\*docker\*\*/);
    assert.deepEqual(docs.search(["mine"], "docker"), [], "only the scopes asked for");
    assert.deepEqual(docs.search(["team"], 'docker" OR scope:*'), docs.search(["team"], "docker OR scope"), "words only");

    // Restore a version: saved as the newest.
    const first = docs.history("team", page.id).at(-1)!;
    const restored = docs.restore("team", page.id, first.id, ANNA);

    assert.equal(restored.body, "We deploy with compose.");
    assert.equal(docs.history("team", page.id).length, 3);

    // Delete: gone from the tree and search, kept to restore; a folder takes its pages with it.
    docs.remove("team", runbook.id);
    assert.ok(!docs.tree("team").pages.some((each) => each.id === runbook.id));
    assert.deepEqual(docs.search(["team"], "first"), []);
    assert.deepEqual(docs.deleted("team").map((each) => each.title), ["Runbook"]);
    docs.restore("team", runbook.id, docs.history("team", runbook.id)[0]!.id, ANNA);
    assert.ok(docs.tree("team").pages.some((each) => each.id === runbook.id), "back");
    assert.equal(docs.removeFolder("team", guides.id), 1, "Devbox, in Deploy, in Guides");
    assert.deepEqual(docs.tree("team").folders, []);
    assert.deepEqual(docs.deleted("team").map((each) => each.title), ["Devbox"]);

    // A board deleted: its scope's documents go.
    docs.write("project:b1", { title: "Plan", body: "x" }, ANNA);
    docs.forgetScope("project:b1");
    assert.deepEqual(docs.tree("project:b1").pages, []);
});
