/**
 * The versions that say what an update needs (DESIGN.md section 5):
 *
 * - shell: the tracked files under android/. A new shell needs a new APK.
 * - rootfs: scripts/package-rootfs.ts, which holds the package list. A new rootfs is downloaded and extracted.
 * - runtime: the commit. A new runtime is downloaded and extracted.
 *
 *   node scripts/versions.ts shell|rootfs|runtime      print one
 *   node scripts/versions.ts assets                    write android/app/src/main/assets/{shell,rootfs,runtime}-version
 *   node scripts/versions.ts manifest <dir> <tag> <versionCode>
 *                                                      write <dir>/manifest.json for the release <tag>, from the
 *                                                      pi-phone.apk, rootfs.bin, and runtime.bin in <dir>
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const ASSETS = join(ROOT, "android/app/src/main/assets");
export const RELEASES = "https://github.com/picassio/pi-phone/releases/download";

function git(...args: string[]): string {
    return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function sha256(data: string | Buffer): string {
    return createHash("sha256").update(data).digest("hex");
}

export function shellVersion(): string {
    // Object ids of the committed files: a change to any of them, and only that, makes a new shell.
    const dirty = git("status", "--porcelain", "--", "android");

    if (dirty !== "") {
        throw new Error(`Uncommitted changes under android/; commit them first:\n${dirty}`);
    }

    return sha256(git("ls-files", "-s", "--", "android")).slice(0, 16);
}

export function rootfsVersion(): string {
    return sha256(readFileSync(join(ROOT, "scripts/package-rootfs.ts"))).slice(0, 16);
}

export function runtimeVersion(): string {
    return git("rev-parse", "HEAD");
}

function asset(dir: string, tag: string, name: string) {
    const path = join(dir, name);

    return {
        name,
        url: `${RELEASES}/${tag}/${name}`,
        size: statSync(path).size,
        sha256: sha256(readFileSync(path)),
    };
}

const [command, ...args] = process.argv.slice(2);

if (command === "shell") {
    console.log(shellVersion());
} else if (command === "rootfs") {
    console.log(rootfsVersion());
} else if (command === "runtime") {
    console.log(runtimeVersion());
} else if (command === "assets") {
    writeFileSync(join(ASSETS, "shell-version"), `${shellVersion()}\n`);
    writeFileSync(join(ASSETS, "rootfs-version"), `${rootfsVersion()}\n`);
    writeFileSync(join(ASSETS, "runtime-version"), `${runtimeVersion()}\n`);
} else if (command === "manifest") {
    const [dir, tag, versionCode] = args;

    if (dir === undefined || tag === undefined || versionCode === undefined || !/^\d+$/.test(versionCode)) {
        throw new Error("usage: versions.ts manifest <dir> <tag> <versionCode>");
    }

    const manifest = {
        versionCode: Number(versionCode),
        shellVersion: shellVersion(),
        rootfsVersion: rootfsVersion(),
        runtimeVersion: runtimeVersion(),
        apk: asset(dir, tag, "pi-phone.apk"),
        rootfs: asset(dir, tag, "rootfs.bin"),
        runtime: asset(dir, tag, "runtime.bin"),
    };

    writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(JSON.stringify(manifest, null, 2));
} else {
    throw new Error("usage: versions.ts shell|rootfs|runtime|assets|manifest");
}
