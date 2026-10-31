/**
 * Pi's browser on a machine (owner's decisions of 2026-10-20): for a session working there, a headless Chrome on that
 * machine, reached through an ssh forward of its DevTools port (`forwards.ts`, as the Ports sheet opens ports). The
 * machine's own Chrome or Chromium (or Edge on Windows) when it has one, else the "Chrome (headless)" machine tool
 * (`machine-tools.ts`). Its profile stays in `~/.pi/mobile/browser` (sign-ins last, as on the phone), and Chrome keeps
 * running between Pi's actions and across server restarts. It may open the machine's own addresses (its dev servers):
 * it has no pi-phone sign-in to misuse.
 *
 * Window mode (PP-274, the machine's setting `browser.machineMode`): the same Chrome and profile, started without
 * `--headless`, as a window on the machine's screen that the owner can watch and use there. On Linux in the desktop the
 * machine's desktop setup line names (computer control's, `DISPLAY` and the rest); on Windows in the owner's signed-in
 * desktop session (sshd's commands run in session 0, which has no screen) through a one-shot scheduled task, as
 * computer control's bridge (PP-179) gets there; macOS later.
 */
import http from "node:http";
import { encodePowerShell } from "../computer-windows.ts";
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

/** The machine's window mode setting, its system, and its desktop setup line, as they are now (PP-274). */
export type WindowOptions = { mode?: () => MachineBrowserMode; platform?: string; prepare?: () => string };

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
    return [`P="$HOME/${BROWSER_DIR}"`, ...STOP, 'rm -f "$P/mode"', "true"].join("\n");
}

/** How a machine's Chrome runs (`browser.machineMode`): headless (the default), or as a window on its screen. */
export type MachineBrowserMode = "headless" | "window";
export const MACHINE_BROWSER_MODES: readonly MachineBrowserMode[] = ["headless", "window"];

/**
 * Flags that keep a window's page drawing and its timers running while the window is covered or minimised: the panel's
 * frames come from it.
 */
export const WINDOW_FLAGS = "--disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling";

/** How the launch script ends when window mode cannot start, besides 5 (no Chrome) and 6 (Chrome did not start). */
export const LAUNCH_EXIT = { noDisplay: 7, shellOnly: 8, notLoggedOn: 21, locked: 23 } as const;

/** The one-shot task that starts Chrome in the owner's desktop session on Windows; removed once Chrome runs. */
export const WINDOWS_BROWSER_TASK = "pi-phone browser";

/**
 * The PowerShell that starts Chrome as a window in the owner's signed-in desktop session on Windows (PP-274): a
 * scheduled task as the user, Interactive ("only when the user is logged on": no password) and Limited (never elevated),
 * started once and unregistered as soon as Chrome wrote its DevTools port. Chrome's path, its profile and its flags come
 * in `PI_CHROME`, `PI_PROFILE` and `PI_FLAGS`. Exits 21 when nobody is signed in to a desktop, 23 when it is locked.
 */
export function windowsWindowCommands(): string {
    return [
        "$ErrorActionPreference = 'Stop'",
        "$ProgressPreference = 'SilentlyContinue'",
        "$desks = @(Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | Where-Object { $_.SessionId -gt 0 -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq $env:USERNAME })",
        "$sessions = @($desks | ForEach-Object { $_.SessionId })",
        `if ($sessions.Count -eq 0) { exit ${LAUNCH_EXIT.notLoggedOn} }`,
        `if (@(Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $sessions -contains $_.SessionId }).Count -gt 0) { exit ${LAUNCH_EXIT.locked} }`,
        "$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name",
        "$arguments = ('--remote-debugging-port=0 --user-data-dir=\"{0}\" --no-first-run --no-default-browser-check {1} about:blank' -f $env:PI_PROFILE, $env:PI_FLAGS)",
        "$action = New-ScheduledTaskAction -Execute $env:PI_CHROME -Argument $arguments",
        "$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited",
        "$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew",
        `Register-ScheduledTask -TaskName '${WINDOWS_BROWSER_TASK}' -Description 'pi-phone: starts Pi''s browser as a window in your desktop session, once; removed right after.' -Action $action -Principal $principal -Settings $settings -Force | Out-Null`,
        "try {",
        `  Start-ScheduledTask -TaskName '${WINDOWS_BROWSER_TASK}'`,
        "  $port = Join-Path $env:PI_PROFILE 'DevToolsActivePort'",
        "  for ($i = 0; $i -lt 100 -and -not (Test-Path -LiteralPath $port); $i++) { Start-Sleep -Milliseconds 200 }",
        "} finally {",
        `  Unregister-ScheduledTask -TaskName '${WINDOWS_BROWSER_TASK}' -Confirm:$false -ErrorAction SilentlyContinue`,
        "}",
    ].join("\n");
}

