/**
 * What the upstreams did since pi-phone last took from them (HANDOVER.md, "Taking upstream changes"):
 *
 * - the pi packages (`@earendil-works/*`, pinned together): the version here and the newest on npm. With `--bump`,
 *   every one is pinned to its newest and installed (`npm install --ignore-scripts`); then run `npm run check` and
 *   `npm test`, and read the packages' changelogs for what the fork must change.
 * - pi-pocket and pi-termux-mobile, at the commits `UPSTREAM.md` names: their commits since, through GitHub's compare
 *   API (`gh`), each with the files it touched that this fork still has. Those are the ones to port by hand; when done,
 *   move the commit in `UPSTREAM.md`.
 *
 * Usage: node scripts/upstream.ts [--bump]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const bump = process.argv.includes("--bump");

type Manifest = { dependencies: Record<string, string>; devDependencies?: Record<string, string> };

const run = (command: string, args: string[]) => execFileSync(command, args, { cwd: ROOT, encoding: "utf8" }).trim();

// The pi packages.
const manifestPath = join(ROOT, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
const pi = Object.keys(manifest.dependencies).filter((name) => name.startsWith("@earendil-works/"));
let behind = 0;

console.log("pi packages:");

for (const name of pi) {
    const here = manifest.dependencies[name]!;
    const newest = run("npm", ["view", name, "version"]);

    console.log(`  ${name} ${here}${newest === here ? "" : ` -> ${newest}`}`);

    if (newest !== here) {
        behind++;
        manifest.dependencies[name] = newest;
    }
}

if (bump && behind > 0) {
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 4)}\n`);
    console.log("  pinned to the newest; installing");
    execFileSync("npm", ["install", "--ignore-scripts"], { cwd: ROOT, stdio: "inherit" });
    console.log("  now: npm run check && npm test");
}

// The forks, from UPSTREAM.md: "- name: https://github.com/<owner>/<repo> at `<sha>`".
const upstream = readFileSync(join(ROOT, "UPSTREAM.md"), "utf8");

for (const match of upstream.matchAll(/^- ([\w-]+): https:\/\/github\.com\/([\w.-]+\/[\w.-]+) at `([0-9a-f]{40})`/gm)) {
    const [, name, repo, sha] = match;
    const compare = JSON.parse(run("gh", ["api", `repos/${repo}/compare/${sha}...HEAD`])) as {
        ahead_by: number;
        commits: { sha: string; commit: { message: string } }[];
    };

    console.log(`\n${name} (${repo}): ${compare.ahead_by} commit${compare.ahead_by === 1 ? "" : "s"} since ${sha!.slice(0, 7)}`);

    for (const commit of compare.commits) {
        const files = (
            JSON.parse(run("gh", ["api", `repos/${repo}/commits/${commit.sha}`])) as { files: { filename: string }[] }
        ).files
            .map((file) => file.filename)
            .filter((file) => existsSync(join(ROOT, file)));

        console.log(`  ${commit.sha.slice(0, 7)} ${commit.commit.message.split("\n")[0]}`);

        for (const file of files) {
            console.log(`      ${file}`);
        }
    }
}
