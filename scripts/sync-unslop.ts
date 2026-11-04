/**
 * third_party/heydamir-unslop/: heydamir's unslop skill (heydamir/unslop `skills/unslop/`, CC BY 4.0, Damir
 * Sokolovsky), from a clone checked out at its pinned commit (PP-327). See third_party/heydamir-unslop/README.md.
 *
 * - skills/unslop/: the folder whole (SKILL.md, agents/, references/ with refs/, scripts/), with pi-phone's note after
 *   SKILL.md's front matter. Nothing else is changed; the credit lines (SKILL.md's, each reference's footer) stay.
 * - LICENSE: upstream's (the CC BY 4.0 text).
 *
 *   git clone https://github.com/heydamir/unslop /tmp/unslop && git -C /tmp/unslop checkout <COMMIT>
 *   node scripts/sync-unslop.ts /tmp/unslop
 *
 * To move to a newer commit: change COMMIT, run it, read the new SKILL.md against the note, and update the README.
 */
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const COMMIT = "1d13095e4bef6ad6c74f1dd828d84c4ba309a4dc";
export const TARGET = resolve(import.meta.dirname, "..", "third_party", "heydamir-unslop");
export const SKILL = join(TARGET, "skills", "unslop");

export const NOTE = [
    "<!-- pi-phone: added (third_party/heydamir-unslop/README.md) -->",
    "> In pi-phone:",
    "> - Look with the `screenshot` tool (url, path or artifact; 390 and 1280 px), and trust its layout check. For a machine's dev server use Pi's browser there (`browser_open` with machine, then `browser_screenshot`). Do not run `scripts/snapshot.mjs` on the phone: with only a link, screenshot it and rebuild it as one static HTML file (the skill's screenshot path), or run snapshot.mjs in a session on a machine whose project has Playwright.",
    "> - Ask the direction question with `interview` (with your recommendation) and wait. Show mockups as an `artifact` first.",
    "> - Icons: the project's own set; in pi-phone itself `ICONS` in `web/ui.js`. Never emoji. In pi-phone itself the tokyo-night palette is the brand: polish mode only. A chosen design system (the `design_system` section) is the brand too.",
    "> - Images: `image_generate` instead of fal/Replicate/MCP (aspects 1:1, 16:9, 9:16, 4:3, 3:4; no background removal: ask for the page colour and mask in CSS). Show the prompt and model and ask before it, as the skill says; save into the project's assets.",
    "> - Story video: only on a machine (`scripts/story.mjs` needs Playwright and ffmpeg; the ffmpeg machine tool is in `~/.pi/mobile/tools/bin`, add it to PATH). Never on the phone. Check the mp4 with the `media` tool (frames, sheet: true). Keep the \"unslop by @heydamir\" credit.",
    "> - Step 6 (Check): follow the `ui-verify` skill (layout check numbers, redlines against a spec, pixel compare, before/after counts in the report).",
];

/** `markdown` with `note` after its front matter, which stays as it is. */
export function withPiPhone(markdown: string, note: readonly string[]): string {
    const lines = markdown.split("\n");
    const end = lines.indexOf("---", 1);

    if (lines[0] !== "---" || end === -1) {
        throw new Error("SKILL.md has no front matter");
    }

    return [...lines.slice(0, end + 1), "", ...note, ...lines.slice(end + 1)].join("\n");
}

function sync(clone: string): void {
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    if (head !== COMMIT) {
        throw new Error(`${clone} is at ${head}, not ${COMMIT}: check out ${COMMIT} first.`);
    }

    const dirty = execFileSync("git", ["-C", clone, "status", "--porcelain", "--", "skills/unslop", "LICENSE"], { encoding: "utf8" }).trim();

    if (dirty !== "") {
        throw new Error(`${clone} has changes:\n${dirty}`);
    }

    const from = join(clone, "skills", "unslop");

    rmSync(join(TARGET, "skills"), { recursive: true, force: true });
    mkdirSync(SKILL, { recursive: true });
    cpSync(join(clone, "LICENSE"), join(TARGET, "LICENSE"));
    cpSync(from, SKILL, { recursive: true });
    writeFileSync(join(SKILL, "SKILL.md"), withPiPhone(readFileSync(join(from, "SKILL.md"), "utf8"), NOTE));

    console.log(`unslop at ${COMMIT} (${readdirSync(SKILL, { recursive: true }).length} entries)`);
}

if (import.meta.main) {
    const [clone] = process.argv.slice(2);

    if (clone === undefined) {
        throw new Error("Name the clone: node scripts/sync-unslop.ts <heydamir/unslop>");
    }

    sync(resolve(clone));
}
