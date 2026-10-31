/**
 * Tools pi-phone installs on a machine, when the owner adds it or later (Settings › Machines; owner's decisions of
 * 2026-10-18, DESIGN.md section 4). Command-line programs run where bash runs, and in a session on a machine that is
 * the machine: so OfficeCLI, ripgrep, and fd go there, not on the phone.
 *
 * Each tool is the machine's own build at a pinned version, downloaded by the machine itself (curl or wget) and checked
 * against its sha256 before anything is kept, into `~/.pi/mobile/tools/<tool>/<version>/` (beside pi-env's daemon). A
 * small script in `~/.pi/mobile/tools/bin/` runs it, marked `# pi-phone-tool <id> <version>`, with what it needs
 * (OfficeCLI: never update or install itself); that folder is first on the PATH of bash in sessions on the machine
 * (`app.ts`). OfficeCLI's skills go with it, so Pi there reads them where they are. rg and fd are offered only when the
 * machine has none of its own. Nothing is installed without the owner's tick.
 *
 * A tool may be more than one program (ffmpeg and ffprobe), need others installed first (HyperFrames: Chrome and
 * ffmpeg), or be an npm app run by a Node of its own (HyperFrames: Node's release, then the app's pinned lockfile from
 * the phone's `third_party/`, installed with `npm ci --ignore-scripts`).
 *
 * One tool is not a program pi-phone pins: Chrome Remote Desktop (PP-263, `crd.ts`), Google's signed host installer for
 * Windows from a rolling address, so it is checked by its Authenticode signature (Google LLC) instead of a sha256, and
 * installed with msiexec; it is not on bash's PATH.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ROOT } from "./config.ts";
import { ChromeRemoteDesktop, CRD_SIGNER, type CrdRun, type CrdState, type CrdWord, crdWord } from "./crd.ts";
import { HttpError } from "./errors.ts";
import type { Machine } from "./machines.ts";
import type { Places } from "./places.ts";

/** Where the tools live on a machine, under its home. */
export const TOOLS_DIR = ".pi/mobile/tools";
/** The folder on bash's PATH there. */
export const TOOLS_BIN = `${TOOLS_DIR}/bin`;

type Target = `${"linux" | "darwin" | "android" | "windows"}-${"x64" | "arm64"}`;
/** A download, checked by its sha256. */
type Download = { url: string; sha256: string };
/**
 * The program inside a .tar.gz, .tar.xz, or .zip (by the url); absent: the download is the program. `more`: further
 * programs of the tool, each with a wrapper of its own (ffprobe beside ffmpeg), a member of this download or of their own
 * (`from`).
 */
type Asset = Download & { member?: string; more?: readonly { command: string; member: string; from?: Download }[] };

export type ToolSpec = {
    id: string;
    name: string;
    /** The command bash runs. */
    command: string;
    version: string;
    description: string;
    /** Roughly what goes on the machine. */
    size: string;
    /** Offered only when the machine has no command of this name of its own. */
    onlyIfMissing?: boolean;
    /** Other commands that count as the machine's own (Chrome's other names), and files that do (written for sh). */
    alsoOwn?: string[];
    alsoOwnPaths?: string[];
    /** Set for the program (the wrapper exports them). */
    env?: Record<string, string>;
    /** Skills that go with it, from the phone's copy (`third_party/`): relative to APP_ROOT, or absolute (tests). */
    skills?: string;
    /** The whole archive (a .zip) is unpacked into its folder, and `member` is the program in it (Chrome's many files). */
    whole?: boolean;
    /** It works in the machine's desktop: on Linux it needs a signed-in (or virtual) desktop session (ocu). */
    desktop?: boolean;
    /** What makes it say its version, when not `--version` (ffmpeg: `-version`). */
    versionArg?: string;
    /** Not ticked in the lists until the owner ticks it (a big one: ffmpeg, HyperFrames). */
    optIn?: boolean;
    /** Tools (ids) installed before it when they are not, at their versions, even where the machine has its own. */
    needs?: string[];
    /** Set for the program to the wrapper of another tool's command in the tools' bin (HyperFrames: Chrome, ffmpeg). */
    envCommands?: Record<string, string>;
    /**
     * An npm app, run by the Node of its download (`whole`, `member` is `bin/node`): `dir` (relative to APP_ROOT, or
     * absolute in tests) holds its package.json and pinned package-lock.json, installed into `<version>/app/` with `npm ci
     * --ignore-scripts`; `bin` is its script there.
     */
    npm?: { dir: string; bin: string };
    /**
     * Installed by its own code, not by `installScript`: Chrome Remote Desktop (`crd.ts`), whose `assets` are empty, as
     * its download is checked by `signer` (its Authenticode signature) rather than a pinned sha256 (a rolling address).
     */
    installer?: "crd";
    /** The download's Authenticode signer, checked instead of a sha256 (`installer`). */
    signer?: string;
    /** Offered on Windows only, for now. */
    windowsOnly?: boolean;
    assets: Partial<Record<Target, Asset>>;
};

const OFFICECLI = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157";
const RG = "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0";
const FD = "https://github.com/sharkdp/fd/releases/download/v10.5.0";
const CHROME = "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84";
/** BtbN's FFmpeg-Builds: the 9.0 release branch (n9.0.2 and 17 fixes), the month's last build, which it keeps two years. */
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08";
const BTBN_NAME = "ffmpeg-n9.0.2-17-g2a571b6068";
/** Martin Riedl's macOS release builds of FFmpeg 9.0.2 (signed), one zip per program. */
const RIEDL = "https://ffmpeg.martin-riedl.de/download/macos";
const NODE = "https://nodejs.org/dist/v24.22.2";

/** Where Chrome, Chromium, and Edge are put on macOS and Windows (Git Bash's paths), which no PATH may name. */
export const CHROME_PATHS = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "$HOME/AppData/Local/Google/Chrome/Application/chrome.exe",
    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/c/Program Files/Microsoft/Edge/Application/msedge.exe",
];

/**
 * Pi's browser on a machine (`browser/machine-engine.ts`) for a machine without its own Chrome: Chrome for Testing's
 * headless shell, offered when the machine has no Chrome, Chromium, or Edge of its own (by name on the PATH, or where
 * their installers put them).
 */
