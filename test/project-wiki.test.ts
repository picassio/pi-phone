// Project wikis (PP-42): pages by slug, written whole or by exact replacements, found by words (full-text search, whose
// own syntax never comes from the query), kept per board, and gone with their board.
import { cleanUp, root } from "./helpers.ts";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProjectWiki, slugOf } from "../src/gateway/project-wiki.ts";

after(() => cleanUp());

const ANNA = { id: "anna", name: "Anna" };
const PI = { id: "binh", name: "Pi (Binh)" };

test("a project's wiki: pages by slug, edits, search, per board", () => {
    const wiki = new ProjectWiki(mkdtempSync(join(root, "wiki-")));

    assert.equal(slugOf("Déploy notes: the devbox!"), "deploy-notes-the-devbox");
    const page = wiki.write("p1", { title: "Deploy notes", body: "We deploy with docker compose on the devbox.\n\nCaddy needs default_sni." }, ANNA);

    assert.deepEqual([page.slug, page.updatedByName], ["deploy-notes", "Anna"]);
    assert.throws(() => wiki.write("p1", { title: "", body: "x" }, ANNA), /title is 1 to/);
    assert.throws(() => wiki.write("p1", { slug: "Bad Slug", title: "x", body: "x" }, ANNA), /lowercase letters/);

    // Exact edits, once each.
    const edited = wiki.edit("p1", "deploy-notes", [{ oldText: "default_sni", newText: "default_sni {$PI_HOST}" }], PI);

    assert.match(edited.body, /default_sni \{\$PI_HOST\}/);
    assert.equal(edited.updatedByName, "Pi (Binh)");
    assert.throws(() => wiki.edit("p1", "deploy-notes", [{ oldText: "nowhere", newText: "x" }], PI), /not on deploy-notes/);
    wiki.write("p1", { title: "Twice", body: "same same" }, ANNA);
    assert.throws(() => wiki.edit("p1", "twice", [{ oldText: "same", newText: "x" }], PI), /2 times/);

    // Words find pages (as prefixes); search syntax in the query is only words.
    assert.deepEqual(wiki.search("p1", "dock").map((hit) => hit.slug), ["deploy-notes"]);
    assert.match(wiki.search("p1", "caddy")[0]!.snippet, /\*\*Caddy\*\*/);
    assert.deepEqual(wiki.search("p1", 'compose" OR title:*'), wiki.search("p1", "compose OR title"));
    assert.deepEqual(wiki.search("p2", "docker"), [], "per board");

    // Rewritten, the old words are gone from search; the board gone, its pages too.
    wiki.write("p1", { slug: "deploy-notes", title: "Deploy notes", body: "Now with kubernetes." }, ANNA);
    assert.deepEqual(wiki.search("p1", "docker"), []);
    assert.deepEqual(wiki.list("p1").map((entry) => entry.slug), ["deploy-notes", "twice"]);
    wiki.forget("p1");
    assert.deepEqual(wiki.list("p1"), []);
    assert.throws(() => wiki.read("p1", "deploy-notes"), /no page deploy-notes/);
});
