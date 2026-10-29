// ffmpeg and HyperFrames as machine tools (PP-246): pinned builds with their sums, not ticked by default; ffmpeg's two
// programs, each with a wrapper; HyperFrames as an npm app run by a Node of its own from the app's pinned lockfile, with
// its telemetry, update checks and self-installs off, pointed at pi-phone's Chrome and ffmpeg, which install before it.
// Checked by hand on tuanlh-devbox-01 (linux-x64, 2026-10-29): the scripts installed, a 5 s GSAP film rendered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { APP_ROOT } from "../src/server/config.ts";
import {
    CHROME_TOOL,
    FFMPEG_TOOL,
    HYPERFRAMES_TOOL,
    installOrder,
    installScript,
    type ToolStatus,
    TOOLS,
    toolOffer,
    toolsNote,
} from "../src/server/machine-tools.ts";

test("ffmpeg 9.0.2: BtbN's GPL builds for Linux and Windows, Martin Riedl's for macOS, ffprobe beside it; listed, not ticked", () => {
    assert.ok(TOOLS.includes(FFMPEG_TOOL));
    assert.equal(FFMPEG_TOOL.version, "9.0.2");
    assert.deepEqual(Object.keys(FFMPEG_TOOL.assets).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "windows-arm64", "windows-x64"]);

    for (const [target, asset] of Object.entries(FFMPEG_TOOL.assets)) {
        assert.match(asset!.sha256, /^[0-9a-f]{64}$/, target);
        assert.deepEqual(asset!.more?.map((more) => more.command), ["ffprobe"], target);
        assert.match(
            asset!.url,
            target.startsWith("darwin")
                ? /^https:\/\/ffmpeg\.martin-riedl\.de\/download\/macos\/(arm64|amd64)\/\d+_9\.0\.2\/ffmpeg\.zip$/
                : /^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/autobuild-2026-09-30-13-08\/ffmpeg-n9\.0\.2-17-g2a571b6068-(linux64|linuxarm64|win64|winarm64)-gpl-9\.0\.(tar\.xz|zip)$/,
            target,
        );

        for (const more of asset!.more ?? []) {
            assert.ok(more.from === undefined || /^[0-9a-f]{64}$/.test(more.from.sha256), target);
        }
    }

    assert.equal(FFMPEG_TOOL.assets["linux-x64"]!.sha256, "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269");
    assert.equal(FFMPEG_TOOL.assets["darwin-arm64"]!.more![0]!.from!.sha256, "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6");
    assert.equal(toolOffer(FFMPEG_TOOL).optIn, true);
    assert.equal(toolOffer(HYPERFRAMES_TOOL).optIn, true);
    assert.deepEqual(
        TOOLS.filter((tool) => toolOffer(tool).optIn).map((tool) => tool.id),
        ["ffmpeg", "hyperframes"],
        "the others stay ticked",
    );
});

