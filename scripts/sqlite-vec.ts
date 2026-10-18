/**
 * native/android-arm64/vec0.so: sqlite-vec's own Android build, from its release, checked against the release's
 * checksum. qmd's vector search loads it into node:sqlite on the phone (`QMD_SQLITE_VEC_PATH`, `para-env.ts`); the
 * sqlite-vec npm package has no Android build. Run again to update it, with a new VERSION and TARBALL_SHA256.
 *
 *   node scripts/sqlite-vec.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VERSION = "0.1.9";
const TARBALL = `sqlite-vec-${VERSION}-loadable-android-aarch64.tar.gz`;
/** From the release's checksums.txt. */
const TARBALL_SHA256 = "76f60d4d2d89d2e5070ef8f1868c52b140a10200dbe98b0c2ca7a4d02d483eaa";
const URL = `https://github.com/asg017/sqlite-vec/releases/download/v${VERSION}/${TARBALL}`;
const TARGET = resolve(import.meta.dirname, "..", "native", "android-arm64", "vec0.so");

const response = await fetch(URL);

if (!response.ok) {
    throw new Error(`${URL} answered ${response.status}`);
}

const tarball = Buffer.from(await response.arrayBuffer());
const sha256 = createHash("sha256").update(tarball).digest("hex");

if (sha256 !== TARBALL_SHA256) {
    throw new Error(`${TARBALL} has sha256 ${sha256}, not the release's ${TARBALL_SHA256}`);
}

const work = mkdtempSync(join(tmpdir(), "sqlite-vec-"));

try {
    writeFileSync(join(work, TARBALL), tarball);
    execFileSync("tar", ["-xzf", join(work, TARBALL), "-C", work]);
    mkdirSync(resolve(TARGET, ".."), { recursive: true });
    writeFileSync(TARGET, readFileSync(join(work, "vec0.so")));
    console.log(`${TARGET}: sqlite-vec ${VERSION}, sha256 ${createHash("sha256").update(readFileSync(TARGET)).digest("hex")}`);
} finally {
    rmSync(work, { recursive: true, force: true });
}
