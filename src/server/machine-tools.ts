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
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { APP_ROOT } from "./config.ts";
import { HttpError } from "./errors.ts";
import type { Machine } from "./machines.ts";
import type { Places } from "./places.ts";

/** Where the tools live on a machine, under its home. */
export const TOOLS_DIR = ".pi/mobile/tools";
/** The folder on bash's PATH there. */
export const TOOLS_BIN = `${TOOLS_DIR}/bin`;

type Target = `${"linux" | "darwin" | "android" | "windows"}-${"x64" | "arm64"}`;
/** The binary inside a .tar.gz (or a .zip, by the url); absent: the download is the binary. */
type Asset = { url: string; sha256: string; member?: string };

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
    assets: Partial<Record<Target, Asset>>;
};

const OFFICECLI = "https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157";
const RG = "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0";
const FD = "https://github.com/sharkdp/fd/releases/download/v10.5.0";
const CHROME = "https://storage.googleapis.com/chrome-for-testing-public/155.0.8059.84";

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
];

/** One tool on one machine, as the list shows it. */
export type ToolStatus = {
    id: string;
    name: string;
    version: string;
    description: string;
    size: string;
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

/** Status of each tool, from one script: the marker of pi-phone's wrapper, else the machine's own command. */
export function statusScript(catalog: readonly ToolSpec[]): string {
    return [
        `T="$HOME/${TOOLS_DIR}"`,
        ...catalog.map(
            (tool) =>
                `if [ -f "$T/bin/${tool.command}" ]; then echo "${tool.id} installed $(sed -n 's/^# pi-phone-tool [^ ]* //p' "$T/bin/${tool.command}" | head -n 1)"; ` +
                `else own=$(PATH=$(printf %s "$PATH" | tr ':' '\\n' | grep -v "/${TOOLS_BIN}$" | paste -sd: -); for c in ${[tool.command, ...(tool.alsoOwn ?? [])].join(" ")}; do command -v $c 2>/dev/null && break; done | head -n 1); ` +
                (tool.alsoOwnPaths === undefined ? "" : `[ -n "$own" ] || for p in ${tool.alsoOwnPaths.map((path) => `"${path}"`).join(" ")}; do if [ -x "$p" ]; then own="$p"; break; fi; done; `) +
                `if [ -n "$own" ]; then echo "${tool.id} own $own"; else echo "${tool.id} none"; fi; fi`,
        ),
    ].join("\n");
}

/** The wrapper bash runs as the tool's command: its marker names the tool and version (`statusScript`). */
export function wrapperOf(tool: ToolSpec, binary: string): string {
    return [
        "#!/bin/sh",
        `# pi-phone-tool ${tool.id} ${tool.version}`,
        ...Object.entries(tool.env ?? {}).map(([name, value]) => `export ${name}=${q(value)}`),
        // Android's OfficeCLI needs Termux's OpenSSL (Android's own libssl aborts it); elsewhere $PREFIX is unset.
        ...(tool.id === "officecli" ? ['if [ -n "$PREFIX" ] && [ -d "$PREFIX/lib" ]; then export LD_LIBRARY_PATH="$PREFIX/lib"; fi'] : []),
        `exec ${q(binary)} "$@"`,
        "",
    ].join("\n");
}

/** The script that installs one tool's asset, checks it, and writes its wrapper; its last line is the tool's version. */
export function installScript(tool: ToolSpec, asset: Asset, home: string, windows = false): string {
    const dir = `"$T/${tool.id}/${tool.version}"`;
    // On Windows a program keeps its .exe: Windows runs files by it. Git Bash (Pi's shell there) runs the wrapper.
    const file = windows ? `${tool.command}.exe` : tool.command;
    // A whole archive's program stays among its files (Chrome needs those beside it); the wrapper runs it there.
    const program = tool.whole === true && asset.member !== undefined ? `files/${asset.member}` : file;
    const wrapper = wrapperOf(tool, `${home}/${TOOLS_DIR}/${tool.id}/${tool.version}/${program}`);

    if (wrapper.includes("PI_PHONE_TOOL_END")) {
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
        `fetch ${q(asset.url)} "$tmp/download"`,
        `got=$(sum "$tmp/download")`,
        `if [ "$got" != ${q(asset.sha256)} ]; then echo "The download's sha256 is $got, not ${asset.sha256}: nothing was installed." >&2; exit 4; fi`,
        ...(tool.whole === true && asset.member !== undefined
            ? [
                  // Unzip keeps the programs' modes; Python's zipfile does not, so they are set after.
                  `rm -rf ${dir}/files && mkdir -p ${dir}/files`,
                  `if command -v unzip >/dev/null 2>&1; then unzip -q "$tmp/download" -d ${dir}/files;`,
                  `elif command -v python3 >/dev/null 2>&1; then python3 -m zipfile -e "$tmp/download" ${dir}/files && chmod -R u+x ${dir}/files;`,
                  'else echo "This machine has neither unzip nor python3 to unpack the download with." >&2; exit 3; fi',
                  // A program that needs libraries the machine lacks says which, rather than failing when first run.
                  ...(windows ? [] : [`if command -v ldd >/dev/null 2>&1 && ldd ${dir}/files/${q(asset.member)} 2>/dev/null | grep -q "not found"; then`]),
                  ...(windows ? [] : [`  echo "It needs libraries this machine lacks: $(ldd ${dir}/files/${q(asset.member)} | grep "not found" | awk '{print $1}' | tr '\\n' ' ')- install them (Ubuntu: sudo apt install libnss3 libatk-bridge2.0-0 libgbm1 libasound2t64, or the packages that have them), then install it again." >&2; exit 7; fi`]),
              ]
            : asset.member === undefined
            ? [`cp "$tmp/download" ${dir}/${file}`]
            : asset.url.endsWith(".zip")
              ? [`unzip -p "$tmp/download" ${q(asset.member)} > ${dir}/${file}`]
              : [`tar -xzf "$tmp/download" -C "$tmp"`, `cp "$tmp/${asset.member}" ${dir}/${file}`]),
        ...(tool.whole === true ? [] : [`chmod 755 ${dir}/${file}`]),
        // The wrapper, as written (a quoted heredoc expands nothing).
        `cat > "$T/bin/${tool.command}.new" <<'PI_PHONE_TOOL_END'`,
        wrapper.trimEnd(),
        "PI_PHONE_TOOL_END",
        `chmod 755 "$T/bin/${tool.command}.new"`,
        `mv "$T/bin/${tool.command}.new" "$T/bin/${tool.command}"`,
        // Older versions of it go.
        `for old in "$T/${tool.id}"/*; do [ "$old" = "$T/${tool.id}/${tool.version}" ] || rm -rf "$old"; done`,
        `"$T/bin/${tool.command}" --version | head -n 1`,
    ].join("\n");
}

export class MachineTools {
    readonly #places: Places;
    readonly #machine: (id: string) => Machine;
    readonly #record: (id: string, tools: Record<string, string>) => void;
    /** The tools offered: `TOOLS`; tests stand in their own. */
    readonly catalog: readonly ToolSpec[];

    constructor(
        places: Places,
        machine: (id: string) => Machine,
        /** Keep what is installed on the machine (`Machine.tools`), for the prompt of sessions there. */
        record: (id: string, tools: Record<string, string>) => void,
        catalog: readonly ToolSpec[] = TOOLS,
    ) {
        this.#places = places;
        this.#machine = machine;
        this.#record = record;
        this.catalog = catalog;
    }

    /** The machine's connected record, or why not. */
    #connected(id: string): Machine & { remote: NonNullable<Machine["remote"]> } {
        const machine = this.#machine(id);

        if (machine.remote === undefined) {
            throw new HttpError(409, `Connect ${machine.name} first.`);
        }

        return machine as Machine & { remote: NonNullable<Machine["remote"]> };
    }

    async #run(machine: Machine & { remote: NonNullable<Machine["remote"]> }, script: string, timeout = 120): Promise<{ code: number; out: string }> {
        const env = this.#places.env(`machine:${machine.id}:${machine.remote.home}`);
        let out = "";
        // On Windows the daemon runs a command line with Git Bash; `sh` may not be on Windows' own PATH.
        const result = await env.exec(
            machine.remote.platform === "windows" ? script : ["sh", "-c", script],
            { cwd: machine.remote.home, timeout, onOutput: (chunk) => (out += chunk) },
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
        const lines = new Map(
            out
                .split("\n")
                .map((line) => line.trim().split(" "))
                .filter((parts) => parts.length >= 2)
                .map(([tool, state, ...rest]) => [tool!, { state: state!, rest: rest.join(" ") }]),
        );
        const installed: Record<string, string> = {};
        const statuses = this.catalog.map((tool): ToolStatus => {
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
     * no build of, or has its own of (rg, fd), is refused by name. Skills go with OfficeCLI.
     */
    async install(id: string, ids: readonly string[]): Promise<{ results: InstallResult[]; tools: ToolStatus[] }> {
        const machine = this.#connected(id);
        const target = targetOf(machine);
        const results: InstallResult[] = [];

        for (const toolId of ids) {
            const tool = this.catalog.find((each) => each.id === toolId);

            if (tool === undefined) {
                throw new HttpError(400, `No tool "${toolId}". The tools are ${this.catalog.map((each) => each.id).join(", ")}.`);
            }

            const asset = target === undefined ? undefined : tool.assets[target];

            if (asset === undefined) {
                results.push({ id: tool.id, ok: false, said: `${tool.name} has no build for ${machine.remote.platform} ${machine.remote.arch}.` });
                continue;
            }

            const { code, out } = await this.#run(
                machine,
                installScript(tool, asset, machine.remote.home, machine.remote.platform === "windows"),
                600,
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

/** Where a tool's skills are on a machine, for the prompt of sessions there. */
export function machineSkillsDir(home: string, tool: ToolSpec, version: string): string {
    return `${home}/${TOOLS_DIR}/${tool.id}/${version}/skills`;
}
