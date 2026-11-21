// huashu-design's ideas (PP-544): not bundled as a skill; rewritten in English as pi-phone's own references beside
// Effective HTML's design-artifact, credited in third_party/huashu-design (MIT, upstream's LICENSE, the commit), and
// reached through one sentence of design-artifact's pi-phone note, with its description unchanged.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";

const CREDIT = join(APP_ROOT, "third_party", "huashu-design");
const SKILL = join(APP_ROOT, "third_party", "effective-html", "skills", "design-artifact");
const REFERENCES = ["directions.md", "borrowing.md", "colour-type.md", "materials.md"];

test("the credit folder holds upstream's MIT licence and a README naming the commit and every adapted file", () => {
    assert.match(readFileSync(join(CREDIT, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 alchaincyf/);
    const readme = readFileSync(join(CREDIT, "README.md"), "utf8");

    assert.ok(readme.includes("c4cc21943a8026d2d7aa33bd56b72b5be1926923"), "the commit");
    assert.ok(readme.includes("https://github.com/alchaincyf/huashu-design"), "the link");

    for (const file of REFERENCES) {
        assert.ok(readme.includes(`design-artifact/references/${file}`), file);
    }

    assert.deepEqual(readdirSync(CREDIT).sort(), ["LICENSE", "README.md"], "no upstream file but its licence");
});

test("each reference is English, ends with its credit, and design-artifact's note points to it", () => {
    const markdown = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const note = /\n> \*\*In pi-phone:\*\*([^\n]*)\n/.exec(markdown)?.[1];

    assert.ok(note !== undefined, "the pi-phone note");
    assert.match(markdown, /^---\nname: design-artifact\ndescription: Design principles and creative direction for building HTML artifacts — pages, reports, plans, landing pages, demos, decks, and small tools\. Use when creating or restyling any visual HTML deliverable and deciding its palette, type pairing, layout, theming, or overall register, or when the output must not look generically AI-generated\.\n---\n/, "description unchanged");
    assert.equal(markdown.match(/<!-- pi-phone:/g)?.length, 1, "still one marked note");

    for (const file of REFERENCES) {
        const path = join(SKILL, "references", file);

        assert.ok(existsSync(path), file);
        const text = readFileSync(path, "utf8");

        assert.ok(note.includes(`references/${file}`) || note.includes(`\`${file}\``), `the note names ${file}`);
        assert.match(text, /\n---\nAdapted for pi-phone from [^]*\[huashu-design\]\(https:\/\/github\.com\/alchaincyf\/huashu-design\)\sby alchaincyf\s\(花叔\),\scommit `c4cc219`, MIT\.\sSee\s`third_party\/huashu-design\/`\.\n$/, `${file}'s credit`);
        // Rewritten, not copied: the only CJK is the author's name in the credit line.
        assert.deepEqual(text.replace("花叔", "").match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) ?? [], [], `${file} is English`);
    }
});

test("the three directions stay optional and use pi-phone's tools", () => {
    const directions = readFileSync(join(SKILL, "references", "directions.md"), "utf8");

    assert.match(directions, /## When to run it\n\n- A \*\*new brief in the editorial register\*\*[^]*the person \*\*asks for options\*\*/);
    for (const tool of ["`interview`", "`artifact`", "`screenshot`", "`web_search`", "`browser_eval`", "`wiki_query`"]) {
        assert.ok(directions.includes(tool), tool);
    }

    assert.ok(!/\b(python3|playwright|ref_board|ref_card|polish\.py|design_lint)\b/.test(directions), "no upstream scripts");
});
