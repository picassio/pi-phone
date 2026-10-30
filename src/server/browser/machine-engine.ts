/**
 * Pi's browser on a machine (owner's decisions of 2026-10-20): for a session working there, a headless Chrome on that
 * machine, reached through an ssh forward of its DevTools port (`forwards.ts`, as the Ports sheet opens ports). The
 * machine's own Chrome or Chromium (or Edge on Windows) when it has one, else the "Chrome (headless)" machine tool
 * (`machine-tools.ts`). Its profile stays in `~/.pi/mobile/browser` (sign-ins last, as on the phone), and Chrome keeps
 * running between Pi's actions and across server restarts. It may open the machine's own addresses (its dev servers):
 * it has no pi-phone sign-in to misuse.
 */
import http from "node:http";
import { Cdp } from "./cdp.ts";
import type { BrowserPage, PictureOptions } from "./page.ts";
import type { BrowserEngine } from "./pi-browser.ts";

/** What the engine needs of the machine: run a script there, write a file there, and open one of its ports here. */
export type MachineAccess = {
    /** The machine's name, for messages. */
    name: string;
    /** Its home, as its paths are written (`/home/me`, `C:/Users/me`). */
    home: string;
    /** Run a script there with sh (Git Bash on Windows): its exit code and output. */
    run(script: string, timeoutSeconds: number): Promise<{ code: number; out: string }>;
    writeFile(path: string, bytes: Uint8Array): Promise<void>;
    /** Port `port` of the machine, open here: the port here, and how to close it. */
    forward(port: number): Promise<{ port: number; close(): void }>;
};

/** Where the browser keeps its things on the machine, under its home. */
export const BROWSER_DIR = ".pi/mobile/browser";

/**
 * Stop every Chrome started on the browser's profile (`$P/profile`, pi-phone's own), and forget its port: by its
 * command line, not a pid file (on Windows, Git Bash cannot see a pid an earlier shell started). Then its locks go.
 */
const STOP = [
    "if command -v powershell.exe >/dev/null 2>&1; then",
    `  powershell.exe -NoProfile -Command 'Get-CimInstance Win32_Process | Where-Object { $_.Name -match "chrome|msedge" -and $_.CommandLine -like "*mobile*browser*profile*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }' >/dev/null 2>&1 && sleep 1`,
    "else",
    '  pkill -f -- "user-data-dir=$P/profile" 2>/dev/null && sleep 1',
    "fi",
    'rm -f "$P/profile/DevToolsActivePort" "$P/chrome.pid" "$P/profile/SingletonLock" "$P/profile/SingletonSocket" "$P/profile/SingletonCookie"',
];

/** The script that stops the browser's Chrome on the machine (its profile stays). */
export function stopScript(): string {
    return [`P="$HOME/${BROWSER_DIR}"`, ...STOP, "true"].join("\n");
}

/**
 * The script that finds Chrome on the machine and starts it with a DevTools port, unless it runs already: its last line
 * is `port <n>`, or it exits 5 with `nochrome` when the machine has none, or 6 with the end of Chrome's log.
 */