export const CHROME_TOOL: ToolSpec = {
    id: "chrome",
    name: "Chrome (headless)",
    command: "chrome-headless-shell",
    version: "155.0.8059.84",
    description: "Pi's browser for sessions on this machine, when it has no Chrome of its own",
    size: "about 285 MB",
    onlyIfMissing: true,
    alsoOwn: ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"],
    alsoOwnPaths: CHROME_PATHS,
    whole: true,
    // Chrome for Testing publishes no sums: these are of the files as downloaded on 2026-10-20.
    assets: {
        "linux-x64": { url: `${CHROME}/linux64/chrome-headless-shell-linux64.zip`, sha256: "a5d71b91aa996fef00517cd212b2dfb816b43055edefbe727e6fd562d4ae1f9c", member: "chrome-headless-shell-linux64/chrome-headless-shell" },
        "linux-arm64": { url: `${CHROME}/linux-arm64/chrome-headless-shell-linux-arm64.zip`, sha256: "0c83c2520b513835c712590781adbdbcab4c14ca04d4809be5055ff2c8937a51", member: "chrome-headless-shell-linux-arm64/chrome-headless-shell" },
        "darwin-arm64": { url: `${CHROME}/mac-arm64/chrome-headless-shell-mac-arm64.zip`, sha256: "7f111980bcb41e908d0fa3e969a625e7777ff683c1fc43fd7759d05ec3ffe52b", member: "chrome-headless-shell-mac-arm64/chrome-headless-shell" },
        "darwin-x64": { url: `${CHROME}/mac-x64/chrome-headless-shell-mac-x64.zip`, sha256: "3c5bf34eb8daa874e8b50edf900eab618b74c1b9596e596340278eeba4ff1ae1", member: "chrome-headless-shell-mac-x64/chrome-headless-shell" },
        "windows-x64": { url: `${CHROME}/win64/chrome-headless-shell-win64.zip`, sha256: "5ca590a4968864e219ea25ccd134597ef8898a733a4698c07fc3e8b2c480fef4", member: "chrome-headless-shell-win64/chrome-headless-shell.exe" },
        // There is no Windows arm64 build: Windows on Arm runs the x64 one.
        "windows-arm64": { url: `${CHROME}/win64/chrome-headless-shell-win64.zip`, sha256: "5ca590a4968864e219ea25ccd134597ef8898a733a4698c07fc3e8b2c480fef4", member: "chrome-headless-shell-win64/chrome-headless-shell.exe" },
    },
};

const OCU = "https://github.com/picassio/open-computer-use/releases/download/v1.1.2-pp.3";

/**
 * Computer use (PP-177): open-computer-use ("ocu", MIT) in our fork's build, whose outline marks password fields and
 * refuses typing into them unless a call says `allow_password_input` (1.1.2-pp.2: the owner typing on a taken-over
 * window, a saved secret by name). 1.1.2-pp.3 (PP-270) adds snapshot ids and stale_ref, element states, covered window
 * parts blacked out, `headed` for coordinate input and an `Error:` line. `computer-control.ts` runs `ocu mcp` on the
 * machine for a control session.
 */
export const OCU_TOOL: ToolSpec = {
    id: "ocu",
    name: "Computer use (ocu)",
    command: "ocu",
    version: "1.1.2-pp.3",
    description: "Pi reads and operates desktop apps here, in a session you approve on a card. pi-phone's build of open-computer-use (MIT).",
    size: "about 2.5 MB",
    desktop: true,
    // The release's own SHA256SUMS.
    assets: {
        "linux-x64": { url: `${OCU}/open-computer-use-linux-x64`, sha256: "fcadd7212dab95dab3f825ad5a78cc4b2caf328dee6468dfd60095d91410c0bf" },
        "linux-arm64": { url: `${OCU}/open-computer-use-linux-arm64`, sha256: "a385a5d38586a73f4a0d53a825b9eefedfa0cb7830c493ff2887b7a388891370" },
        "windows-x64": { url: `${OCU}/open-computer-use-windows-x64.exe`, sha256: "d36fe1017a79ed2226ddf5bdf09ab51a91e31f1398933eb44f3a3be5a6ecf42f" },
    },
};

/**
 * Chrome Remote Desktop (PP-263): Google's host, so the owner unlocks and sees a Windows machine from their phone (the
 * lock screen is out of computer use's reach). The machine downloads Google's MSI itself (never passed on by pi-phone)
 * from its rolling address, so it is checked by its Authenticode signature (Google LLC), not a sha256: the exception to
 * the rule above. `crd.ts` installs, connects, reads and removes it. Windows x64 only for now; Linux and macOS later.
 */
export const CRD_TOOL: ToolSpec = {
    id: "crd",
    name: "Chrome Remote Desktop",
    command: "remoting_start_host",
    version: "Google's current",
    description: "Chrome Remote Desktop: unlock and see this computer from your phone. Google's host, its signature checked; you connect it to your Google account on a card.",
    size: "about 25 MB",
    optIn: true,
    installer: "crd",
    signer: CRD_SIGNER,
    windowsOnly: true,
    assets: {},
};

/**
 * ffmpeg and ffprobe (PP-246), for HyperFrames and video work: static builds, GPL. Linux and Windows: BtbN's (GPLv3), sums
 * from the release's checksums.sha256; macOS: Martin Riedl's (GPL, built with --enable-nonfree, so not to be passed on;
 * the machine downloads it for itself), sums from his .sha256 files. Windows on Arm has BtbN's own arm64 build.
 */
