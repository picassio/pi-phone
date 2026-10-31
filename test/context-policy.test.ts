// What of the wiki, secrets, and skills goes into a session's prompt (PP-276): the choices, a section kept as the session
// has it, the skills kept while they name the same skills, and the words a message's wiki search looks for.
import assert from "node:assert/strict";
import { test } from "node:test";
import { contextMode, DEFAULT_CONTEXT_POLICY, frozenSkills, resolveContextPolicy, shownText, skillNames } from "../src/server/context-policy.ts";
import { tellingWords } from "../src/server/para.ts";

const skills = (entries: [string, string][]) =>
    `<available_skills>\n${entries.map(([name, description]) => `  <skill>\n    <name>${name}</name>\n    <description>${description}</description>\n  </skill>`).join("\n")}\n</available_skills>`;

test("the defaults: the wiki and secrets with a tool, skills frozen, the rarer tools loaded when needed; a session's own over every session's", () => {
    assert.deepEqual(DEFAULT_CONTEXT_POLICY, { wiki: "tool", secrets: "tool", skills: "frozen", tools: "load" });
    assert.deepEqual(resolveContextPolicy({ wiki: "live" }, { secrets: "list" }), { wiki: "live", secrets: "list", skills: "frozen", tools: "load" });
    assert.throws(() => contextMode("tools", "some"), /load, all/);
    assert.deepEqual(resolveContextPolicy({ wiki: "live" }, { wiki: "relevant" }).wiki, "relevant");
    assert.equal(contextMode("skills", "live"), "live");
    assert.throws(() => contextMode("wiki", "all of it"), /tool, relevant, frozen, live/);
    assert.throws(() => contextMode("secrets", undefined), /tool, list/);
});

test("a tagged section as the session has it, without its tags; a section that is not there is undefined", () => {
    assert.equal(shownText({ wiki: "<wiki>\nthe rules\nand the index\n</wiki>" }, "wiki"), "the rules\nand the index");
    assert.equal(shownText({}, "wiki"), undefined);
    assert.equal(shownText({ skills: "<available_skills>…" }, "skills", false), "<available_skills>…");
});

test("skills frozen: the list the session has while it names the same skills, the new one when skills come or go", () => {
    const had = skills([["html", "Pages"], ["officecli", "Office files"]]);
    const reworded = skills([["html", "Pages, reworded by an update"], ["officecli", "Office files"]]);
    const more = skills([["html", "Pages"], ["officecli", "Office files"], ["design-system", "Looks"]]);

    assert.deepEqual(skillNames(more), ["html", "officecli", "design-system"]);
    assert.equal(frozenSkills(had, reworded), had, "not sent again for a rewording");
    assert.equal(frozenSkills(had, more), more, "a skill added");
    assert.equal(frozenSkills(more, had), had, "a skill taken away");
    assert.equal(frozenSkills(undefined, had), had, "the first time");
});

test("a message's telling words for the wiki's keyword search: names and longer words, not the plain ones, at most six", () => {
    assert.deepEqual(tellingWords("why does the shell outlive its socket"), ["outlive", "socket", "shell"]);
    assert.ok(tellingWords("check PP-276 and the wiki please").includes("pp-276"));
    assert.ok(!tellingWords("check PP-276 and the wiki please").includes("please"));
    assert.equal(tellingWords("alpha bravo charlie delta echoes foxtrot golfing hotels").length, 6);
    assert.deepEqual(tellingWords("Kiểm tra lại không được"), ["kiểm"]);
    // None: the message brings no pages (Para.relevant searches nothing).
    assert.deepEqual(tellingWords("Làm đi"), []);
    assert.deepEqual(tellingWords("ok, do it"), []);
});
