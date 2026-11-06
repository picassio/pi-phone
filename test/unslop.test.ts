// heydamir's unslop skill (PP-327), bundled in third_party/heydamir-unslop under Design & video: CC BY 4.0 with its
// credit, upstream's folder whole at the pinned commit, pi-phone's one marked note after the front matter, and
// design-artifact's pointer to its sign list. That Design & video lists it, and off hides it, is in skills.test.ts.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { DESIGN_SKILLS } from "../src/server/design-systems.ts";
import { COMMIT, NOTE, SKILL, TARGET, withPiPhone } from "../scripts/sync-unslop.ts";

test("the skill ships with CC BY 4.0, its credit, upstream's files and pi-phone's one note", () => {
    const markdown = readFileSync(join(SKILL, "SKILL.md"), "utf8");
    const readme = readFileSync(join(TARGET, "README.md"), "utf8");

    assert.match(readFileSync(join(TARGET, "LICENSE"), "utf8"), /^Attribution 4\.0 International\n/);
    assert.match(markdown, /^---\nname: unslop\ndescription: Turns vibecoded, AI-looking UI[^\n]*\nlicense: CC-BY-4\.0\n[^]*?\n---\n\n<!-- pi-phone: added \(third_party\/heydamir-unslop\/README\.md\) -->\n> In pi-phone:\n/);
    assert.ok(markdown.includes(`${NOTE.join("\n")}\n\n# Unslop\n\nunslop was created by Damir Sokolovsky`), "the note, then upstream's credit line");
    assert.equal(markdown.match(/<!-- pi-phone:/g)?.length, 1, "one marked note");
    assert.ok(readme.includes(COMMIT), "the README names the commit");
    assert.ok(readme.includes("Damir Sokolovsky") && readme.includes("https://github.com/heydamir/unslop"), "credit and link");
    assert.ok(readme.includes("Modified by pi-phone: one marked note"));

    // Impeccable's craft floor (PP-417): three lines inside the marked note, credited in the README.
    const note = NOTE.join("\n");

    for (const line of [/Text selection, the caret, scrollbars, focus rings, underline offset, tabular numerals/i, /Shadows carry an offset and a soft blur; a zero-offset coloured halo is decoration/, /More space above a heading than below it/]) {
        assert.match(note, line);
    }

    assert.ok(readme.includes("https://github.com/pbakaus/impeccable") && readme.includes("Paul Bakaus") && readme.includes("c8891a9") && readme.includes("Apache License 2.0"), "Impeccable's credit");

    for (const reference of ["signs.md", "tokens.md", "visuals.md", "effects.md", "refs.md"]) {
        assert.match(readFileSync(join(SKILL, "references", reference), "utf8"), /Part of unslop by Damir Sokolovsky \(\[@heydamir\]\(https:\/\/x\.com\/heydamir\)\), CC BY 4\.0\./, reference);
    }

    for (const file of ["agents/openai.yaml", "scripts/snapshot.mjs", "scripts/story.mjs", "references/refs/unslop-hero-after.webp"]) {
        assert.ok(existsSync(join(SKILL, file)), file);
    }
});

test("pi-phone's note goes after the front matter, which stays whole", () => {
    assert.equal(withPiPhone("---\nname: s\nlicense: x\n---\n\n# S\n", ["<!-- note -->"]), "---\nname: s\nlicense: x\n---\n\n<!-- note -->\n\n# S\n");
    assert.throws(() => withPiPhone("# no front matter\n", []), /no front matter/);
});

test("Design & video's skill folders hold it, and design-artifact points to its sign list", () => {
    assert.ok(DESIGN_SKILLS.includes(join(APP_ROOT, "third_party", "heydamir-unslop", "skills")));
    assert.match(
        readFileSync(join(APP_ROOT, "third_party", "effective-html", "skills", "design-artifact", "SKILL.md"), "utf8"),
        /\n> \*\*In pi-phone:\*\*[^\n]*Before calling a UI or artifact done, go through the `unslop` skill's `references\/signs\.md`[^\n]*and fix what it finds, then follow the `ui-verify` skill[^\n]*\n/,
    );
});