export const FFMPEG_TOOL: ToolSpec = {
    id: "ffmpeg",
    name: "ffmpeg",
    command: "ffmpeg",
    version: "9.0.2",
    description: "ffmpeg and ffprobe: encode, cut, and measure video and audio (static GPL builds)",
    size: "about 350 MB (150 MB on macOS)",
    onlyIfMissing: true,
    optIn: true,
    versionArg: "-version",
    assets: {
        "linux-x64": {
            url: `${BTBN}/${BTBN_NAME}-linux64-gpl-9.0.tar.xz`,
            sha256: "68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269",
            member: `${BTBN_NAME}-linux64-gpl-9.0/bin/ffmpeg`,
            more: [{ command: "ffprobe", member: `${BTBN_NAME}-linux64-gpl-9.0/bin/ffprobe` }],
        },
        "linux-arm64": {
            url: `${BTBN}/${BTBN_NAME}-linuxarm64-gpl-9.0.tar.xz`,
            sha256: "91afcd7695d4bbbb9e0057aa10baaf9875ec4e1a97303f9059ec971336a2ab46",
            member: `${BTBN_NAME}-linuxarm64-gpl-9.0/bin/ffmpeg`,
            more: [{ command: "ffprobe", member: `${BTBN_NAME}-linuxarm64-gpl-9.0/bin/ffprobe` }],
        },
        "windows-x64": {
            url: `${BTBN}/${BTBN_NAME}-win64-gpl-9.0.zip`,
            sha256: "a0e45723c72141975f51d8666302e614711745f3102b704ca3f82c897a58d278",
            member: `${BTBN_NAME}-win64-gpl-9.0/bin/ffmpeg.exe`,
            more: [{ command: "ffprobe", member: `${BTBN_NAME}-win64-gpl-9.0/bin/ffprobe.exe` }],
        },
        "windows-arm64": {
            url: `${BTBN}/${BTBN_NAME}-winarm64-gpl-9.0.zip`,
            sha256: "6dcd0626f9f6d6c7323565e57410e9f37ed14a85946ec9ea9caff294ca32f5c0",
            member: `${BTBN_NAME}-winarm64-gpl-9.0/bin/ffmpeg.exe`,
            more: [{ command: "ffprobe", member: `${BTBN_NAME}-winarm64-gpl-9.0/bin/ffprobe.exe` }],
        },
        "darwin-arm64": {
            url: `${RIEDL}/arm64/1789931890_9.0.2/ffmpeg.zip`,
            sha256: "c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924",
            member: "ffmpeg",
            more: [
                {
                    command: "ffprobe",
                    member: "ffprobe",
                    from: { url: `${RIEDL}/arm64/1789931890_9.0.2/ffprobe.zip`, sha256: "fcbe839537485eaee7a7a8bc5cbc0f90d53617e80943e8a5b2e31cb851197ea6" },
                },
            ],
        },
        "darwin-x64": {
            url: `${RIEDL}/amd64/1789931006_9.0.2/ffmpeg.zip`,
            sha256: "7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4",
            member: "ffmpeg",
            more: [
                {
                    command: "ffprobe",
                    member: "ffprobe",
                    from: { url: `${RIEDL}/amd64/1789931006_9.0.2/ffprobe.zip`, sha256: "2322438ed2f6319a691291b247d09c69dcaa3a982460d1f269a7e1af335cfdfd" },
                },
            ],
        },
    },
};

/**
 * HyperFrames (HeyGen, Apache-2.0; PP-246): HTML and GSAP compositions rendered to MP4, frame by frame in Chrome headless
 * shell, encoded by ffmpeg. An npm app (Node >= 22) run by Node 24.22.2 LTS of its own (nodejs.org's release, sums from
 * its SHASUMS256.txt), from `third_party/hyperframes/`'s lockfile (hyperframes 0.8.216 and every dependency pinned with
 * its integrity). It needs no install scripts (esbuild's only checks its binary). The wrapper turns off its telemetry
 * (PostHog), update checks, self-installs (of itself, its skills, and optional packages), and points it at pi-phone's
 * Chrome headless shell and ffmpeg, installed before it. Bumping Node or the lockfile bumps `version`.
 */
export const HYPERFRAMES_TOOL: ToolSpec = {
    id: "hyperframes",
    name: "HyperFrames",
    command: "hyperframes",
    version: "0.8.216",
    description: "Render HTML and GSAP compositions to MP4 (HeyGen's HyperFrames, telemetry off); installs Chrome (headless) and ffmpeg with it",
    size: "about 320 MB; with Chrome and ffmpeg about 920 MB",
    optIn: true,
    needs: ["chrome", "ffmpeg"],
    env: {
        HYPERFRAMES_NO_TELEMETRY: "1",
        DO_NOT_TRACK: "1",
        HYPERFRAMES_NO_UPDATE_CHECK: "1",
        HYPERFRAMES_NO_AUTO_INSTALL: "1",
        HYPERFRAMES_NO_OPTIONAL_INSTALL: "1",
        HYPERFRAMES_SKIP_SKILLS: "1",
    },
    envCommands: { HYPERFRAMES_BROWSER_PATH: "chrome-headless-shell", HYPERFRAMES_FFMPEG_PATH: "ffmpeg", HYPERFRAMES_FFPROBE_PATH: "ffprobe" },
    npm: { dir: "third_party/hyperframes", bin: "node_modules/hyperframes/bin/hyperframes.mjs" },
    whole: true,
    // Linux and macOS only: on Windows it is untried, and Node there cannot start the Chrome wrapper (a sh script).
    assets: {
        "linux-x64": { url: `${NODE}/node-v24.22.2-linux-x64.tar.gz`, sha256: "361718c444e49af2ca5a110c83ba6a8901143f23ab285ebbef0341f391f482a9", member: "node-v24.22.2-linux-x64/bin/node" },
        "linux-arm64": { url: `${NODE}/node-v24.22.2-linux-arm64.tar.gz`, sha256: "95c264150aceb7f3437a29fd6984924f5f8d1511ea3cbd6c508b83f6c555dae2", member: "node-v24.22.2-linux-arm64/bin/node" },
        "darwin-arm64": { url: `${NODE}/node-v24.22.2-darwin-arm64.tar.gz`, sha256: "aa9549349e47dffaa42dcf95d6e06ade8c4bdafc980979883b88767670df385a", member: "node-v24.22.2-darwin-arm64/bin/node" },
        "darwin-x64": { url: `${NODE}/node-v24.22.2-darwin-x64.tar.gz`, sha256: "d5e336d588c45be0c37dbd52cc29895593009ca4997a77a1fd02815131ed0e52", member: "node-v24.22.2-darwin-x64/bin/node" },
    },
};

