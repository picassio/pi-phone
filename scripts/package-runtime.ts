/**
 * Builds android/app/src/main/assets/runtime.bin: the server, extracted to files/runtime on the phone (DESIGN.md
 * sections 2 and 5). Its version is the commit (scripts/versions.ts).
 *
 *   npm ci --omit=dev --ignore-scripts --os=android --cpu=arm64
 *   node scripts/package-runtime.ts
 *
 * Needs a clean checkout (the version is the commit) and GNU `tar`. Hard links are stored as copies (Android forbids
 * hard links in app data); `node_modules/.bin` folders are left out (nothing runs them, and their links can dangle), and so
 * are pi-env's Windows daemons (DESIGN.md: machines are Linux, macOS, or Termux until a Windows one is wanted).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ASSETS = join(ROOT, "android/app/src/main/assets");
/** What the server reads at runtime, relative to the repository. */
const CONTENTS = ["package.json", "DESIGN.md", "AGENTS.md", "src", "web", "node_modules"];

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

const dirty = git("status", "--porcelain", "--", ...CONTENTS.filter((each) => each !== "node_modules"));

if (dirty !== "") {
    throw new Error(`Uncommitted changes in the runtime; commit them first:\n${dirty}`);
}

for (const each of CONTENTS) {
    if (!existsSync(join(ROOT, each))) {
        throw new Error(`Missing ${each}; run npm ci first`);
    }
}

const work = mkdtempSync(join(tmpdir(), "pi-phone-runtime-"));
const stage = join(work, "runtime");

try {
    mkdirSync(stage);

    for (const each of CONTENTS) {
        cpSync(join(ROOT, each), join(stage, each), {
            recursive: true,
            verbatimSymlinks: true,
            filter: (source) => basename(source) !== ".bin" && !/pi-env-windows-/.test(basename(source)),
        });
    }

    mkdirSync(ASSETS, { recursive: true });
    execFileSync("tar", ["--hard-dereference", "-czf", join(ASSETS, "runtime.bin"), "-C", work, "runtime"]);
    console.log(`runtime.bin: ${git("rev-parse", "HEAD")}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