test("ffmpeg on Linux: one .tar.xz, checked, both programs out of it in one go, two wrappers, and -version", () => {
    const script = installScript(FFMPEG_TOOL, FFMPEG_TOOL.assets["linux-x64"]!, "/home/me");
    const name = "ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0";

    assert.match(script, /if ! command -v xz >\/dev\/null 2>&1; then echo "This machine has no xz/);
    assert.equal(script.match(/^fetch /gm)?.length, 1);
    assert.ok(script.includes(`tar -xJf "$tmp/download" -C "$tmp" '${name}/bin/ffmpeg' '${name}/bin/ffprobe'`), script);
    assert.ok(script.includes(`cp "$tmp/${name}/bin/ffprobe" "$T/ffmpeg/9.0.2"/ffprobe`));
    assert.match(script, /cat > "\$T\/bin\/ffmpeg\.new" <<'PI_PHONE_TOOL_END'\n#!\/bin\/sh\n# pi-phone-tool ffmpeg 9\.0\.2\nexec '\/home\/me\/\.pi\/mobile\/tools\/ffmpeg\/9\.0\.2\/ffmpeg' "\$@"\n/);
    assert.match(script, /cat > "\$T\/bin\/ffprobe\.new" <<'PI_PHONE_TOOL_END'\n#!\/bin\/sh\n# pi-phone-tool ffmpeg 9\.0\.2\nexec '\/home\/me\/\.pi\/mobile\/tools\/ffmpeg\/9\.0\.2\/ffprobe' "\$@"\n/);
    assert.match(script, /mv "\$T\/bin\/ffprobe\.new" "\$T\/bin\/ffprobe"/);
    assert.match(script, /"\$T\/bin\/ffmpeg" -version \| head -n 1$/);
});

test("ffmpeg on macOS: two zips, each checked before anything is kept; on Windows the zip's .exe files", () => {
    const mac = installScript(FFMPEG_TOOL, FFMPEG_TOOL.assets["darwin-arm64"]!, "/Users/me");

    assert.match(mac, /fetch 'https:\/\/ffmpeg\.martin-riedl\.de\/download\/macos\/arm64\/1789931890_9\.0\.2\/ffmpeg\.zip' "\$tmp\/download"/);
    assert.match(mac, /fetch 'https:\/\/ffmpeg\.martin-riedl\.de\/download\/macos\/arm64\/1789931890_9\.0\.2\/ffprobe\.zip' "\$tmp\/download-1"/);
    assert.match(mac, /if \[ "\$got" != 'fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6' \]/);
    assert.ok(mac.indexOf("download-1\"\ngot=") < mac.indexOf("unzip -p"), "both are checked before either is unpacked");
    assert.match(mac, /unzip -p "\$tmp\/download-1" 'ffprobe' > "\$T\/ffmpeg\/9\.0\.2"\/ffprobe/);
    assert.doesNotMatch(mac, /xz/);

    const windows = installScript(FFMPEG_TOOL, FFMPEG_TOOL.assets["windows-x64"]!, "C:/Users/me", true);

    assert.match(windows, /unzip -p "\$tmp\/download" 'ffmpeg-n9\.0\.2-17-g2a571b6068-win64-gpl-9\.0\/bin\/ffprobe\.exe' > "\$T\/ffmpeg\/9\.0\.2"\/ffprobe\.exe/);
    assert.match(windows, /exec 'C:\/Users\/me\/\.pi\/mobile\/tools\/ffmpeg\/9\.0\.2\/ffprobe\.exe' "\$@"/);
});

test("HyperFrames: Node 24.22.2 of its own, unpacked whole; the app's lockfile installed with npm ci --ignore-scripts; telemetry off", () => {
    assert.ok(TOOLS.includes(HYPERFRAMES_TOOL));
    assert.deepEqual(HYPERFRAMES_TOOL.needs, ["chrome", "ffmpeg"]);
    assert.deepEqual(Object.keys(HYPERFRAMES_TOOL.assets).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"]);

    for (const asset of Object.values(HYPERFRAMES_TOOL.assets)) {
        assert.match(asset!.url, /^https:\/\/nodejs\.org\/dist\/v24\.22\.2\/node-v24\.22\.2-(linux|darwin)-(x64|arm64)\.tar\.gz$/);
        assert.match(asset!.sha256, /^[0-9a-f]{64}$/);
    }

    const script = installScript(HYPERFRAMES_TOOL, HYPERFRAMES_TOOL.assets["linux-x64"]!, "/home/me");
    const dir = `"$T/hyperframes/0.8.216"`;

    assert.match(script, /if \[ "\$got" != '361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9' \]/);
    assert.ok(script.includes(`tar -xzf "$tmp/download" -C ${dir}/files`), script);
    assert.ok(script.includes(`if [ ! -f ${dir}/app/package-lock.json ]; then`));
    assert.ok(
        script.includes(
            `(cd ${dir}/app && rm -rf node_modules && ${dir}/files/'node-v24.22.2-linux-x64/bin/node' ${dir}/files/'node-v24.22.2-linux-x64/lib/node_modules/npm/bin/npm-cli.js' ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error --cache "$tmp/npm-cache")`,
        ),
        script,
    );

    const wrapper = script.slice(script.indexOf("# pi-phone-tool hyperframes"), script.lastIndexOf("PI_PHONE_TOOL_END"));

    for (const line of [
        "export HYPERFRAMES_NO_TELEMETRY='1'",
        "export DO_NOT_TRACK='1'",
        "export HYPERFRAMES_NO_UPDATE_CHECK='1'",
        "export HYPERFRAMES_NO_AUTO_INSTALL='1'",
        "export HYPERFRAMES_NO_OPTIONAL_INSTALL='1'",
        "export HYPERFRAMES_SKIP_SKILLS='1'",
        "export HYPERFRAMES_BROWSER_PATH='/home/me/.pi/mobile/tools/bin/chrome-headless-shell'",
        "export HYPERFRAMES_FFMPEG_PATH='/home/me/.pi/mobile/tools/bin/ffmpeg'",
        "export HYPERFRAMES_FFPROBE_PATH='/home/me/.pi/mobile/tools/bin/ffprobe'",
        `exec '/home/me/.pi/mobile/tools/hyperframes/0.8.216/files/node-v24.22.2-linux-x64/bin/node' '/home/me/.pi/mobile/tools/hyperframes/0.8.216/app/node_modules/hyperframes/bin/hyperframes.mjs' "$@"`,
    ]) {
        assert.ok(wrapper.includes(`${line}\n`), `${line}\n${wrapper}`);
    }

    // Its Chrome is pi-phone's headless shell, by the wrapper's name, which HyperFrames knows as one.
    assert.equal(CHROME_TOOL.command, "chrome-headless-shell");
});

test("HyperFrames' lockfile pins hyperframes 0.8.216 and every package with its integrity; only esbuild has an install script", () => {
    const dir = join(APP_ROOT, HYPERFRAMES_TOOL.npm!.dir);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as {
        lockfileVersion: number;
        packages: Record<string, { version?: string; resolved?: string; integrity?: string; hasInstallScript?: boolean }>;
    };

    assert.deepEqual(manifest.dependencies, { hyperframes: HYPERFRAMES_TOOL.version });
    assert.equal(lock.lockfileVersion, 3);
    assert.equal(lock.packages["node_modules/hyperframes"]?.version, HYPERFRAMES_TOOL.version);
    assert.equal(
        lock.packages["node_modules/hyperframes"]?.integrity,
        "sha512-OdtAQCl+2VJat/6rcygYcLZoGhqeXmmhfEyZJNwy3O7in6UQrIImjNnkfINTkoBsLEnGhwHnro+eL6ZfpGXsjA==",
    );

    const packages = Object.entries(lock.packages).filter(([path]) => path !== "");

    assert.ok(packages.length > 50);

    for (const [path, entry] of packages) {
        assert.match(entry.resolved ?? "", /^https:\/\/registry\.npmjs\.org\//, path);
        assert.match(entry.integrity ?? "", /^sha512-/, path);
    }

    assert.deepEqual(packages.filter(([, entry]) => entry.hasInstallScript === true).map(([path]) => path), ["node_modules/esbuild"]);
});

test("HyperFrames installs after Chrome and ffmpeg, unless they are there at their versions; each tool once", () => {
    const status = (id: string, installed?: string): ToolStatus => {
        const tool = TOOLS.find((each) => each.id === id)!;

        return { id, name: id, version: tool.version, description: "", size: "", desktop: false, optIn: false, supported: true, offered: true, ...(installed === undefined ? {} : { installed }) };
    };

    assert.deepEqual(installOrder(["hyperframes"], []), ["chrome", "ffmpeg", "hyperframes"]);
    assert.deepEqual(installOrder(["ffmpeg", "hyperframes", "rg"], []), ["ffmpeg", "chrome", "hyperframes", "rg"]);
    assert.deepEqual(installOrder(["hyperframes"], [status("chrome", CHROME_TOOL.version), status("ffmpeg", "9.0.1")]), ["ffmpeg", "hyperframes"]);
    assert.deepEqual(installOrder(["officecli"], []), ["officecli"]);
});

test("a session on a machine with HyperFrames is told how to render, with ffprobe, and never npx; without it, as before", () => {
    const note = toolsNote({ chrome: "155.0.8059.84", ffmpeg: "9.0.2", hyperframes: "0.8.216" })!;

    assert.match(note, /^pi-phone installed these tools there, first on bash's PATH \(~\/\.pi\/mobile\/tools\/bin\): chrome 155\.0\.8059\.84, ffmpeg 9\.0\.2, hyperframes 0\.8\.216\./);
    assert.match(note, /`hyperframes render <project folder> -o <folder>\/<name>\.mp4`/);
    assert.match(note, /check the result with ffprobe/);
    assert.match(note, /~\/\.pi\/mobile\/tools\/hyperframes\/0\.8\.216\/app\/node_modules\/hyperframes\/dist\/skills\/hyperframes\/SKILL\.md/);
    assert.match(note, /never `npx hyperframes`/);
    assert.equal(toolsNote({ rg: "15.2.0" }), "pi-phone installed these tools there, first on bash's PATH (~/.pi/mobile/tools/bin): rg 15.2.0.");
    assert.equal(toolsNote({}), undefined);
});
