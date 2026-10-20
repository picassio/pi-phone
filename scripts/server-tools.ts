/**
 * native/linux-x64/ (or linux-arm64/): the tools the server edition's image carries (PP-20), the same pinned releases
 * the app installs on machines (`src/server/machine-tools.ts`), each checked against its sha256: OfficeCLI, ripgrep, fd,
 * and Chrome headless shell (for Pi's browser and `screenshot`). Not in git; the Dockerfile runs this.
 *
 *   node scripts/server-tools.ts [linux-x64 | linux-arm64]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { CHROME_TOOL, TOOLS, type ToolSpec } from "../src/server/machine-tools.ts";

const target = process.argv[2] ?? "linux-x64";

if (target !== "linux-x64" && target !== "linux-arm64") {
    throw new Error(`Give linux-x64 or linux-arm64, not ${target}.`);
}

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "native", target);
const wanted: ToolSpec[] = [...TOOLS.filter((tool) => ["officecli", "rg", "fd"].includes(tool.id)), CHROME_TOOL];

for (const tool of wanted) {
    const asset = tool.assets[target];

    if (asset === undefined) {
        throw new Error(`${tool.name} has no ${target} build.`);
    }

    const response = await fetch(asset.url);

    if (!response.ok) {
        throw new Error(`${asset.url} answered ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 !== asset.sha256) {
        throw new Error(`${basename(asset.url)} has sha256 ${sha256}, not the pinned ${asset.sha256}`);
    }

    const dir = join(OUT, tool.id);
    const work = mkdtempSync(join(tmpdir(), `server-tools-${tool.id}-`));

    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });

    try {
        const file = join(work, basename(asset.url));

        writeFileSync(file, bytes);

        if (asset.member === undefined) {
            // One binary, as released.
            cpSync(file, join(dir, tool.command));
        } else {
            if (file.endsWith(".zip")) {
                execFileSync("unzip", ["-q", file, "-d", work]);
            } else {
                execFileSync("tar", ["-xzf", file, "-C", work]);
            }

            // A whole folder (Chrome: its libraries and resources beside it), or the one binary in it.
            if (tool.whole === true) {
                cpSync(join(work, dirname(asset.member)), dir, { recursive: true });
            } else {
                cpSync(join(work, asset.member), join(dir, tool.command));
            }
        }

        chmodSync(join(dir, basename(asset.member ?? tool.command)), 0o755);
        console.log(`${tool.name} ${tool.version} → ${dir}`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
