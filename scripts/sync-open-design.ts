/**
 * third_party/open-design/: OpenDesign's (nexu-io/open-design, Apache-2.0) design systems and the MIT skills pi-phone
 * keeps (PP-241, PP-242), from a clone checked out at COMMIT. See third_party/open-design/README.md.
 *
 * - design-systems/<id>/: only DESIGN.md, tokens.css and manifest.json of each system (the previews, translations and
 *   derived files are left out), and index.json: each system's id, name, category (its manifest's) and a one-line
 *   summary (the first line under DESIGN.md's title that is not its category or surface), which the design-system skill
 *   lists and searches (`src/server/design-systems.ts`).
 * - skills/<name>/: each kept skill's folder, whole, with its own LICENSE, and pi-phone's note after its front matter.
 *   A deck template's description is its template.json's name, tagline and occasions instead of upstream's example
 *   subject, so Pi picks it for the look and not for that subject.
 *
 *   git clone https://github.com/nexu-io/open-design /tmp/open-design
 *   git -C /tmp/open-design checkout <COMMIT>
 *   node scripts/sync-open-design.ts /tmp/open-design
 *
 * To move to a newer commit: change COMMIT, run it, check each kept skill's LICENSE still ships, and update the README.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export const COMMIT = "fa19ff40e34dd50a9b01888b0339a1b2e1e68cc7";
export const TARGET = resolve(import.meta.dirname, "..", "third_party", "open-design");
/** The files of a design system pi-phone ships. */
export const SYSTEM_FILES = ["DESIGN.md", "tokens.css", "manifest.json"] as const;

type Kept = { from: string; kind: "deck" | "motion" };

/** The skills kept (PP-242): each ships its own MIT LICENSE, needs no keys and no OpenDesign daemon. */
export const SKILLS: readonly Kept[] = [
    { from: "design-templates/html-ppt-zhangzara-signal", kind: "deck" },
    { from: "design-templates/html-ppt-zhangzara-blue-professional", kind: "deck" },
    { from: "design-templates/html-ppt-zhangzara-monochrome", kind: "deck" },
    { from: "design-templates/html-ppt-zhangzara-editorial-tri-tone", kind: "deck" },
    { from: "design-templates/html-ppt-zhangzara-neo-grid-bold", kind: "deck" },
    { from: "skills/gsap-core", kind: "motion" },
    { from: "skills/gsap-timeline", kind: "motion" },
    { from: "skills/gsap-scrolltrigger", kind: "motion" },
    { from: "skills/gsap-plugins", kind: "motion" },
    { from: "skills/gsap-performance", kind: "motion" },
];

export const GSAP_VERSION = "3.15.0";

const NOTE = {
    deck: [
        "<!-- pi-phone: added (third_party/open-design/README.md) -->",
        "> In pi-phone: start from this skill's `example.html` (in this skill's folder) and publish the deck with the",
        "> `artifact` tool (type html), not the `<artifact>` tags below, so it opens on the phone; write a file only when",
        "> asked. Keep it self-contained for the artifact's sandbox, and check it with the `screenshot` tool at 390 and",
        "> 1280 px. When a design system is chosen (the `design-system` skill), keep this template's layout and use the",
        "> system's colours and fonts only if the person asks for their brand.",
    ],
    motion: [
        "<!-- pi-phone: added (third_party/open-design/README.md) -->",
        `> In pi-phone: in a self-contained HTML artifact, load GSAP from a CDN at a pinned version`,
        `> (https://cdn.jsdelivr.net/npm/gsap@${GSAP_VERSION}/dist/gsap.min.js, plugins from the same \`dist/\` folder,`,
        "> as `<Plugin>.min.js`), publish with the `artifact` tool, honour `prefers-reduced-motion`, and check the page with",
        "> the `screenshot` tool.",
    ],
};

/** A one-line summary of a system: the first line under DESIGN.md's title that is not its category or surface. */
export function summaryOf(id: string, design: string): string {
    const lines = design.split("\n");
    const title = lines.findIndex((line) => line.startsWith("# "));

    if (title === -1) {
        throw new Error(`design-systems/${id}/DESIGN.md has no "# " title`);
    }

    for (const line of lines.slice(title + 1)) {
        if (line.startsWith("#")) {
            break;
        }

        const text = line.replace(/^>\s?/, "").trim();

        if (text !== "" && !/^(Category|Surface):/i.test(text)) {
            return text;
        }
    }

    throw new Error(`design-systems/${id}/DESIGN.md has no summary line under its title`);
}