/** How the launch script is made: the mode, the machine's system, and its desktop setup line (Linux, window mode). */
export type LaunchOptions = { mode?: MachineBrowserMode; windows?: boolean; prepare?: string };

/**
 * The script that finds Chrome on the machine and starts it with a DevTools port, unless it runs already in this mode:
 * its last line is `port <n>`, or it exits 5 with `nochrome` when the machine has none, or 6 with the end of Chrome's
 * log; in window mode, with one of `LAUNCH_EXIT` when it cannot show a window.
 */
export function launchScript({ mode = "headless", windows = false, prepare = "" }: LaunchOptions = {}): string {
    const window = mode === "window";

    return [
        `P="$HOME/${BROWSER_DIR}"`,
        `MODE=${mode}`,
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
        // Running in the other mode (the setting changed while pi-phone was away): stopped, and started in this one.
        'if alive && [ "$(cat "$P/mode" 2>/dev/null || echo headless)" = "$MODE" ]; then echo "port $D"; exit 0; fi',
        // A Chrome still holding this profile whose DevTools do not answer (its port file lost, or stuck) is stopped: a new
        // one could not take the profile.
        ...STOP,
        'rm -f "$P/mode"',
        // Uploads a day old go.
        'find "$P/uploads" -mindepth 1 -maxdepth 1 -mtime +0 -exec rm -rf {} + 2>/dev/null || true',
        // Linux, window mode: the desktop the machine's setup line names (computer control's), before Chrome is looked
        // for, as it may set PATH too; it must give a display.
        ...(window && !windows && prepare.trim() !== "" ? [prepare.trim()] : []),
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
        // The headless shell has no window to show.
        ...(window ? [`case "$C" in *chrome-headless-shell*) echo "shellonly $C"; exit ${LAUNCH_EXIT.shellOnly};; esac`] : []),
        ...(window && windows
            ? [
                  // Windows: in the owner's desktop session, through a one-shot task (sshd's session 0 has no screen).
                  'if ! command -v cygpath >/dev/null 2>&1 || ! command -v powershell.exe >/dev/null 2>&1; then echo "A window on Windows starts through Git Bash and Windows PowerShell, which this machine lacks."; exit 6; fi',
                  `export PI_CHROME="$(cygpath -w "$C")" PI_PROFILE="$(cygpath -w "$P/profile")" PI_FLAGS="${WINDOW_FLAGS}"`,
                  `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encodePowerShell(windowsWindowCommands())} >"$P/chrome.log" 2>&1 </dev/null`,
                  "W=$?",
                  `if [ $W -eq ${LAUNCH_EXIT.notLoggedOn} ]; then echo notloggedon; exit ${LAUNCH_EXIT.notLoggedOn}; fi`,
                  `if [ $W -eq ${LAUNCH_EXIT.locked} ]; then echo locked; exit ${LAUNCH_EXIT.locked}; fi`,
                  'if [ $W -ne 0 ] || [ ! -s "$P/profile/DevToolsActivePort" ]; then echo "Chrome ($C) did not start in your desktop session (exit $W):"; tail -n 6 "$P/chrome.log"; exit 6; fi',
                  // Still there once its task is gone, and answering.
                  "sleep 1",
                  'if ! alive; then echo "Chrome ($C) started in your desktop session, but its DevTools do not answer:"; tail -n 6 "$P/chrome.log"; exit 6; fi',
              ]
            : [
                  ...(window ? [`if [ -z "$DISPLAY" ] && [ -z "$WAYLAND_DISPLAY" ]; then echo nodisplay; exit ${LAUNCH_EXIT.noDisplay}; fi`] : []),
                  // Chrome refuses to run as root with its sandbox; the headless shell is headless already.
                  'F=""; [ "$(id -u 2>/dev/null)" = "0" ] && F="--no-sandbox"',
                  window ? `H="${WINDOW_FLAGS}"` : 'case "$C" in *chrome-headless-shell*) H="--disable-gpu";; *) H="--headless=new --disable-gpu";; esac',
                  'S=""; command -v setsid >/dev/null 2>&1 && S=setsid',
                  "start() {",
                  '  ( $S "$C" $H $F --remote-debugging-port=0 --user-data-dir="$P/profile" --no-first-run --no-default-browser-check about:blank >"$P/chrome.log" 2>&1 </dev/null & echo $! >"$P/chrome.pid" )',
                  "  i=0",
                  '  while [ $i -lt 200 ] && [ ! -s "$P/profile/DevToolsActivePort" ] && kill -0 "$(cat "$P/chrome.pid")" 2>/dev/null; do sleep 0.2; i=$((i+1)); done',
                  "}",
                  "start",
                  // Ubuntu 23.10+ lets only Chrome installed as a package (with its AppArmor profile) use its sandbox; the
                  // headless shell from the machine tools then runs without it, and says so.
                  'if [ ! -s "$P/profile/DevToolsActivePort" ] && grep -q "No usable sandbox" "$P/chrome.log" 2>/dev/null; then F="--no-sandbox"; echo nosandbox; start; fi',
                  'if [ ! -s "$P/profile/DevToolsActivePort" ]; then echo "Chrome ($C) did not start:"; tail -n 6 "$P/chrome.log"; exit 6; fi',
              ]),
        'echo "$MODE" >"$P/mode"',
        'echo "port $(head -n 1 "$P/profile/DevToolsActivePort")"',
    ].join("\n");
}

