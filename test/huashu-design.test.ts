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
const REFERENCES = ["directions.md", "borrowing.md", "colour-type.md", "materials.md", "styles.md"];
/** PP-546: the catalogue's sections, by sheet, with the letter and number of entries each has. */
const SECTIONS = [
    { sheet: "web", letter: "W", count: 20 },
    { sheet: "ppt", letter: "P", count: 20 },
    { sheet: "info", letter: "I", count: 20 },
    { sheet: "app", letter: "A", count: 12 },
    { sheet: "east", letter: "E", count: 12 },
    { sheet: "xhs", letter: "X", count: 8 },
];

test("the credit folder holds upstream's MIT licence and a README naming the commit and every adapted file", () => {
    assert.match(readFileSync(join(CREDIT, "LICENSE"), "utf8"), /^MIT License\n\nCopyright \(c\) 2026 alchaincyf/);
    const readme = readFileSync(join(CREDIT, "README.md"), "utf8");

    assert.ok(readme.includes("c4cc21943a8026d2d7aa33bd56b72b5be1926923"), "the commit");
    assert.ok(readme.includes("https://github.com/alchaincyf/huashu-design"), "the link");

    for (const file of REFERENCES) {
        assert.ok(readme.includes(`design-artifact/references/${file}`), file);
    }
    // PP-545: the layout check's rules from design_lint.py, and the fixtures adapted from its test pages.
    for (const file of [
        "src/server/layout-check.ts",
        "src/server/file-pages.ts",
        "src/server/extensions/screenshot.ts",
        "src/skills/ui-verify/SKILL.md",
        "test/fixtures/layout/huashu-slop.html",
        "test/fixtures/layout/huashu-clean.html",
    ]) {
        assert.ok(readme.includes(`\`${file}`), file);
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

test("the style catalogue: 92 entries numbered as the seven sheets beside it, the random pick drawing from it, the sheets credited and the PolyForm stickers out (PP-546)", () => {
    const styles = readFileSync(join(SKILL, "references", "styles.md"), "utf8");
    const sheets = join(SKILL, "assets", "sheets");
    let entries = 0;

    for (const { sheet, letter, count } of SECTIONS) {
        const numbers = [...styles.matchAll(new RegExp(`^### ${letter}(\\d\\d) `, "gm"))].map((each) => Number(each[1]));

        assert.deepEqual(numbers, Array.from({ length: count }, (_, index) => index + 1), `${letter}01 to ${letter}${count}, in order`);
        assert.ok(styles.includes(`\`assets/sheets/${sheet}.jpg\``), `${sheet}'s sheet is named`);
        entries += count;
    }
    assert.equal(entries, 92);
    assert.equal(styles.match(/^### /gm)?.length, 92, "no other entries");
    assert.match(styles, /\b(bold|neutral|quiet) · \d+ %\n/, "temperature and fit");

    const files = readdirSync(sheets).sort();
    let bytes = 0;

    assert.deepEqual(files, ["app.jpg", "east.jpg", "info.jpg", "paradigm.jpg", "ppt.jpg", "web.jpg", "xhs.jpg"], "the seven sheets and nothing else");
    for (const file of files) {
        const data = readFileSync(join(sheets, file));

        assert.deepEqual([...data.subarray(0, 3)], [0xff, 0xd8, 0xff], `${file} is a JPEG`);
        bytes += data.length;
    }
    assert.ok(bytes <= 1_400_000, `the sheets weigh ${bytes} bytes, under 1.4 MB`);

    const directions = readFileSync(join(SKILL, "references", "directions.md"), "utf8");

    assert.match(directions, /`S % N \+ 1` from the section of\s+`references\/styles\.md`[^]*East Asian section \(12\)/, "the random pick draws from the catalogue");
    assert.ok(!directions.includes("systems.ts list"), "no longer from the design systems' list");

    const readme = readFileSync(join(CREDIT, "README.md"), "utf8");

    for (const file of files) {
        assert.ok(readme.includes(`\`${file}\``), `the credit names ${file}`);
    }
    assert.match(readme, /`xhs\.jpg` \| [^|]*rendered again[^|]*silhouette[^|]*\| MIT\. The stickers are PolyForm Shield/, "the stickers replaced before the XHS sheet was rendered");
    assert.match(styles, /every sticker is a plain silhouette/, "the catalogue says so too");
});