export function launchScript(): string {
    return [
        `P="$HOME/${BROWSER_DIR}"`,
        'mkdir -p "$P/profile" "$P/uploads"',
        // Running already when its DevTools answer on the port it wrote. Not by its pid: on Windows, Git Bash cannot see
        // a pid an earlier shell started, and a second Chrome on the profile then aborts ("Lock file can not be
        // created", tualh-laptop, 2026-10-20 and 2026-10-26). Without curl, by the pid, as before.
        "alive() {",
        '  [ -s "$P/profile/DevToolsActivePort" ] || return 1',
        '  D=$(head -n 1 "$P/profile/DevToolsActivePort")',
        '  if command -v curl >/dev/null 2>&1; then curl -sf -m 3 "http://127.0.0.1:$D/json/version" >/dev/null 2>&1; return $?; fi',
        '  [ -f "$P/chrome.pid" ] && kill -0 "$(cat "$P/chrome.pid")" 2>/dev/null',
        "}",
        'if alive; then echo "port $D"; exit 0; fi',
        // A Chrome still holding this profile whose DevTools do not answer (its port file lost, or stuck) is stopped: a new
        // one could not take the profile.
        ...STOP,
        // Uploads a day old go.
        'find "$P/uploads" -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
        'C=""',
        'for c in google-chrome google-chrome-stable chromium chromium-browser; do',
        '  if command -v "$c" >/dev/null 2>&1; then C=$(command -v "$c"); break; fi',
        "done",
        'if [ -z "$C" ]; then',
        '  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" \\',
        '    "/c/Program Files/Google/Chrome/Application/chrome.exe" "/c/Program Files (x86)/Google/Chrome/Application/chrome.exe" \\',
        '    "$HOME/AppData/Local/Google/Chrome/Application/chrome.exe" \\',
        '    "/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" "/c/Program Files/Microsoft/Edge/Application/msedge.exe"; do',
        '    if [ -x "$c" ]; then C="$c"; break; fi',
        "  done",
        "fi",
        // The machine tool's headless shell, run from among its files (not through its wrapper, so the pid is Chrome's).
        'if [ -z "$C" ]; then',
        '  for c in "$HOME"/.pi/mobile/tools/chrome/*/files/*/chrome-headless-shell "$HOME"/.pi/mobile/tools/chrome/*/files/*/chrome-headless-shell.exe; do',
        '    if [ -f "$c" ] && [ -x "$c" ]; then C="$c"; fi',
        "  done",
        "fi",
        'if [ -z "$C" ]; then echo nochrome; exit 5; fi',
        // Chrome refuses to run as root with its sandbox; the headless shell is headless already.
        'F=""; [ "$(id -u 2>/dev/null)" = "0" ] && F="--no-sandbox"',
        'case "$C" in *chrome-headless-shell*) H="";; *) H="--headless=new";; esac',
        'S=""; command -v setsid >/dev/null 2>&1 && S=setsid',
        "start() {",
        '  ( $S "$C" $H $F --remote-debugging-port=0 --user-data-dir="$P/profile" --no-first-run --no-default-browser-check --disable-gpu about:blank >"$P/chrome.log" 2>&1 </dev/null & echo $! >"$P/chrome.pid" )',
        "  i=0",
        '  while [ $i -lt 200 ] && [ ! -s "$P/profile/DevToolsActivePort" ] && kill -0 "$(cat "$P/chrome.pid")" 2>/dev/null; do sleep 0.2; i=$((i+1)); done',
        "}",
        "start",
        // Ubuntu 23.10+ lets only Chrome installed as a package (with its AppArmor profile) use its sandbox; the headless
        // shell from the machine tools then runs without it, and says so.
        'if [ ! -s "$P/profile/DevToolsActivePort" ] && grep -q "No usable sandbox" "$P/chrome.log" 2>/dev/null; then F="--no-sandbox"; echo nosandbox; start; fi',
        'if [ ! -s "$P/profile/DevToolsActivePort" ]; then echo "Chrome ($C) did not start:"; tail -n 6 "$P/chrome.log"; exit 6; fi',
        'echo "port $(head -n 1 "$P/profile/DevToolsActivePort")"',
    ].join("\n");
}

const request = (port: number, path: string, method = "GET"): Promise<string> =>
    new Promise((resolve, reject) => {
        const sent = http.request({ host: "127.0.0.1", port, path, method, headers: { host: `127.0.0.1:${port}` }, timeout: 8000 }, (response) => {
            let body = "";

            response.on("data", (chunk: Buffer) => (body += chunk.toString()));
            response.on("end", () => resolve(body));
        });

        sent.on("error", reject);
        sent.on("timeout", () => sent.destroy(new Error("Chrome did not answer in time.")));
        sent.end();
    });

export class MachineEngine implements BrowserEngine {
    readonly label: string;
    readonly popups = true;
    readonly asksWindows = false;
    readonly local = true;
    readonly actAsPhone = true;
    readonly reopensToResize = false;
    readonly #machine: MachineAccess;
    /** The forward of Chrome's DevTools port, while it lasts. */
    #forward: { port: number; remote: number; close(): void } | undefined;
    #starting: Promise<number> | undefined;

