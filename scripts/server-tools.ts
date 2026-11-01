/**
 * native/linux-x64/ (or linux-arm64/): the tools the server edition's image carries (PP-20), the same pinned releases
 * the app installs on machines (`src/server/machine-tools.ts`), each checked against its sha256: OfficeCLI, ripgrep, fd,
 * Chrome headless shell (for Pi's browser and `screenshot`), ffmpeg with ffprobe (Pi's media tool, PP-296), and TLC
 * (Temurin's JRE and tla2tools.jar, for the statechart skill, PP-316). Not in git; the Dockerfile runs this, and CI's
 * tests fetch ffmpeg and TLC alone (a tool's id after the target: only those).
 *
 *   node scripts/server-tools.ts [linux-x64 | linux-arm64] [tool id...]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { CHROME_TOOL, FFMPEG_TOOL, TLC_TOOL, TOOLS, type ToolSpec } from "../src/server/machine-tools.ts";

const target = process.argv[2] ?? "linux-x64";

if (target !== "linux-x64" && target !== "linux-arm64") {
    throw new Error(`Give linux-x64 or linux-arm64, not ${target}.`);
}

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "native", target);
const only = process.argv.slice(3);
const all: ToolSpec[] = [...TOOLS.filter((tool) => ["officecli", "rg", "fd"].includes(tool.id)), CHROME_TOOL, FFMPEG_TOOL, TLC_TOOL];

/** A download's bytes, checked against its pinned sha256. */
async function fetched(url: string, pinned: string): Promise<Buffer> {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`${url} answered ${response.status}`);
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 !== pinned) {
        throw new Error(`${basename(url)} has sha256 ${sha256}, not the pinned ${pinned}`);
    }

    return bytes;
}
const wanted = only.length === 0 ? all : all.filter((tool) => only.includes(tool.id));

if (only.length > 0 && wanted.length !== only.length) {
    throw new Error(`No such tools here: ${only.filter((id) => !all.some((tool) => tool.id === id)).join(", ")}. Tools: ${all.map((tool) => tool.id).join(", ")}.`);
}

for (const tool of wanted) {
    const asset = tool.assets[target];

    if (asset === undefined) {
        throw new Error(`${tool.name} has no ${target} build.`);
    }

    const bytes = await fetched(asset.url, asset.sha256);
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
                execFileSync("tar", ["-xf", file, "-C", work]);
            }

            // A whole folder, the archive's top one (Chrome: its libraries and resources beside it; the JRE: bin/, lib/),
            // links as they are, or the one binary in it, and the tool's other programs from the same download (ffprobe
            // beside ffmpeg).
            if (tool.whole === true) {
                cpSync(join(work, asset.member.split("/")[0]!), dir, { recursive: true, verbatimSymlinks: true });
            } else {
                cpSync(join(work, asset.member), join(dir, tool.command));

                for (const more of asset.more ?? []) {
                    if (more.from !== undefined) {
                        throw new Error(`${tool.name}'s ${more.command} is a download of its own, which this does not fetch.`);
                    }

                    cpSync(join(work, more.member), join(dir, more.command));
                    chmodSync(join(dir, more.command), 0o755);
                }
            }
        }

        // Files of every platform beside it (TLC's tla2tools.jar).
        for (const file of tool.files ?? []) {
            writeFileSync(join(dir, file.name), await fetched(file.url, file.sha256));
        }

        chmodSync(join(dir, tool.whole === true && asset.member !== undefined ? asset.member.split("/").slice(1).join("/") : basename(asset.member ?? tool.command)), 0o755);
        console.log(`${tool.name} ${tool.version} → ${dir}`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}
