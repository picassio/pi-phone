// business-motion-film's draw-twice check (PP-413; the idea from OpenFilm's `look`, research PP-407): scripts/twice.sh
// snapshots a HyperFrames composition at the same times twice, each time in its own shuffled order, and names the times
// whose pictures differ. Here it runs against a stand-in `hyperframes` (its `info --json` and `snapshot --at … -o`)
// that draws with the server edition's ffmpeg, which the script also compares with: a composition whose picture
// depends only on t, one whose picture depends on how many frames were drawn before, and one that never changes.
// Checked by hand with the real HyperFrames 0.8.216 on tuanlh-devbox-01 (2026-11-06): its `check` passed the second.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import { localEngine } from "../src/server/media.ts";

const skill = join(APP_ROOT, "third_party", "motion-video-kit", "skills", "business-motion-film");
const script = join(skill, "scripts", "twice.sh");
const engine = localEngine();
const real = { skip: engine === undefined ? "no ffmpeg in native/ (node scripts/server-tools.ts linux-x64 ffmpeg)" : false } as const;
const work = mkdtempSync(join(tmpdir(), "twice-"));

after(() => rmSync(work, { recursive: true, force: true }));

// A stand-in for HyperFrames: `info` says the duration; `snapshot` writes one still per time, in the order given, named
// as HyperFrames names them (frame-NN-at-<t>s.png), a red box on black whose place FAKE_MODE decides, and logs the order.
const FAKE = `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  info) printf '{\\n  "name": "fake",\\n  "duration": %s,\\n  "tracks": 1\\n}\\n' "\${FAKE_DURATION:-4}" ;;
  snapshot)
    shift; at=""; out=""
    while (( $# )); do case "$1" in --at) at="$2"; shift 2 ;; -o) out="$2"; shift 2 ;; *) shift ;; esac; done
    rm -rf "$out"; mkdir -p "$out"; echo "$at" >> "$FAKE_LOG"
    i=0
    for t in \${at//,/ }; do
      case "$FAKE_MODE" in
        pure) x=$(awk -v t="$t" 'BEGIN { print int(t * 60) }') ;;
        impure) x=$(( (i * 37) % 280 )) ;;
        *) x=0 ;;
      esac
      ffmpeg -hide_banner -loglevel error -nostdin -f lavfi -i color=c=black:s=320x180 -vf "drawbox=x=$x:y=60:w=40:h=40:color=red:t=fill" -frames:v 1 "$out/frame-$(printf '%02d' "$i")-at-\${t}s.png"
      i=$((i + 1))
    done ;;
  *) exit 1 ;;
esac
`;

function bin(withHyperframes = true): string {
    const dir = mkdtempSync(join(work, "bin-"));

    symlinkSync(engine!.ffmpeg, join(dir, "ffmpeg"));

    if (withHyperframes) {
        writeFileSync(join(dir, "hyperframes"), FAKE, { mode: 0o755 });
    }

    return dir;
}

function run(mode: string, args: string[] = [], withHyperframes = true) {
    const project = mkdtempSync(join(work, `${mode}-`));
    const log = join(project, "orders.log");

    mkdirSync(join(project, "compositions"));

    const result = spawnSync("bash", [script, project, ...args], {
        encoding: "utf8",
        env: { PATH: `${bin(withHyperframes)}:/usr/bin:/bin`, FAKE_MODE: mode, FAKE_LOG: log },
    });

    return { ...result, project, orders: () => readFileSync(log, "utf8").trim().split("\n").map((line) => line.split(",")) };
}

test("twice.sh is in the skill, runnable, and the skill tells Pi to run it and hyperframes check before every render", () => {
    accessSync(script, constants.X_OK);

    const text = readFileSync(join(skill, "SKILL.md"), "utf8");

    assert.match(text, /<!-- pi-phone: added \(PP-413\)\. -->/);
    assert.match(text, /\*\*Before every render\*\*[^]*`hyperframes check <folder>`[^]*`scripts\/twice\.sh <folder>`/);
    assert.match(text, /### 7\. Full-film Gauntlet\nRender the whole film \(after `hyperframes check` and `scripts\/twice\.sh` pass/);
    assert.match(readFileSync(join(skill, "references", "quality-bar.md"), "utf8"), /\| Determinism \|[^\n]*`scripts\/twice\.sh`/);
});

test("a picture that depends only on t: the same pictures in two shuffled orders, exit 0", real, () => {
    const result = run("pure");

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^same: 12 frames drawn twice, in two shuffled orders: same t, same picture$/m);
    assert.doesNotMatch(result.stdout, /warning/);
    assert.match(result.stdout, new RegExp(`stills: ${result.project}/\\.hyperframes/artifacts/twice`));

    const [first, second] = result.orders();
    const times = ["0", "0.333", "0.667", "1", "1.333", "1.667", "2", "2.333", "2.667", "3", "3.333", "3.667"];

    // The same twelve times, evenly over 4 s, in two orders that are neither each other nor the order a render draws.
    assert.deepEqual([...first!].sort((a, b) => Number(a) - Number(b)), times);
    assert.deepEqual([...second!].sort((a, b) => Number(a) - Number(b)), times);
    assert.notDeepEqual(first, second);
    assert.notDeepEqual(first, times);
    assert.notDeepEqual(second, times);
});

test("a picture that depends on the frames drawn before it: the times whose pictures differ, the stills to compare, exit 1", real, () => {
    const result = run("impure", ["6"]);

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /^different: the same t drew two different pictures at (\d+(\.\d+)?s ?)+ \(largest difference \d+ of 255, limit 32\)$/m);
    assert.match(result.stdout, /compare \S+\/a\/frame-\d\d-at-[\d.]+s\.png with \S+\/b\/frame-\d\d-at-[\d.]+s\.png/);
    assert.match(result.stdout, /use fromTo/);
    assert.equal(result.orders()[0]!.length, 6);
});

test("a timeline that never changes: same pictures, and a warning that nothing changes with t", real, () => {
    const result = run("still", ["4"]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^warning: every frame looks the same/m);
});

test("without hyperframes, or with a wrong count, it says so and exits 2", real, () => {
    const missing = run("pure", [], false);

    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /hyperframes not found: install the HyperFrames and ffmpeg machine tools \(Settings › Machines › Install tools\)/);

    const wrong = run("pure", ["1"]);

    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /count is a whole number from 2 to 48/);
});