/** The tools, as the list shows them. Versions and sums are pinned: OfficeCLI's and rg's from their releases' own sums. */
export const TOOLS: readonly ToolSpec[] = [
    {
        id: "officecli",
        name: "OfficeCLI",
        command: "officecli",
        version: "1.0.157",
        description: "Create, read, and edit Word, Excel, and PowerPoint files; with its skills for Pi",
        size: "about 35 MB",
        env: { OFFICECLI_SKIP_UPDATE: "1", OFFICECLI_NO_AUTO_INSTALL: "1" },
        skills: "third_party/officecli/skills",
        assets: {
            "linux-x64": { url: `${OFFICECLI}/officecli-linux-x64`, sha256: "f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94" },
            "linux-arm64": { url: `${OFFICECLI}/officecli-linux-arm64`, sha256: "60db926c8a1371984b9e99622a834777befb02b6f73d0f3fff914ffcc2760d2f" },
            "darwin-arm64": { url: `${OFFICECLI}/officecli-mac-arm64`, sha256: "0dae0990a9cc29688a5d54469f984c34e5b15ab6bbd194a0ffdc571bb9040124" },
            "darwin-x64": { url: `${OFFICECLI}/officecli-mac-x64`, sha256: "178c1e9ebaf44c24d2b4b359064a5dea6eb7b2f539809871a3de1c09599dff9f" },
            "windows-x64": { url: `${OFFICECLI}/officecli-win-x64.exe`, sha256: "bd64eba587e56cc71709cdd1f38ae9ac77cd65a9c8ea744b0996897c0557e343" },
            "windows-arm64": { url: `${OFFICECLI}/officecli-win-arm64.exe`, sha256: "786e08b1ccf09c3a2107912537fe25fa82970b30145e3c59e09d83bf4032b065" },
            // Termux on Android: the fork's NativeAOT build, as the phone runs it (scripts/officecli.ts).
            "android-arm64": {
                url: "https://github.com/picassio/OfficeCLI/releases/download/android-v1.0.157/officecli-android-arm64.tar.gz",
                sha256: "c51163af08481e0240308d438921e8f367e5017261ad07407fb93b8b50367160",
                member: "officecli/officecli",
            },
        },
    },
    {
        id: "rg",
        name: "ripgrep (rg)",
        command: "rg",
        version: "15.2.0",
        description: "Fast search through files, as Pi uses it",
        size: "about 6 MB",
        onlyIfMissing: true,
        assets: {
            "linux-x64": { url: `${RG}/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz`, sha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c", member: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg" },
            "linux-arm64": { url: `${RG}/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz`, sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915", member: "ripgrep-15.2.0-aarch64-unknown-linux-musl/rg" },
            "android-arm64": { url: `${RG}/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz`, sha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915", member: "ripgrep-15.2.0-aarch64-unknown-linux-musl/rg" },
            "darwin-arm64": { url: `${RG}/ripgrep-15.2.0-aarch64-apple-darwin.tar.gz`, sha256: "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4", member: "ripgrep-15.2.0-aarch64-apple-darwin/rg" },
            "darwin-x64": { url: `${RG}/ripgrep-15.2.0-x86_64-apple-darwin.tar.gz`, sha256: "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1", member: "ripgrep-15.2.0-x86_64-apple-darwin/rg" },
            "windows-x64": { url: `${RG}/ripgrep-15.2.0-x86_64-pc-windows-msvc.zip`, sha256: "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5", member: "ripgrep-15.2.0-x86_64-pc-windows-msvc/rg.exe" },
            "windows-arm64": { url: `${RG}/ripgrep-15.2.0-aarch64-pc-windows-msvc.zip`, sha256: "e4abca10c3a64ebea742667dd7009449d49403db5460dd6873e389fa2945360f", member: "ripgrep-15.2.0-aarch64-pc-windows-msvc/rg.exe" },
        },
    },
    {
        id: "fd",
        name: "fd",
        command: "fd",
        version: "10.5.0",
        description: "Fast file finding by name, as Pi uses it",
        size: "about 4 MB",
        onlyIfMissing: true,
        // fd's releases publish no sums: these are of the files as downloaded on 2026-10-18.
        assets: {
            "linux-x64": { url: `${FD}/fd-v10.5.0-x86_64-unknown-linux-musl.tar.gz`, sha256: "761c72dc8e120d85b22292063be8a796e2eeb20eb3e4f38b8fa2343ccf3514a7", member: "fd-v10.5.0-x86_64-unknown-linux-musl/fd" },
            "linux-arm64": { url: `${FD}/fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz`, sha256: "d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4", member: "fd-v10.5.0-aarch64-unknown-linux-musl/fd" },
            "android-arm64": { url: `${FD}/fd-v10.5.0-aarch64-unknown-linux-musl.tar.gz`, sha256: "d76c4317f7d5dba69f8a2a15856c90c777e7f0dd4e85f0de8c76de6992c374d4", member: "fd-v10.5.0-aarch64-unknown-linux-musl/fd" },
            "darwin-arm64": { url: `${FD}/fd-v10.5.0-aarch64-apple-darwin.tar.gz`, sha256: "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12", member: "fd-v10.5.0-aarch64-apple-darwin/fd" },
            "darwin-x64": { url: `${FD}/fd-v10.5.0-x86_64-apple-darwin.tar.gz`, sha256: "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590", member: "fd-v10.5.0-x86_64-apple-darwin/fd" },
            "windows-x64": { url: `${FD}/fd-v10.5.0-x86_64-pc-windows-msvc.zip`, sha256: "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7", member: "fd-v10.5.0-x86_64-pc-windows-msvc/fd.exe" },
            "windows-arm64": { url: `${FD}/fd-v10.5.0-aarch64-pc-windows-msvc.zip`, sha256: "a2bcddcfd259b05357a77bbc6cd671fdb30f63fd266a0e748305890a8c5ceaa6", member: "fd-v10.5.0-aarch64-pc-windows-msvc/fd.exe" },
        },
    },
    CHROME_TOOL,
    OCU_TOOL,
    // After Chrome and ffmpeg, which it needs.
    FFMPEG_TOOL,
    HYPERFRAMES_TOOL,
    CRD_TOOL,
];

/** One tool on one machine, as the list shows it. */
export type ToolStatus = {
    id: string;
    name: string;
    version: string;
    description: string;
    size: string;
    /** It needs a desktop session on Linux (ocu). */
    desktop: boolean;
    /** Not ticked until the owner ticks it (`ToolSpec.optIn`). */
    optIn: boolean;
    /** Checked by this Authenticode signer instead of a sha256 (Chrome Remote Desktop). */
    signer?: string;
    /** Windows only, for now. */
    windowsOnly?: boolean;
    /** Chrome Remote Desktop: how it stands there (on a Windows machine). */
    crd?: CrdWord;
    /** The machine has no build of it: not offered. */
    supported: boolean;
    /** Installed by pi-phone, and which version. */
    installed?: string;
    /** The machine's own, where it is (rg, fd): not offered. */
    own?: string;
    /** Whether the list offers it, ticked. */
    offered: boolean;
};

export type InstallResult = { id: string; ok: boolean; version?: string; said: string };

/** A tool as the lists before connecting offer it (Settings › Machines, the machine_add card): ticked, unless `optIn`. */
export type ToolOffer = { id: string; name: string; version: string; description: string; size: string; onlyIfMissing: boolean; desktop: boolean; optIn: boolean; windowsOnly: boolean; signer?: string };

export const toolOffer = (tool: ToolSpec): ToolOffer => ({
    id: tool.id,
    name: tool.name,
    version: tool.version,
    description: tool.description,
    size: tool.size,
    onlyIfMissing: tool.onlyIfMissing === true,
    desktop: tool.desktop === true,
    optIn: tool.optIn === true,
    windowsOnly: tool.windowsOnly === true,
    ...(tool.signer === undefined ? {} : { signer: tool.signer }),
});

/**
 * The tools to install on a machine just connected: those ticked (`wanted`, ids) that it offers (`ToolStatus.offered`:
 * it has a build, it is not installed at this version, and for rg and fd it has none of its own). An id that is no tool
 * is refused.
 */
export function toolsToInstall(statuses: readonly ToolStatus[], wanted: readonly string[], catalog: readonly ToolSpec[] = TOOLS): string[] {
    const unknown = wanted.filter((id) => !catalog.some((tool) => tool.id === id));

    if (unknown.length > 0) {
        throw new Error(`No tool ${unknown.join(", ")}. The tools are ${catalog.map((tool) => tool.id).join(", ")}.`);
    }

    return statuses.filter((status) => status.offered && wanted.includes(status.id)).map((status) => status.id);
}

/** A value for a single-quoted sh word. */
const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** The machine's build target, or undefined when the app has none for it. */
function targetOf(machine: Machine): Target | undefined {
    const remote = machine.remote;

    if (remote === undefined) {
        return undefined;
    }

    return `${remote.platform}-${remote.arch}` as Target;
}

/**
 * Status of each tool, from one script: the marker of pi-phone's wrapper, else the machine's own command. Tools with an
 * installer of their own (Chrome Remote Desktop) are read by theirs.
 */
export function statusScript(catalog: readonly ToolSpec[]): string {
    return [
        `T="$HOME/${TOOLS_DIR}"`,
        ...catalog.filter((tool) => tool.installer === undefined).map(
            (tool) =>
                `if [ -f "$T/bin/${tool.command}" ]; then echo "${tool.id} installed $(sed -n 's/^# pi-phone-tool [^ ]* //p' "$T/bin/${tool.command}" | head -n 1)"; ` +
                `else own=$(PATH=$(printf %s "$PATH" | tr ':' '\\n' | grep -v "/${TOOLS_BIN}$" | paste -sd: -); for c in ${[tool.command, ...(tool.alsoOwn ?? [])].join(" ")}; do command -v $c 2>/dev/null && break; done | head -n 1); ` +
                (tool.alsoOwnPaths === undefined ? "" : `[ -n "$own" ] || for p in ${tool.alsoOwnPaths.map((path) => `"${path}"`).join(" ")}; do if [ -x "$p" ]; then own="$p"; break; fi; done; `) +
                `if [ -n "$own" ]; then echo "${tool.id} own $own"; else echo "${tool.id} none"; fi; fi`,
        ),
    ].join("\n");
}

/**
 * The wrapper bash runs as the tool's command: its marker names the tool and version (`statusScript`). It runs `binary`
 * with `args` first (an npm app's script, for its Node), and sets `envCommands` to wrappers in the tools' bin under `home`.
 */
export function wrapperOf(tool: ToolSpec, binary: string, home: string, args: readonly string[] = []): string {
    return [
        "#!/bin/sh",
        `# pi-phone-tool ${tool.id} ${tool.version}`,
        ...Object.entries(tool.env ?? {}).map(([name, value]) => `export ${name}=${q(value)}`),
        ...Object.entries(tool.envCommands ?? {}).map(([name, command]) => `export ${name}=${q(`${home}/${TOOLS_BIN}/${command}`)}`),
        // Android's OfficeCLI needs Termux's OpenSSL (Android's own libssl aborts it); elsewhere $PREFIX is unset.
        ...(tool.id === "officecli" ? ['if [ -n "$PREFIX" ] && [ -d "$PREFIX/lib" ]; then export LD_LIBRARY_PATH="$PREFIX/lib"; fi'] : []),
        `exec ${[binary, ...args].map(q).join(" ")} "$@"`,
        "",
    ].join("\n");
}

/** How a downloaded archive unpacks, by its url: tar's flag for a .tar.gz or .tar.xz, "zip", or none (the program). */
function packOf(url: string): "z" | "J" | "zip" | undefined {
    return url.endsWith(".zip") ? "zip" : url.endsWith(".tar.gz") || url.endsWith(".tgz") ? "z" : url.endsWith(".tar.xz") ? "J" : undefined;
}

/**
 * The script that installs one tool's asset (its downloads, each checked), and writes its wrappers, one per program; its
 * last line is the tool's version. An npm app's package.json and package-lock.json are in `<version>/app/` before it runs
 * (`MachineTools.install` copies them there).
 */
export function installScript(tool: ToolSpec, asset: Asset, home: string, windows = false): string {
    const dir = `"$T/${tool.id}/${tool.version}"`;
    const base = `${home}/${TOOLS_DIR}/${tool.id}/${tool.version}`;
    // On Windows a program keeps its .exe: Windows runs files by it. Git Bash (Pi's shell there) runs the wrapper.
    const fileOf = (command: string) => (windows ? `${command}.exe` : command);
    const file = fileOf(tool.command);
    const whole = tool.whole === true && asset.member !== undefined;
    // A whole archive's program stays among its files (Chrome needs those beside it); the wrapper runs it there.
    const program = whole ? `files/${asset.member}` : file;
    const npm = tool.npm;

    if (npm !== undefined && (!whole || !asset.member!.endsWith("/bin/node"))) {
        throw new Error(`${tool.name} is an npm app: its download must be Node's, unpacked whole, with bin/node as its member.`);
    }

    // Each download once, by its url: the asset's, and those of further programs that have their own.
    const downloads: (Download & { path: string })[] = [{ url: asset.url, sha256: asset.sha256, path: "$tmp/download" }];

    for (const more of asset.more ?? []) {
        if (more.from !== undefined && !downloads.some((each) => each.url === more.from!.url)) {
            downloads.push({ ...more.from, path: `$tmp/download-${downloads.length}` });
        }
    }

    const pathOf = (url: string) => downloads.find((each) => each.url === url)!.path;
    const packs = downloads.map((each) => packOf(each.url));
    // The programs, each out of its download into the version's folder; a tar's members come out in one go.
    const programs = [
        { download: asset as Download, member: asset.member, to: file },
        ...(asset.more ?? []).map((more) => ({ download: more.from ?? asset, member: more.member as string | undefined, to: fileOf(more.command) })),
    ];
    const extract = (): string[] => {
        const lines: string[] = [];

        for (const download of downloads) {
            const pack = packOf(download.url);
            const members = programs.filter((each) => each.download.url === download.url && each.member !== undefined).map((each) => each.member!);

            if (members.length > 0 && pack === undefined) {
                throw new Error(`${download.url} is no .tar.gz, .tar.xz, or .zip to take ${members.join(", ")} from.`);
            }

            if (members.length > 0 && pack !== "zip") {
                lines.push(`tar -x${pack}f "${download.path}" -C "$tmp" ${members.map(q).join(" ")}`);
            }
        }

        for (const { download, member, to } of programs) {
            const from = pathOf(download.url);

            lines.push(
                member === undefined
                    ? `cp "${from}" ${dir}/${to}`
                    : packOf(download.url) === "zip"
                      ? `unzip -p "${from}" ${q(member)} > ${dir}/${to}`
                      : `cp "$tmp/${member}" ${dir}/${to}`,
            );
        }

        return lines;
    };
    const wrappers = [
        { command: tool.command, text: wrapperOf(tool, `${base}/${program}`, home, npm === undefined ? [] : [`${base}/app/${npm.bin}`]) },
        ...(asset.more ?? []).map((more) => ({ command: more.command, text: wrapperOf(tool, `${base}/${fileOf(more.command)}`, home) })),
    ];

    if (wrappers.some((wrapper) => wrapper.text.includes("PI_PHONE_TOOL_END"))) {
        throw new Error("A wrapper may not hold its own heredoc's end.");
    }

    return [
        "set -e",
        `T="$HOME/${TOOLS_DIR}"`,
        `mkdir -p "$T/bin" ${dir}`,
        'tmp=$(mktemp -d "${TMPDIR:-/tmp}/pi-phone-tool.XXXXXX")',
        "trap 'rm -rf \"$tmp\"' EXIT",
        'if command -v curl >/dev/null 2>&1; then fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }',
        'elif command -v wget >/dev/null 2>&1; then fetch() { wget -q -O "$2" "$1"; }',
        'else echo "This machine has neither curl nor wget to download with." >&2; exit 3; fi',
        'if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d" " -f1; }',
        'elif command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d" " -f1; }',
        'else echo "This machine has neither sha256sum nor shasum to check the download with." >&2; exit 3; fi',
        ...(packs.includes("J") ? ['if ! command -v xz >/dev/null 2>&1; then echo "This machine has no xz to unpack the .tar.xz download with." >&2; exit 3; fi'] : []),
        ...downloads.flatMap((download) => [
            `fetch ${q(download.url)} "${download.path}"`,
            `got=$(sum "${download.path}")`,
            `if [ "$got" != ${q(download.sha256)} ]; then echo "The download's sha256 is $got, not ${download.sha256}: nothing was installed." >&2; exit 4; fi`,
        ]),
        ...(whole
            ? [
                  `rm -rf ${dir}/files && mkdir -p ${dir}/files`,
                  ...(packOf(asset.url) === "zip"
                      ? [
                            // Unzip keeps the programs' modes; Python's zipfile does not, so they are set after.
                            `if command -v unzip >/dev/null 2>&1; then unzip -q "$tmp/download" -d ${dir}/files;`,
                            `elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$tmp/download" ${dir}/files && chmod -R u+x ${dir}/files;`,
                            'else echo "This machine has neither unzip nor python3 to unpack the download with." >&2; exit 3; fi',
                        ]
                      : [`tar -x${packOf(asset.url) === "J" ? "J" : "z"}f "$tmp/download" -C ${dir}/files`]),
                  // A program that needs libraries the machine lacks says which, rather than failing when first run.
                  ...(windows ? [] : [`if command -v ldd >/dev/null 2>&1 && ldd ${dir}/files/${q(asset.member!)} 2>/dev/null | grep -q "not found"; then`]),
                  ...(windows
                      ? []
                      : [
                            `  echo "It needs libraries this machine lacks: $(ldd ${dir}/files/${q(asset.member!)} | grep "not found" | awk '{print $1}' | tr '\\n' ' ')- install them${tool.id === "chrome" ? " (Ubuntu: sudo apt install libnss3 libatk-bridge2.0-0 libgbm1 libasound2t64, or the packages that have them)" : ""}, then install it again." >&2; exit 7; fi`,
                        ]),
              ]
            : [...extract(), ...programs.map((each) => `chmod 755 ${dir}/${each.to}`)]),
        // An npm app: its pinned lockfile, installed by its own Node's npm, every package checked by its integrity, no
        // install scripts; npm's cache is the download folder's, gone after.
        ...(npm === undefined
            ? []
            : [
                  `if [ ! -f ${dir}/app/package-lock.json ]; then echo "${tool.name}'s package-lock.json is not in ${base}/app: nothing was installed." >&2; exit 5; fi`,
                  `(cd ${dir}/app && rm -rf node_modules && ${dir}/files/${q(asset.member!)} ${dir}/files/${q(asset.member!.replace(/bin\/node$/, "lib/node_modules/npm/bin/npm-cli.js"))} ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error --cache "$tmp/npm-cache")`,
              ]),
        // The wrappers, as written (a quoted heredoc expands nothing).
        ...wrappers.flatMap((wrapper) => [
            `cat > "$T/bin/${wrapper.command}.new" <<'PI_PHONE_TOOL_END'`,
            wrapper.text.trimEnd(),
            "PI_PHONE_TOOL_END",
            `chmod 755 "$T/bin/${wrapper.command}.new"`,
            `mv "$T/bin/${wrapper.command}.new" "$T/bin/${wrapper.command}"`,
        ]),
        // Older versions of it go.
        `for old in "$T/${tool.id}"/*; do [ "$old" = "$T/${tool.id}/${tool.version}" ] || rm -rf "$old"; done`,
        `"$T/bin/${tool.command}" ${tool.versionArg ?? "--version"} | head -n 1`,
    ].join("\n");
}

export class MachineTools {
    readonly #places: Places;
    readonly #machine: (id: string) => Machine;
    readonly #record: (id: string, tools: Record<string, string>) => void;
    /** The tools offered: `TOOLS`; tests stand in their own. */
    readonly catalog: readonly ToolSpec[];
    /** Chrome Remote Desktop on the machines (`crd.ts`): installed from here, connected and removed by the app. */
    readonly crd: ChromeRemoteDesktop;

    constructor(
        places: Places,
        machine: (id: string) => Machine,
        /** Keep what is installed on the machine (`Machine.tools`), for the prompt of sessions there. */
        record: (id: string, tools: Record<string, string>) => void,
        catalog: readonly ToolSpec[] = TOOLS,
        /** How Chrome Remote Desktop's scripts run on a machine: through its pi-env daemon, unless a test stands in. */
        crdRun?: CrdRun,
    ) {
        this.#places = places;
        this.#machine = machine;
        this.#record = record;
        this.catalog = catalog;
        this.crd = new ChromeRemoteDesktop((id) => this.#connected(id), crdRun ?? ((found, script, timeout, env) => this.#run(found, script, timeout, env)));
    }

    /** The machine's connected record, or why not. */
    #connected(id: string): Machine & { remote: NonNullable<Machine["remote"]> } {
        const machine = this.#machine(id);

        if (machine.remote === undefined) {
            throw new HttpError(409, `Connect ${machine.name} first.`);
        }

        return machine as Machine & { remote: NonNullable<Machine["remote"]> };
    }

    /** A script run on the machine; `variables` are set for it alone (pi-env sends them in its protocol, on no command line). */
    async #run(machine: Machine & { remote: NonNullable<Machine["remote"]> }, script: string, timeout = 120, variables?: Record<string, string>): Promise<{ code: number; out: string }> {
        const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
        let out = "";
        // On Windows the daemon runs a command line with Git Bash; `sh` may not be on Windows' own PATH.
        const result = await env.exec(
            machine.remote.platform === "windows" ? script : ["sh", "-c", script],
            { cwd: machine.remote.home, timeout, onOutput: (chunk) => (out += chunk), ...(variables === undefined ? {} : { env: variables }) },
            BACKGROUND_CONTEXT,
        );

        if (!result.ok) {
            throw new HttpError(502, `${machine.name}: ${result.error.message}`);
        }

        return { code: result.value.exitCode, out };
    }

    /** Each tool on the machine: installed by pi-phone (which version), the machine's own, or offered. */
    async status(id: string): Promise<ToolStatus[]> {
        const machine = this.#connected(id);
        const target = targetOf(machine);
        const { out } = await this.#run(machine, statusScript(this.catalog), 60);
        // Chrome Remote Desktop, on the machines it is for: read by its own script (Windows PowerShell).
        const crd = this.catalog.some((tool) => tool.installer === "crd") && ChromeRemoteDesktop.supports(machine) ? await this.crd.status(id) : undefined;
        const lines = new Map(
            out
                .split("\n")
                .map((line) => line.trim().split(" "))
                .filter((parts) => parts.length >= 2)
                .map(([tool, state, ...rest]) => [tool!, { state: state!, rest: rest.join(" ") }]),
        );
        const installed: Record<string, string> = {};
        const statuses = this.catalog.map((tool): ToolStatus => {
            if (tool.installer === "crd") {
                const version = crd?.installed === true ? (crd.version ?? "unknown") : undefined;

                if (version !== undefined) {
                    installed[tool.id] = version;
                }

                return {
                    ...toolOffer(tool),
                    supported: crd !== undefined,
                    ...(version === undefined ? {} : { installed: version }),
                    ...(crd === undefined ? {} : { crd: crdWord(crd) }),
                    // Google's current build at its address: installed at any version counts as installed.
                    offered: crd !== undefined && !crd.installed,
                };
            }

            const seen = lines.get(tool.id);
            const supported = target !== undefined && tool.assets[target] !== undefined;
            const version = seen?.state === "installed" ? seen.rest.split(" ")[0] || "unknown" : undefined;
            const own = seen?.state === "own" ? seen.rest : undefined;

            if (version !== undefined) {
                installed[tool.id] = version;
            }

            return {
                id: tool.id,
                name: tool.name,
                version: tool.version,
                description: tool.description,
                size: tool.size,
                desktop: tool.desktop === true,
                optIn: tool.optIn === true,
                windowsOnly: tool.windowsOnly === true,
                supported,
                ...(version === undefined ? {} : { installed: version }),
                ...(own === undefined ? {} : { own }),
                offered: supported && (version === undefined || version !== tool.version) && !(tool.onlyIfMissing === true && own !== undefined),
            };
        });

        this.#record(id, installed);

        return statuses;
    }

    /**
     * Install the tools named, one after another, each checked before it is kept: what each said. A tool the machine has
     * no build of is refused by name. The tools one needs come first, when they are not installed at their versions; one
     * whose needs did not install is not tried. Skills go with OfficeCLI; an npm app's lockfile goes before its script.
     */
    async install(id: string, ids: readonly string[]): Promise<{ results: InstallResult[]; tools: ToolStatus[] }> {
        const machine = this.#connected(id);
        const target = targetOf(machine);
        const results: InstallResult[] = [];
        const unknown = ids.find((toolId) => !this.catalog.some((each) => each.id === toolId));

        if (unknown !== undefined) {
            throw new HttpError(400, `No tool "${unknown}". The tools are ${this.catalog.map((each) => each.id).join(", ")}.`);
        }

        const needy = ids.some((toolId) => (this.catalog.find((each) => each.id === toolId)!.needs ?? []).length > 0);
        const order = installOrder(ids, needy ? await this.status(id) : [], this.catalog);

        for (const toolId of order) {
            const tool = this.catalog.find((each) => each.id === toolId)!;
            const missing = (tool.needs ?? []).filter((need) => results.some((result) => result.id === need && !result.ok));

            if (missing.length > 0) {
                results.push({ id: tool.id, ok: false, said: `${tool.name} needs ${missing.join(", ")}, which did not install.` });
                continue;
            }

            if (tool.installer === "crd") {
                if (!ChromeRemoteDesktop.supports(machine)) {
                    results.push({ id: tool.id, ok: false, said: `${tool.name} is for your own Windows x64 machines for now; ${machine.name} is ${machine.remote.platform} ${machine.remote.arch}.` });
                    continue;
                }

                const done = await this.crd.install(machine.id);

                results.push({ id: tool.id, ok: done.ok, ...(done.ok ? { version: done.state?.version ?? "unknown" } : {}), said: done.said });
                continue;
            }

            const asset = target === undefined ? undefined : tool.assets[target];

            if (asset === undefined) {
                results.push({ id: tool.id, ok: false, said: `${tool.name} has no build for ${machine.remote.platform} ${machine.remote.arch}.` });
                continue;
            }

            if (tool.npm !== undefined) {
                await this.#placeApp(machine, tool, tool.npm.dir);
            }

            const { code, out } = await this.#run(
                machine,
                installScript(tool, asset, machine.remote.home, machine.remote.platform === "windows"),
                tool.npm === undefined ? 600 : 1200,
            );
            const said = out.trim().split("\n").slice(-6).join("\n");

            if (code !== 0) {
                results.push({ id: tool.id, ok: false, said: said || `exit ${code}` });
                continue;
            }

            if (tool.skills !== undefined) {
                await this.#placeSkills(machine, tool);
            }

            results.push({ id: tool.id, ok: true, version: tool.version, said: said.split("\n").at(-1) ?? "" });
        }

        return { results, tools: await this.status(id) };
    }

    /**
     * Chrome Remote Desktop alone, installed (Pi's card) or removed (the card, or the row): its result, and the machine's
     * record of tools kept up to date without reading the other tools again.
     */
    async installCrd(id: string): Promise<InstallResult> {
        const done = await this.crd.install(id);

        if (done.state !== undefined) {
            this.#keepCrd(id, done.state.installed ? (done.state.version ?? "unknown") : undefined);
        }

        return { id: CRD_TOOL.id, ok: done.ok, ...(done.ok ? { version: done.state?.version ?? "unknown" } : {}), said: done.said };
    }

    async removeCrd(id: string): Promise<CrdState> {
        const state = await this.crd.remove(id);

        this.#keepCrd(id, undefined);

        return state;
    }

    #keepCrd(id: string, version: string | undefined): void {
        const { [CRD_TOOL.id]: _old, ...others } = this.#machine(id).tools ?? {};

        this.#record(id, version === undefined ? others : { ...others, [CRD_TOOL.id]: version });
    }

    /** An npm app's package.json and package-lock.json, from the phone's copy, in `<tool>/<version>/app/` there. */
    async #placeApp(machine: Machine & { remote: NonNullable<Machine["remote"]> }, tool: ToolSpec, dir: string): Promise<void> {
        const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
        const remote = `${machine.remote.home}/${TOOLS_DIR}/${tool.id}/${tool.version}/app`;
        const made = await env.createDir(remote, { recursive: true }, BACKGROUND_CONTEXT);

        if (!made.ok) {
            throw new HttpError(502, `Could not make ${remote} on ${machine.name}: ${made.error.message}`);
        }

        for (const name of ["package.json", "package-lock.json"]) {
            const written = await env.writeFile(`${remote}/${name}`, readFileSync(resolve(APP_ROOT, dir, name)), BACKGROUND_CONTEXT);

            if (!written.ok) {
                throw new HttpError(502, `Could not copy ${tool.name}'s ${name} to ${machine.name}: ${written.error.message}`);
            }
        }
    }

    /** A tool's skills, from the phone's copy, beside it on the machine: `<tool>/<version>/skills/`. */
    async #placeSkills(machine: Machine & { remote: NonNullable<Machine["remote"]> }, tool: ToolSpec): Promise<void> {
        const work = mkdtempSync(join(tmpdir(), "tool-skills-"));

        try {
            const archive = join(work, "skills.tar.gz");

            execFileSync("tar", ["-czf", archive, "-C", resolve(APP_ROOT, tool.skills!), "."]);
            const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
            const remote = `${machine.remote.home}/${TOOLS_DIR}/${tool.id}/${tool.version}/skills.tar.gz`;
            const written = await env.writeFile(remote, readFileSync(archive), BACKGROUND_CONTEXT);

            if (!written.ok) {
                throw new HttpError(502, `Could not copy ${tool.name}'s skills to ${machine.name}: ${written.error.message}`);
            }

            const { code, out } = await this.#run(
                machine,
                [
                    "set -e",
                    `D="$HOME/${TOOLS_DIR}/${tool.id}/${tool.version}"`,
                    'rm -rf "$D/skills"',
                    'mkdir -p "$D/skills"',
                    'tar -xzf "$D/skills.tar.gz" -C "$D/skills"',
                    'rm -f "$D/skills.tar.gz"',
                ].join("\n"),
            );

            if (code !== 0) {
                throw new HttpError(502, `Could not unpack ${tool.name}'s skills on ${machine.name}: ${out.trim()}`);
            }
        } finally {
            rmSync(work, { recursive: true, force: true });
        }
    }
}