    constructor(machine: MachineAccess) {
        this.#machine = machine;
        this.label = `Chrome on ${machine.name}`;
    }

    /** Chrome asks about no window: it opens one a click opens, and blocks one without. */
    watchWindows(): () => void {
        return () => {};
    }

    /** Chrome's DevTools port here: started on the machine if it is not running, and forwarded. */
    #port(): Promise<number> {
        this.#starting ??= (async () => {
            if (this.#forward !== undefined) {
                try {
                    await request(this.#forward.port, "/json/version");

                    return this.#forward.port;
                } catch {
                    this.#forward.close();
                    this.#forward = undefined;
                }
            }

            const { code, out } = await this.#machine.run(launchScript(), 90);
            const port = Number(/^port (\d+)\s*$/m.exec(out)?.[1]);

            if (code === 5) {
                throw new Error(
                    `${this.#machine.name} has no Chrome: install "Chrome (headless)" in Settings › Machines › ${this.#machine.name} › Install tools, or Google Chrome there.`,
                );
            }

            if (code !== 0 || !Number.isInteger(port) || port <= 0) {
                throw new Error(`Could not start Chrome on ${this.#machine.name}: ${out.trim() || `exit ${code}`}`);
            }

            const forward = await this.#machine.forward(port);

            // Chrome answers through the forward, or this says where it broke (not a bare "socket hang up" later).
            try {
                await request(forward.port, "/json/version");
            } catch (error) {
                forward.close();

                throw new Error(
                    `Chrome runs on ${this.#machine.name} (DevTools port ${port}), but it did not answer through the ssh forward: ${error instanceof Error ? error.message : String(error)}`,
                );
            }

            this.#forward = { port: forward.port, remote: port, close: forward.close };

            return forward.port;
        })().finally(() => {
            this.#starting = undefined;
        });

        return this.#starting;
    }

    async #list(): Promise<{ id: string; type: string }[]> {
        const port = await this.#port();

        return JSON.parse(await request(port, "/json/list")) as { id: string; type: string }[];
    }

    async tabs(): Promise<string[]> {
        // Chrome lists the newest first.
        return (await this.#list())
            .filter((each) => each.type === "page")
            .map((each) => each.id)
            .reverse();
    }

    async newTab(): Promise<string> {
        const port = await this.#port();

        return (JSON.parse(await request(port, "/json/new?about:blank", "PUT")) as { id: string }).id;
    }

    async connect(id: string): Promise<Cdp> {
        return Cdp.connect({ url: `ws://127.0.0.1:${await this.#port()}/devtools/page/${id}` });
    }

    async closeTab(id: string): Promise<void> {
        await request(await this.#port(), `/json/close/${id}`);

        // Chrome closes it a moment later: until then it is still listed, and would be taken for a tab a page opened.
        const until = Date.now() + 5000;

        while (Date.now() < until && (await this.#list()).some((each) => each.id === id)) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    /** Stop Chrome on the machine (its profile stays) and the forward. */
    async close(): Promise<void> {
        this.#forward?.close();
        this.#forward = undefined;
        await this.#machine.run(stopScript(), 30);
    }

    async pdf(_id: string, page: BrowserPage): Promise<Buffer> {
        const printed = await page.cdp.send<{ data: string }>("Page.printToPDF", { printBackground: true });

        return Buffer.from(printed.data, "base64");
    }

    picture(_id: string, page: BrowserPage, quality: number, timeoutMs?: number, options?: PictureOptions): Promise<string> {
        return page.screenshot(quality, timeoutMs, options);
    }

    /** On the machine, where its Chrome reads it. */
    async stage(name: string, bytes: Uint8Array): Promise<string> {
        const path = `${this.#machine.home}/${BROWSER_DIR}/uploads/${crypto.randomUUID()}/${name.replace(/[/\\]/g, "_")}`;

        await this.#machine.writeFile(path, bytes);

        return path;
    }
}
