/**
 * third_party/pstack/: the pstack skills the owner chose (cursor/plugins `pstack/skills/`, MIT, Lauren Tan), each a
 * slash command only (`disable-model-invocation: true`, so none is in the system prompt), adapted to pi-phone's tools
 * by `third_party/pstack/pi-phone.patch` (PP-550). See third_party/pstack/README.md.
 *
 * It copies each skill's SKILL.md from a clone at PSTACK_COMMIT (pstack's `unslop` as `unslop-writing`), then applies
 * the patch, which must apply cleanly: a newer upstream that it does not fit stops the sync, to be read and adapted
 * again by hand.
 *
 *   git clone https://github.com/cursor/plugins /tmp/plugins && git -C /tmp/plugins checkout <PSTACK_COMMIT>
 *   node scripts/sync-pstack.ts /tmp/plugins
 *
 * After adapting the skills by hand (edit their files in third_party/pstack/skills/, marking each change), write the
 * patch again from the same clone:
 *
 *   node scripts/sync-pstack.ts /tmp/plugins --write-patch
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PSTACK_COMMIT = "0b46ec399d55f2829e88822998f53b84944837d3";
export const TARGET = resolve(import.meta.dirname, "..", "third_party", "pstack");
export const SKILLS = join(TARGET, "skills");
export const PATCH = join(TARGET, "pi-phone.patch");

/** The skills, by their name in pi-phone, with pstack's folder where it differs. */
export const BUNDLED: readonly { readonly name: string; readonly upstream?: string }[] = [
    { name: "interrogate" },
    { name: "blast-radius" },
    { name: "ketchup" },
    // Narrated, rendered on a machine with HyperFrames, after the owner's card (PP-551).
    { name: "ketchup-video" },
    { name: "reflect" },
    { name: "correct" },
    { name: "why" },
    { name: "how" },
    { name: "bro" },
    { name: "in-your-own-words" },
    { name: "create-formal-verification-skill" },
    // heydamir's `unslop` (Design & video) is the UI skill of that name.
    { name: "unslop-writing", upstream: "unslop" },
    { name: "teach" },
];

/** The marks around each part pi-phone changed: a block of lines, or a run inside one line. */
export const MARK_OPEN = /<!-- pi-phone: (adapted|added)( \(third_party\/pstack\/README\.md\))? -->/g;
export const MARK_CLOSE = "<!-- /pi-phone -->";

/** `markdown` with its front matter's name set to `name`: pstack's unslop as unslop-writing. */
export function renamed(markdown: string, name: string): string {
    const lines = markdown.split("\n");
    const end = lines.indexOf("---", 1);
    const at = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith("name: "));

    if (lines[0] !== "---" || end === -1 || at === -1) {
        throw new Error("SKILL.md has no front matter with a name");
    }

    lines[at] = `name: ${name}`;

    return lines.join("\n");
}

function checkClone(plugins: string): void {
    const head = execFileSync("git", ["-C", plugins, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    if (head !== PSTACK_COMMIT) {
        throw new Error(`${plugins} is at ${head}, not ${PSTACK_COMMIT}: check out ${PSTACK_COMMIT} first.`);
    }

    const dirty = execFileSync("git", ["-C", plugins, "status", "--porcelain", "--", "pstack/skills", "pstack/LICENSE"], { encoding: "utf8" }).trim();

    if (dirty !== "") {
        throw new Error(`${plugins} has changes:\n${dirty}`);
    }
}

/** pstack's SKILL.md files, unchanged but for unslop's name, into `skills`. */
function copyUpstream(plugins: string, skills: string): void {
    for (const skill of BUNDLED) {
        const from = join(plugins, "pstack", "skills", skill.upstream ?? skill.name, "SKILL.md");

        if (!existsSync(from)) {
            throw new Error(`pstack/skills/${skill.upstream ?? skill.name}/SKILL.md is not in cursor/plugins at ${PSTACK_COMMIT}`);
        }

        const markdown = readFileSync(from, "utf8");

        mkdirSync(join(skills, skill.name), { recursive: true });
        writeFileSync(join(skills, skill.name, "SKILL.md"), skill.upstream === undefined ? markdown : renamed(markdown, skill.name));
    }
}

function sync(plugins: string): void {
    checkClone(plugins);
    rmSync(SKILLS, { recursive: true, force: true });
    copyUpstream(plugins, SKILLS);
    cpSync(join(plugins, "pstack", "LICENSE"), join(TARGET, "LICENSE"));

    // From the repository's top, with its paths under third_party/pstack/.
    const applied = spawnSync("git", ["apply", "-p1", "--directory=third_party/pstack", PATCH], { cwd: resolve(TARGET, "..", ".."), encoding: "utf8" });

    if (applied.status !== 0) {
        throw new Error(`pi-phone.patch does not apply to pstack at ${PSTACK_COMMIT}: adapt the skills by hand, then --write-patch.\n${applied.stderr}`);
    }

    console.log(`${BUNDLED.length} pstack skills at ${PSTACK_COMMIT}, adapted by pi-phone.patch`);
}

/** pi-phone.patch: the difference from pstack's files (unslop renamed) to the adapted ones in third_party/pstack/skills. */
function writePatch(plugins: string): void {
    checkClone(plugins);

    const work = mkdtempSync(join(tmpdir(), "sync-pstack-"));

    try {
        copyUpstream(plugins, join(work, "a", "skills"));
        cpSync(SKILLS, join(work, "b", "skills"), { recursive: true });

        const diff = spawnSync("git", ["diff", "--no-index", "--no-prefix", "a", "b"], { cwd: work, encoding: "utf8" });

        if (diff.status !== 0 && diff.status !== 1) {
            throw new Error(`git diff failed: ${diff.stderr}`);
        }

        // `--no-prefix` names a/skills/… and b/skills/…: `-p1` takes off a/ and b/.
        writeFileSync(PATCH, diff.stdout);
        console.log(`pi-phone.patch: ${diff.stdout.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length} lines added`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [plugins, flag] = process.argv.slice(2);

    if (plugins === undefined) {
        throw new Error("Name the clone: node scripts/sync-pstack.ts <cursor/plugins> [--write-patch]");
    }

    if (flag === "--write-patch") {
        writePatch(resolve(plugins));
    } else if (flag === undefined) {
        sync(resolve(plugins));
    } else {
        throw new Error(`Unknown option ${flag}: the only one is --write-patch`);
    }
}
