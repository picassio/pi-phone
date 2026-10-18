/**
 * native/android-arm64/officecli/: OfficeCLI for Android arm64, the fork's NativeAOT release (picassio/OfficeCLI,
 * `.github/workflows/android.yml`), checked against its sha256 and unpacked here: `officecli` (one binary) and its
 * licenses. Not in git (52 MB); CI runs this before packaging the runtime, which refuses without it. pi-phone runs it
 * through `src/server/officecli.ts`. Its skills are in `third_party/officecli/` (see its README to update both).
 *
 *   node scripts/officecli.ts
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const TAG = "android-v1.0.157";
const ASSET = "officecli-android-arm64.tar.gz";
/** The release's own `.sha256`, as the fork's workflow wrote it. */
const ASSET_SHA256 = "c51163af08481e0240308d438921e8f367e5017261ad07407fb93b8b50367160";
const URL = `https://github.com/picassio/OfficeCLI/releases/download/${TAG}/${ASSET}`;
export const TARGET = resolve(import.meta.dirname, "..", "native", "android-arm64", "officecli");

if (import.meta.main) {
    const response = await fetch(URL);

    if (!response.ok) {
        throw new Error(`${URL} answered ${response.status}`);
    }

    const tarball = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(tarball).digest("hex");

    if (sha256 !== ASSET_SHA256) {
        throw new Error(`${ASSET} has sha256 ${sha256}, not the release's ${ASSET_SHA256}`);
    }

    const work = mkdtempSync(join(tmpdir(), "officecli-"));

    try {
        writeFileSync(join(work, ASSET), tarball);
        execFileSync("tar", ["-xzf", join(work, ASSET), "-C", work]);

        if (!existsSync(join(work, "officecli", "officecli"))) {
            throw new Error(`${ASSET} has no officecli/officecli`);
        }

        rmSync(TARGET, { recursive: true, force: true });
        mkdirSync(resolve(TARGET, ".."), { recursive: true });
        execFileSync("cp", ["-R", join(work, "officecli"), TARGET]);
        chmodSync(join(TARGET, "officecli"), 0o755);
        console.log(`officecli ${TAG}: ${TARGET}`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