/**
 * The order to install tools in: each one's needs before it (once), unless the machine has them at their versions
 * (`statuses`, `installed`); then the tool.
 */
export function installOrder(ids: readonly string[], statuses: readonly ToolStatus[], catalog: readonly ToolSpec[] = TOOLS): string[] {
    const order: string[] = [];
    const current = (toolId: string) => {
        const status = statuses.find((each) => each.id === toolId);

        return status !== undefined && status.installed === status.version;
    };

    for (const toolId of ids) {
        for (const need of catalog.find((each) => each.id === toolId)?.needs ?? []) {
            if (!order.includes(need) && !current(need)) {
                order.push(need);
            }
        }

        if (!order.includes(toolId)) {
            order.push(toolId);
        }
    }

    return order;
}

/**
 * What the environment section of a session on a machine says of the tools pi-phone installed there (`Machine.tools`):
 * which, at which versions, and how to use those that need it (OfficeCLI never updates itself; how HyperFrames renders).
 */
export function toolsNote(tools: Readonly<Record<string, string>>): string | undefined {
    // Chrome Remote Desktop is Google's host, a service, not a command on the PATH.
    const onPath = Object.entries(tools).filter(([tool]) => tool !== CRD_TOOL.id);

    if (Object.keys(tools).length === 0) {
        return undefined;
    }

    const hyperframes = tools[HYPERFRAMES_TOOL.id];

    return [
        ...(onPath.length === 0
            ? []
            : [
                  `pi-phone installed these tools there, first on bash's PATH (~/${TOOLS_BIN}): ${onPath
                      .map(([tool, version]) => `${tool} ${version}`)
                      .join(", ")}.`,
              ]),
        ...(tools[CRD_TOOL.id] === undefined ? [] : ["Chrome Remote Desktop's host (Google's) is installed there: the owner can unlock and see it from their phone."]),
        ...(tools.officecli === undefined ? [] : ["officecli never installs or updates itself: never run its installers or officecli install."]),
        ...(hyperframes === undefined
            ? []
            : [
                  "HyperFrames renders an HTML and GSAP composition to MP4 here: `hyperframes render <project folder> -o <folder>/<name>.mp4` (the folder holds index.html, the root composition; `-c <file>.html` renders one file of it), into the working directory unless the person names a place; check the result with ffprobe (duration, fps, size), and copy it to the phone with machine_copy when they want it there.",
                  `Its guide to writing compositions is ~/${TOOLS_DIR}/hyperframes/${hyperframes}/app/node_modules/hyperframes/dist/skills/hyperframes/SKILL.md: read it before writing one. Run \`hyperframes\`, never \`npx hyperframes\` (that fetches another version, with its telemetry on), also where the guide says npx. Its telemetry, update checks, and self-installs are off: never turn them on.`,
              ]),
    ].join(" ");
}

/** Where a tool's skills are on a machine, for the prompt of sessions there. */
export function machineSkillsDir(home: string, tool: ToolSpec, version: string): string {
    return `${home}/${TOOLS_DIR}/${tool.id}/${version}/skills`;
}
