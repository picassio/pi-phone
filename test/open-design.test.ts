// OpenDesign's content in third_party/open-design (PP-241, PP-242): every kept skill ships its own MIT licence and is
// listed in the README with it; the sync script's front-matter changes keep the rest of SKILL.md as it was.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { SKILLS, TARGET, withDescription, withNote } from "../scripts/sync-open-design.ts";

test("each kept skill ships its MIT licence, with pi-phone's note, and the README names it with its licence", () => {
    const readme = readFileSync(join(TARGET, "README.md"), "utf8");

    assert.match(readFileSync(join(TARGET, "LICENSE"), "utf8"), /Apache License\s+Version 2\.0/);
    assert.deepEqual(readdirSync(join(TARGET, "skills")).sort(), SKILLS.map((skill) => basename(skill.from)).sort());

    for (const skill of SKILLS) {
        const name = basename(skill.from);
        const folder = join(TARGET, "skills", name);
        const markdown = readFileSync(join(folder, "SKILL.md"), "utf8");

        assert.match(readFileSync(join(folder, "LICENSE"), "utf8"), /^MIT License/, name);
        assert.match(markdown, new RegExp(`^---\\nname: ${name}\\n`), name);
        assert.match(markdown, /\n---\n\n<!-- pi-phone: added \(third_party\/open-design\/README\.md\) -->\n/, name);
        assert.match(readme, new RegExp(`\\| \`${name}\` \\| \`${skill.from}\` \\|[^\\n]*\\| MIT, © 2026 `), name);

        if (skill.kind === "deck") {
            assert.match(markdown, /\ndescription: "HTML slide deck template \\"[^"\\]+\\" \(OpenDesign, MIT\): /, name);
            assert.ok(existsSync(join(folder, "example.html")), name);
        }
    }
});

test("a deck's description becomes one quoted line, and the note goes after the front matter", () => {
    const markdown = "---\nname: deck\ndescription: |\n  An example subject.\n  On two lines.\nen_description: |\n  Kept.\n---\n\n# Deck\n";
    const changed = withNote(withDescription(markdown, 'A "deck".'), ["<!-- note -->"]);

    assert.equal(changed, '---\nname: deck\ndescription: "A \\"deck\\"."\nen_description: |\n  Kept.\n---\n\n<!-- note -->\n\n# Deck\n');
});
