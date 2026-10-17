/**
 * Builds android/app/src/main/assets/runtime.bin (the server, extracted to files/runtime on the phone) and
 * runtime-version (the commit and a hash of the Termux package manifest; a change makes the installer extract both
 * assets again). DESIGN.md sections 2 and 5.
 *
 *   node scripts/package-rootfs.ts
 *   npm ci --omit=dev --ignore-scripts --os=android --cpu=arm64
 *   node scripts/package-runtime.ts
 *
 * Needs a clean checkout (the version is the commit) and GNU `tar`. Hard links are stored as copies (Android forbids
 * hard links in app data); `node_modules/.bin` folders are left out (nothing runs them, and their links can dangle).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ASSETS = join(ROOT, "android/app/src/main/assets");
/** What the server reads at runtime, relative to the repository. */
const CONTENTS = ["package.json", "src", "web", "types", "docs", "node_modules"];

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

const packagesFile = join(ASSETS, "termux-packages.json");

if (!existsSync(packagesFile)) {
    throw new Error(`Missing ${packagesFile}; run scripts/package-rootfs.ts first`);
}

const packages = createHash("sha256").update(readFileSync(packagesFile)).digest("hex").slice(0, 16);
const version = `${git("rev-parse", "HEAD")}-${packages}`;
const work = mkdtempSync(join(tmpdir(), "pi-phone-runtime-"));
const stage = join(work, "runtime");

try {
    mkdirSync(stage);

    for (const each of CONTENTS) {
        cpSync(join(ROOT, each), join(stage, each), {
            recursive: true,
            verbatimSymlinks: true,
            filter: (source) => basename(source) !== ".bin",
        });
    }

    mkdirSync(ASSETS, { recursive: true });
    execFileSync("tar", ["--hard-dereference", "-czf", join(ASSETS, "runtime.bin"), "-C", work, "runtime"]);
    writeFileSync(join(ASSETS, "runtime-version"), `${version}\n`);
    console.log(`runtime.bin: ${version}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
