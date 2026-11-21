// huashu-design's ideas beyond design-artifact (PP-547): a look pass and a critique for ui-verify, a brand's assets for
// brand-extract, app paradigms and the presentation board for html-prototype. Each is pi-phone's own reference in
// English, credited (third_party/huashu-design), reached by one line of its skill's body, with the skill's
// description unchanged (the prompt holds descriptions only).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";

const REFERENCES = [
    { skill: ["src", "skills", "ui-verify"], file: "look-pass.md", from: "polish-loop.md", description: "b7383dd4cfca3c66" },
    { skill: ["src", "skills", "ui-verify"], file: "critique.md", from: "critique-guide.md", description: "b7383dd4cfca3c66" },
    { skill: ["src", "design", "skills", "brand-extract"], file: "assets.md", from: "brand-asset-protocol.md", description: "7536c84a9e7cc386" },
    { skill: ["third_party", "effective-html", "skills", "html-prototype"], file: "app-paradigms.md", from: "app-paradigms.md", description: "a37ea43473c41b31" },
];

test("each reference is English, credited, and named in its skill's body, whose description is as it was (PP-547)", () => {
    const credit = readFileSync(join(APP_ROOT, "third_party", "huashu-design", "README.md"), "utf8");

    for (const { skill, file, from, description } of REFERENCES) {
        const folder = join(APP_ROOT, ...skill);
        const markdown = readFileSync(join(folder, "SKILL.md"), "utf8");
        const text = readFileSync(join(folder, "references", file), "utf8");
        const frontMatter = /^---\n[^]*?\n---\n/.exec(markdown)?.[0] ?? "";
        const body = markdown.slice(frontMatter.length);
        const said = /^description: (.*)$/m.exec(frontMatter)?.[1] ?? "";

        assert.equal(createHash("sha256").update(said).digest("hex").slice(0, 16), description, `${skill.at(-1)}'s description unchanged`);
        assert.ok(!frontMatter.includes(file), `${file} is not in the description`);
        assert.equal(body.split("\n").filter((line) => line.includes(`references/${file}`)).length, 1, `one line of ${skill.at(-1)} names ${file}`);
        assert.match(text, new RegExp(`\\n---\\nAdapted for pi-phone from \`references/${from.replace(".", "\\.")}\`[^]*\\[huashu-design\\]\\(https://github\\.com/alchaincyf/huashu-design\\)\\sby alchaincyf\\s\\(花叔\\),\\scommit \`c4cc219\`, MIT\\.\\sSee\\s\`third_party/huashu-design/\`\\.\\n$`), `${file}'s credit`);
        assert.deepEqual(text.replace("花叔", "").match(/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/g) ?? [], [], `${file} is English`);
        assert.ok(credit.includes(`${skill.join("/")}/references/${file}`), `the credit lists ${file}`);
        assert.ok(!/\b(python3|playwright|polish\.py|design_lint|appstore_shots|nano-banana|WebSearch)\b/.test(text), `${file} names pi-phone's tools, not upstream's`);
    }
});

test("what each one keeps: the look pass's eight questions and rounds, the critique's concept cap, the logo first, the eight paradigms and the board (PP-547)", () => {
    const [look, critique, assets, paradigms] = REFERENCES.map(({ skill, file }) => readFileSync(join(APP_ROOT, ...skill, "references", file), "utf8"));

    assert.ok(look !== undefined && critique !== undefined && assets !== undefined && paradigms !== undefined);

    assert.equal(look.match(/^\d\. \*\*/gm)?.length, 8, "eight questions");
    assert.match(look, /Fix only the worst three in a round/);
    assert.match(look, /Still rebuilding large parts in round 5[^]*stop/);
    assert.match(look, /`screenshot`[^]*`save`[^]*`media`[^]*`read`/, "pi-phone's tools to look at real size");
    assert.match(critique, /with concept at 5 or less, the overall score is 6\.0 at most/);
    assert.match(critique, /Change the client's or product's name[^]*it is a template/);
    assert.match(assets, /\| \*\*Logo\*\* \|[^\n]*\| Always/);
    assert.match(assets, /api\.svgl\.app[^]*cdn\.simpleicons\.org[^]*google\.com\/s2\/favicons/, "the logo's sources in order");
    assert.match(assets, /\*\*A comparison of named products\*\*[^]*each one's logo/);
    assert.equal(paradigms.match(/^### 0\d /gm)?.length, 8, "eight paradigms");
    assert.equal(paradigms.match(/^- \*\*On the web:\*\*/gm)?.length, 8, "each brought to the web");
    assert.match(paradigms, /## The presentation board[^]*300 px wide or more/);
});