/** `markdown` with its front matter's `description` replaced by `description` (as one double-quoted line). */
export function withDescription(markdown: string, description: string): string {
    const lines = markdown.split("\n");
    const end = lines.indexOf("---", 1);

    if (lines[0] !== "---" || end === -1) {
        throw new Error("SKILL.md has no front matter");
    }

    const at = lines.findIndex((line, index) => index < end && line.startsWith("description:"));

    if (at === -1) {
        throw new Error("SKILL.md's front matter has no description");
    }

    let next = at + 1;

    while (next < end && /^\s/.test(lines[next]!)) {
        next += 1;
    }

    return [...lines.slice(0, at), `description: ${JSON.stringify(description)}`, ...lines.slice(next)].join("\n");
}

/** `markdown` with `note` after its front matter. */
export function withNote(markdown: string, note: readonly string[]): string {
    const lines = markdown.split("\n");
    const end = lines.indexOf("---", 1);

    return [...lines.slice(0, end + 1), "", ...note, ...lines.slice(end + 1)].join("\n");
}

/** A deck template's description, from its template.json. */
export function deckDescription(template: { name: string; tagline: string; occasion: string[] }): string {
    return `HTML slide deck template "${template.name}" (OpenDesign, MIT): ${template.tagline} Best for ${template.occasion.slice(0, 4).join(", ")}. Use when the person asks for an HTML deck or slides with this look.`;
}

function sync(clone: string): void {
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    if (head !== COMMIT) {
        throw new Error(`${clone} is at ${head}, not ${COMMIT}: check out ${COMMIT} first.`);
    }

    const dirty = execFileSync("git", ["-C", clone, "status", "--porcelain", "--", "design-systems", "skills", "design-templates", "LICENSE"], { encoding: "utf8" }).trim();

    if (dirty !== "") {
        throw new Error(`${clone} has changes:\n${dirty}`);
    }

    rmSync(join(TARGET, "design-systems"), { recursive: true, force: true });
    rmSync(join(TARGET, "skills"), { recursive: true, force: true });
    cpSync(join(clone, "LICENSE"), join(TARGET, "LICENSE"));

    const index: { id: string; name: string; category: string; summary: string }[] = [];

    for (const id of readdirSync(join(clone, "design-systems")).sort()) {
        const from = join(clone, "design-systems", id);

        if (!existsSync(join(from, "manifest.json"))) {
            continue;
        }

        mkdirSync(join(TARGET, "design-systems", id), { recursive: true });

        for (const file of SYSTEM_FILES) {
            cpSync(join(from, file), join(TARGET, "design-systems", id, file));
        }

        const manifest = JSON.parse(readFileSync(join(from, "manifest.json"), "utf8")) as { id: string; name: string; category: string };

        if (manifest.id !== id) {
            throw new Error(`design-systems/${id}/manifest.json names id ${manifest.id}`);
        }

        index.push({ id, name: manifest.name, category: manifest.category, summary: summaryOf(id, readFileSync(join(from, "DESIGN.md"), "utf8")) });
    }

    writeFileSync(join(TARGET, "design-systems", "index.json"), `${JSON.stringify(index, null, 1)}\n`);

    for (const skill of SKILLS) {
        const from = join(clone, skill.from);
        const to = join(TARGET, "skills", basename(skill.from));

        if (!existsSync(join(from, "LICENSE"))) {
            throw new Error(`${skill.from} ships no LICENSE: it may not be kept.`);
        }

        cpSync(from, to, { recursive: true });

        let markdown = readFileSync(join(to, "SKILL.md"), "utf8");

        if (skill.kind === "deck") {
            markdown = withDescription(markdown, deckDescription(JSON.parse(readFileSync(join(to, "template.json"), "utf8")) as { name: string; tagline: string; occasion: string[] }));
        }

        writeFileSync(join(to, "SKILL.md"), withNote(markdown, NOTE[skill.kind]));
    }

    console.log(`${index.length} design systems and ${SKILLS.length} skills from ${COMMIT}`);
}

if (import.meta.main) {
    const clone = process.argv[2];

    if (clone === undefined) {
        throw new Error("Name the OpenDesign clone: node scripts/sync-open-design.ts <folder>");
    }

    sync(resolve(clone));
}