/** Why a launch failed, from its exit and output: for Pi and the panel, naming what to do. */
export function launchProblem(name: string, code: number, out: string): string {
    if (code === 5) {
        return `${name} has no Chrome: install "Chrome (headless)" in Settings › Machines › ${name} › Install tools, or Google Chrome there.`;
    }

    if (code === LAUNCH_EXIT.shellOnly) {
        return `${name} has only the headless Chrome (the "Chrome (headless)" machine tool), which cannot show a window: install Google Chrome, Chromium or Edge there, or set Pi's browser on ${name} to headless in Settings › Machines.`;
    }

    if (code === LAUNCH_EXIT.noDisplay) {
        return `${name} has no display for Pi's browser's window: give its desktop setup line in Menu › Computer control (it sets DISPLAY, as for computer control), sign in to its desktop, or set Pi's browser on ${name} to headless in Settings › Machines.`;
    }

    if (code === LAUNCH_EXIT.notLoggedOn) {
        return `Nobody is signed in to ${name}'s desktop, so Pi's browser cannot open a window there: sign in on the computer first, or set Pi's browser on ${name} to headless in Settings › Machines.`;
    }

    if (code === LAUNCH_EXIT.locked) {
        return `${name}'s screen is locked, so Pi's browser's window would open where nobody sees it: unlock it first (with Chrome Remote Desktop from your phone, if it is set up), or set Pi's browser on ${name} to headless in Settings › Machines.`;
    }

    return `Could not start Chrome on ${name}: ${out.trim() || `exit ${code}`}`;
}

/** An HTTP request to a Chrome's DevTools on `port` here (a forward's end): its answer's body. */
export const request = (port: number, path: string, method = "GET"): Promise<string> =>
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
    readonly #window: WindowOptions;
    /** The forward of Chrome's DevTools port, while it lasts, and the mode Chrome was started in. */
    #forward: { port: number; remote: number; mode: MachineBrowserMode; close(): void } | undefined;
    #starting: Promise<number> | undefined;

    /** `window`: the machine's setting `browser.machineMode` now, its system, and its desktop setup line (PP-274). */
    constructor(machine: MachineAccess, window: WindowOptions = {}) {
        this.#machine = machine;
        this.#window = window;
        this.label = `Chrome on ${machine.name}`;
    }

    #mode(): MachineBrowserMode {
        return this.#window.mode?.() ?? "headless";
    }

    /** In window mode, the machine whose screen shows it: someone there may use the window (PP-274). */
    get visibleOn(): string | undefined {
        return this.#mode() === "window" ? this.#machine.name : undefined;
    }

    /** Chrome asks about no window: it opens one a click opens, and blocks one without. */
    watchWindows(): () => void {
        return () => {};
    }

    /** Chrome's DevTools port here: started on the machine if it is not running, and forwarded. */
    #port(): Promise<number> {
        this.#starting ??= (async () => {
            const mode = this.#mode();

            // A Chrome started in the other mode is started again in this one (the launch script stops it).
            if (this.#forward !== undefined && this.#forward.mode !== mode) {
                this.#forward.close();
                this.#forward = undefined;
            }

            if (this.#forward !== undefined) {
                try {
                    await request(this.#forward.port, "/json/version");

                    return this.#forward.port;
                } catch {
                    this.#forward.close();
                    this.#forward = undefined;
                }
            }

            if (mode === "window" && this.#window.platform === "darwin") {
                throw new Error(`Pi's browser as a window on macOS is not built yet: set Pi's browser on ${this.#machine.name} to headless in Settings › Machines.`);
            }

            const script = launchScript({ mode, windows: this.#window.platform === "windows", prepare: mode === "window" ? (this.#window.prepare?.() ?? "") : "" });
            const { code, out } = await this.#machine.run(script, 90);
            const port = Number(/^port (\d+)\s*$/m.exec(out)?.[1]);

            if (code !== 0 || !Number.isInteger(port) || port <= 0) {
                throw new Error(launchProblem(this.#machine.name, code, out));
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

            this.#forward = { port: forward.port, remote: port, mode, close: forward.close };

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
