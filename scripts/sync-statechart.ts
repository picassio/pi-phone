/**
 * third_party/pstack-statechart/: pstack's /statechart skill (cursor/plugins `pstack/skills/statechart/`, MIT, Lauren
 * Tan) and statechart-art's four boba models as its worked examples (kevintngo/statechart-art `business/`, MIT, Kevin
 * T. Ngo), each from a clone checked out at its pinned commit (PP-316). See third_party/pstack-statechart/README.md.
 *
 * - skills/statechart/: SKILL.md, references/render.md and scripts/ without test/ (3.6 MB of tests and a Java oracle),
 *   with pi-phone's note after the front matter, and the front matter's `disable-model-invocation` left out, so the
 *   Formal checks extension lists it for Pi to pick.
 * - skills/statechart/examples/: order, day, counter and bug, each its Spec.tla and .cfg, view.mjs and the chart/ that
 *   /statechart wrote (chart.mmd, report.md), with statechart-art's LICENSE. The art (layout.mmd, the plate scripts) is
 *   left out.
 *
 *   git clone https://github.com/cursor/plugins /tmp/plugins && git -C /tmp/plugins checkout <PSTACK_COMMIT>
 *   git clone https://github.com/kevintngo/statechart-art /tmp/statechart-art && git -C /tmp/statechart-art checkout <ART_COMMIT>
 *   node scripts/sync-statechart.ts /tmp/plugins /tmp/statechart-art
 *
 * To move to newer commits: change them, run it, read the new SKILL.md against the note, run the smoke test on a machine
 * with Java (test/statechart.test.ts), and update the README.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const PSTACK_COMMIT = "ae5650febf4320793844c12c4adaa937f417f8da";
export const ART_COMMIT = "09c959c79e25767cc34a5beddf3df234b085636e";
export const TARGET = resolve(import.meta.dirname, "..", "third_party", "pstack-statechart");
export const SKILL = join(TARGET, "skills", "statechart");

/** statechart-art's boba models, by folder, with their spec's name: flat, parent states, regions, a rule that breaks. */
export const EXAMPLES = [
    { folder: "order", spec: "Order", shows: "a flat chart with a branch and a loop" },
    { folder: "day", spec: "Day", shows: "parent states" },
    { folder: "counter", spec: "Counter", shows: "two parallel regions" },
    { folder: "bug", spec: "Bug", shows: "a rule that breaks, and the shortest path to it" },
] as const;

export const NOTE = [
    "<!-- pi-phone: added (third_party/pstack-statechart/README.md) -->",
    "> In pi-phone:",
    ">",
    "> - Run the command only where TLC is: in bash in a session on a machine with pi-phone's TLC tool (Settings ›",
    ">   Machines › the machine › Install tools), or in the server edition, both of which set `TLA2TOOLS` (tla2tools.jar)",
    ">   and `JAVA`. Check `test -n \"$TLA2TOOLS\"` first. Never install Java or TLC yourself and never use mise: where",
    ">   `TLA2TOOLS` is unset, say so, and offer to run it in a session on a machine that has the tool (session_start with",
    ">   the folder `machine:<id>:<path>`), or ask the owner to install the tool on one.",
    "> - Run it as `sh <skill dir>/scripts/statechart SPEC.tla --view view.mjs --out <new folder>`. It needs Node 22.18",
    ">   or later (or Bun, or Deno 2) where it runs; when it says so, tell the person instead of installing one.",
    "> - Its exit code is the verdict: 0, every rule holds; 1, a rule breaks: report it as a broken rule, with its rule,",
    ">   the reader's sentence for it and the numbered path from `report.md`, not as a failed run; 2, an error: show it.",
    ">   A bug counts only when this run shows it.",
    "> - Show `chart.mmd` as a ```mermaid block in your reply: the app draws it with pele, the bug path, the marks and",
    ">   the group colours in the theme's colours. `references/render.md` applies only when the person asks for an SVG file.",
    "> - On the phone there is no Java, so nothing is checked there. You may draw a chart by hand as a ```mermaid",
    ">   `stateDiagram-v2`, but say that it is unchecked (no TLC run stands behind it), put no `breaks`, `mayBreak` or",
    ">   `bugPath` class on it, and offer to check it on a machine with the TLC tool.",
    "> - Worked examples are in `examples/` beside this file: statechart-art's four boba models (order: a flat chart;",
    ">   day: parent states; counter: two regions; bug: a rule that breaks), each with the `chart/` this command wrote.",
];

/** `markdown` with its front matter's `disable-model-invocation` line left out and `note` after the front matter. */
export function withPiPhone(markdown: string, note: readonly string[]): string {
    const lines = markdown.split("\n");
    const end = lines.indexOf("---", 1);

    if (lines[0] !== "---" || end === -1) {
        throw new Error("SKILL.md has no front matter");
    }

    const front = lines.slice(0, end + 1).filter((line) => !line.startsWith("disable-model-invocation:"));

    return [...front, "", ...note, ...lines.slice(end + 1)].join("\n");
}

function clean(clone: string, commit: string, paths: readonly string[]): void {
    const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();

    if (head !== commit) {
        throw new Error(`${clone} is at ${head}, not ${commit}: check out ${commit} first.`);
    }

    const dirty = execFileSync("git", ["-C", clone, "status", "--porcelain", "--", ...paths], { encoding: "utf8" }).trim();

    if (dirty !== "") {
        throw new Error(`${clone} has changes:\n${dirty}`);
    }
}

function sync(plugins: string, art: string): void {
    clean(plugins, PSTACK_COMMIT, ["pstack/skills/statechart", "pstack/LICENSE"]);
    clean(art, ART_COMMIT, ["business", "LICENSE"]);

    const from = join(plugins, "pstack", "skills", "statechart");

    rmSync(join(TARGET, "skills"), { recursive: true, force: true });
    mkdirSync(SKILL, { recursive: true });
    cpSync(join(plugins, "pstack", "LICENSE"), join(TARGET, "LICENSE"));
    cpSync(join(from, "references"), join(SKILL, "references"), { recursive: true });
    cpSync(join(from, "scripts"), join(SKILL, "scripts"), { recursive: true, filter: (path) => path !== join(from, "scripts", "test") });
    writeFileSync(join(SKILL, "SKILL.md"), withPiPhone(readFileSync(join(from, "SKILL.md"), "utf8"), NOTE));

    const examples = join(SKILL, "examples");

    mkdirSync(examples, { recursive: true });
    cpSync(join(art, "LICENSE"), join(examples, "LICENSE"));

    for (const example of EXAMPLES) {
        const source = join(art, "business", example.folder);
        const to = join(examples, example.folder);

        for (const file of [`${example.spec}.tla`, `${example.spec}.cfg`, "view.mjs", "chart/chart.mmd", "chart/report.md"]) {
            if (!existsSync(join(source, file))) {
                throw new Error(`business/${example.folder}/${file} is not in statechart-art at ${ART_COMMIT}`);
            }

            mkdirSync(join(to, "chart"), { recursive: true });
            cpSync(join(source, file), join(to, file));
        }
    }

    const scripts = readdirSync(join(SKILL, "scripts"), { recursive: true }).length;

    console.log(`statechart at ${PSTACK_COMMIT} (${scripts} script entries) and ${EXAMPLES.length} examples at ${ART_COMMIT}`);
}

if (import.meta.main) {
    const [plugins, art] = process.argv.slice(2);

    if (plugins === undefined || art === undefined) {
        throw new Error("Name both clones: node scripts/sync-statechart.ts <cursor/plugins> <kevintngo/statechart-art>");
    }

    sync(resolve(plugins), resolve(art));
}
