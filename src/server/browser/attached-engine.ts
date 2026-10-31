/**
 * Pi's browser attached to a browser that runs on a machine already (PP-274, `browser_attach`): Playwright's, agent-browser's,
 * a `chrome --remote-debugging-port=N` Pi started there, or the owner's own Chrome with remote debugging on (started
 * with the flag, or Chrome's own opt-in at `chrome://inspect/#remote-debugging`). Its DevTools are on the machine's
 * loopback (127.0.0.1), reached through the app's ssh forward (`forwards.ts`), as pi-phone's own Chrome on a machine
 * is (`machine-engine.ts`); no other host can be named.
 *
 * Everything goes over the browser's own connection (its endpoint from DevToolsActivePort, or `/json/version`): pages
 * are sessions on it (`Cdp.attach`), as Chrome's opt-in opens no other endpoint. Ideas from howaboua's pi-browser
 * (IgorWarzocha/howaboua-pi-stuff, MIT): Pi owns the tabs it opens (in the background, where the browser has a window),
 * and the windows their pages open (by Chrome's opener); the owner's other tabs are not Pi's, unless Pi takes the open
 * ones on attaching (`tabs: "all"`, for a browser Pi started). Who owns which tab is kept by the browser's identity
 * (`TabOwners`): a browser started again shares its restored tabs again. Detaching (`browser_detach`) leaves the browser
 * and every tab as they are; closing Pi's browser closes only the tabs Pi opened there.
 *
 * Before attaching, pi-phone looks at what listens there: its version (`Browser.getVersion`) and, from the machine, the
 * process's command line, for the profile it runs on (`--user-data-dir`, or the folder of its DevToolsActivePort file).
 * A browser that is not pi-phone's own carries its profile's sign-ins: the owner approves on a card first.
 */
import { Cdp } from "./cdp.ts";
import { BROWSER_DIR, request } from "./machine-engine.ts";
import type { BrowserPage, PictureOptions } from "./page.ts";
import type { BrowserEngine } from "./pi-browser.ts";

/** A shell word: the text in single quotes, safe in sh and Git Bash. */
const shellWord = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;

/** How the active-port script ends when the file is not there or holds no port. */
export const ACTIVE_PORT_EXIT = { noFile: 4, noPort: 3 } as const;

/**
 * Where Chrome-family browsers keep their DevToolsActivePort in their own (default) profiles, under the home: what
 * `chrome://inspect/#remote-debugging` writes (Linux, macOS, Windows through Git Bash).
 */
export const DEFAULT_ACTIVE_PORTS = [
    ".config/google-chrome",
    ".config/google-chrome-beta",
    ".config/chromium",
    ".config/microsoft-edge",
    ".config/BraveSoftware/Brave-Browser",
    "Library/Application Support/Google/Chrome",
    "Library/Application Support/Chromium",
    "Library/Application Support/Microsoft Edge",
    "AppData/Local/Google/Chrome/User Data",
    "AppData/Local/Microsoft/Edge/User Data",
    "AppData/Local/BraveSoftware/Brave-Browser/User Data",
].map((folder) => `~/${folder}/DevToolsActivePort`);

/**
 * The script that reads a DevToolsActivePort file on the machine (`~/` is its home), or the first of the default
 * profiles' (`DEFAULT_ACTIVE_PORTS`) without one: `dir <its folder>` (the browser's profile, as Chrome writes the file
 * there), `port <n>`, and `ws <the browser's endpoint path>` when the file names it.
 */
export function activePortScript(path?: string): string {
    if (path !== undefined && (/[\0\r\n]/.test(path) || path.trim() === "")) {
        throw new Error("Give the DevToolsActivePort file as one path.");
    }

    return [
        "F=",
        `for c in ${(path === undefined ? DEFAULT_ACTIVE_PORTS : [path.trim()]).map(shellWord).join(" ")}; do`,
        '  case "$c" in "~/"*) c="$HOME/${c#\\~/}";; esac',
        '  if [ -f "$c" ]; then F="$c"; break; fi',
        "done",
        `if [ -z "$F" ]; then echo "nofile"; exit ${ACTIVE_PORT_EXIT.noFile}; fi`,
        'N=$(head -n 1 "$F" | tr -d "\\r ")',
        `case "$N" in ''|*[!0-9]*) echo "noport"; exit ${ACTIVE_PORT_EXIT.noPort};; esac`,
        'W=$(sed -n 2p "$F" | tr -d "\\r ")',
        'D=$(cd "$(dirname "$F")" && pwd)',
        'echo "dir $D"',
        'echo "port $N"',
        'case "$W" in /devtools/browser/*) echo "ws $W";; esac',
    ].join("\n");
}

/**
 * The script that names the process listening on `port` on the machine and gives its command line, base64: `argv <b64>`
 * (Linux: its arguments, a line each) or `cmdline <b64>` (macOS, Windows: as one line); nothing when it cannot tell.
 */
export function inspectScript(port: number, windows: boolean): string {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("The port is a whole number from 1 to 65535.");
    }

    if (windows) {
        const ps = [
            `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
            "if ($c) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.OwningProcess); if ($p -and $p.CommandLine) { Write-Output ('cmdline ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($p.CommandLine))) } }",
        ].join("\n");

        return `powershell.exe -NoProfile -NonInteractive -Command ${shellWord(ps)}\necho done`;
    }

    return [
        `N=${port}`,
        'pid=""',
        'if command -v ss >/dev/null 2>&1; then pid=$(ss -ltnpH "sport = :$N" 2>/dev/null | sed -n "s/.*pid=\\([0-9][0-9]*\\).*/\\1/p" | head -n 1); fi',
        'if [ -z "$pid" ] && command -v lsof >/dev/null 2>&1; then pid=$(lsof -nP -iTCP:"$N" -sTCP:LISTEN -t 2>/dev/null | head -n 1); fi',
        'if [ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ]; then echo "argv $(tr "\\000" "\\n" <"/proc/$pid/cmdline" | base64 | tr -d "\\n")";',
        'elif [ -n "$pid" ]; then echo "cmdline $(ps -o command= -p "$pid" | base64 | tr -d "\\n")"; fi',
        "echo done",
    ].join("\n");
}

/** The profile folder a browser's command line names (`--user-data-dir`), from what `inspectScript` said; or undefined. */
export function profileFromInspect(out: string): string | undefined {
    const argv = /^argv (\S*)\s*$/m.exec(out)?.[1];
    const line = /^cmdline (\S*)\s*$/m.exec(out)?.[1];
    const said = Buffer.from(argv ?? line ?? "", "base64").toString("utf8");
    // An argument of its own (a path with spaces kept whole), as Linux keeps a process's arguments.
    const whole = argv === undefined ? undefined : said.split("\n").find((each) => each.startsWith("--user-data-dir="));

    if (whole !== undefined) {
        return whole.slice("--user-data-dir=".length) || undefined;
    }

    // One line: Windows' command line, macOS's ps, and Chrome on Linux, which rewrites its arguments as one line (its
    // process title; tuanlh-sandbox-01, Chrome 156). A folder with spaces is quoted there, or ends at the first space.
    const match = /(?:^|\s)--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(said);

    return match?.[1] ?? match?.[2];
}

/** Whether the process said anything: undefined when the machine could not tell which process listens. */
export const processKnown = (out: string): boolean => /^(argv|cmdline) /m.test(out);

/** Whether a profile folder is pi-phone's own browser's on that machine (`~/.pi/mobile/browser/profile`). */
export function isOwnProfile(profile: string | undefined, home: string): boolean {
    if (profile === undefined) {
        return false;
    }

    const normal = (path: string) =>
        path
            .replace(/\\/g, "/")
            .replace(/^\/([a-z])\//i, "$1:/")
            .replace(/\/+$/, "")
            .toLowerCase();

    return normal(profile) === normal(`${home}/${BROWSER_DIR}/profile`);
}

/** A browser's own connection, with what it says of itself. `id`: its endpoint's, new each time it starts. */
export type BrowserEndpoint = { cdp: Cdp; id: string; browser: string; userAgent: string; headless: boolean };

/**
 * Connect to the browser behind `port` (here): at `path` (`/devtools/browser/<id>`, from its DevToolsActivePort), or
 * where its `/json/version` says. Chrome's own opt-in may ask the person at the machine to allow it first: the
 * connection waits up to a minute. Rejects with why it is no browser's DevTools.
 */
export async function connectBrowser(port: number, path?: string, timeoutMs = 60_000): Promise<BrowserEndpoint> {
    let endpoint = path;

    if (endpoint === undefined) {
        let parsed: { webSocketDebuggerUrl?: unknown };

        try {
            parsed = JSON.parse(await request(port, "/json/version")) as typeof parsed;
        } catch (error) {
            throw new Error(`its /json/version did not answer as a browser's (${error instanceof Error ? error.message : String(error)}); give its DevToolsActivePort file instead`);
        }

        endpoint = typeof parsed.webSocketDebuggerUrl === "string" ? new URL(parsed.webSocketDebuggerUrl).pathname : undefined;
    }

    if (endpoint === undefined || !/^\/devtools\/browser\/[\w-]+$/.test(endpoint)) {
        throw new Error("it names no browser endpoint (/devtools/browser/…)");
    }

    const cdp = await Cdp.connect({ url: `ws://127.0.0.1:${port}${endpoint}` }, timeoutMs);

    try {
        const version = await cdp.send<{ product?: string; userAgent?: string }>("Browser.getVersion");
        const product = String(version.product ?? "");
        const userAgent = String(version.userAgent ?? "");

        return { cdp, id: endpoint.slice("/devtools/browser/".length), browser: product, userAgent, headless: /Headless/.test(product) || /HeadlessChrome/.test(userAgent) };
    } catch (error) {
        cdp.close();

        throw error;
    }
}

/** A page target, as `Target.getTargets` lists it. */
type TargetInfo = { targetId: string; type: string; url: string; openerId?: string };

/** Who owns which tab (`TabOwners`), by a key of the browser's. */
export type Owners = {
    owner(place: string, tab: string): number | undefined;
    set(place: string, tab: string, session: number | undefined): void;
    keepOnly(place: string, tabs: readonly string[]): void;
};

export type AttachedOptions = {
    /** The machine's name, for messages, and its home, for uploads. */
    name: string;
    home: string;
    writeFile(path: string, bytes: Uint8Array): Promise<void>;
    /** The forward of the browser's DevTools port: here, and how to close it. */
    forward: { port: number; close(): void };
    /** The browser's own connection (`connectBrowser`). */
    endpoint: BrowserEndpoint;
    /** Its port on the machine, and its label. */
    remotePort: number;
    label: string;
    /** The session whose browser it is, and who owns which tab, kept by `ownerKey` (the browser's identity). */
    session: number;
    owners: Owners;
    ownerKey: string;
};

export class AttachedEngine implements BrowserEngine {
    readonly label: string;
    readonly popups = true;
    readonly asksWindows = false;
    readonly local = true;
    readonly actAsPhone = true;
    readonly reopensToResize = false;
    readonly visibleOn: string | undefined;
    readonly remotePort: number;
    readonly #options: AttachedOptions;
    readonly #browser: Cdp;
    /** The tabs Pi made there: the only ones closing Pi's browser closes. */
    readonly #made = new Set<string>();

    constructor(options: AttachedOptions) {
        this.#options = options;
        this.#browser = options.endpoint.cdp;
        this.label = `${options.label} on ${options.name}`;
        this.remotePort = options.remotePort;
        this.visibleOn = options.endpoint.headless ? undefined : options.name;
    }

    watchWindows(): () => void {
        return () => {};
    }

    /** Its pages (not DevTools' own), as the browser lists them. */
    async pages(): Promise<TargetInfo[]> {
        const { targetInfos } = await this.#browser.send<{ targetInfos: TargetInfo[] }>("Target.getTargets");

        return targetInfos.filter((each) => each.type === "page" && !each.url.startsWith("devtools://"));
    }

    /** Take every page open now as this session's (`tabs: "all"`, for a browser Pi started). */
    async takeOpen(): Promise<number> {
        const pages = await this.pages();

        for (const page of pages) {
            this.#options.owners.set(this.#options.ownerKey, page.targetId, this.#options.session);
        }

        return pages.length;
    }

    /** This session's tabs, oldest first: those it owns, and the windows their pages opened (by Chrome's opener). */
    async tabs(): Promise<string[]> {
        const { owners, ownerKey, session } = this.#options;
        const pages = await this.pages();

        owners.keepOnly(ownerKey, pages.map((each) => each.targetId));

        const own = (id: string | undefined) => id !== undefined && owners.owner(ownerKey, id) === session;
        let taken = true;

        while (taken) {
            taken = false;

            for (const page of pages) {
                if (!own(page.targetId) && own(page.openerId)) {
                    owners.set(ownerKey, page.targetId, session);
                    taken = true;
                }
            }
        }

        return pages.filter((each) => own(each.targetId)).map((each) => each.targetId);
    }

    /** A new tab: in the background where the browser has a window, so the owner's tab in front stays there. */
    async newTab(): Promise<string> {
        const { targetId } = await this.#browser.send<{ targetId: string }>("Target.createTarget", { url: "about:blank", background: this.visibleOn !== undefined });

        this.#made.add(targetId);
        this.#options.owners.set(this.#options.ownerKey, targetId, this.#options.session);

        return targetId;
    }

    connect(id: string): Promise<Cdp> {
        return this.#browser.attach(id);
    }

    async closeTab(id: string): Promise<void> {
        await this.#browser.send("Target.closeTarget", { targetId: id });
        this.#made.delete(id);
        this.#options.owners.set(this.#options.ownerKey, id, undefined);

        const until = Date.now() + 5000;

        while (Date.now() < until && (await this.pages()).some((each) => each.targetId === id)) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
    }

    /** Close the tabs Pi made there; the browser, and the tabs it had, stay. */
    async close(): Promise<void> {
        const listed = new Set((await this.pages()).map((each) => each.targetId));

        for (const id of [...this.#made]) {
            if (listed.has(id)) {
                await this.closeTab(id);
            } else {
                this.#made.delete(id);
            }
        }
    }

    /** Let go: its connection and the forward close; the browser runs on. */
    release(): void {
        this.#browser.close();
        this.#options.forward.close();
    }

    async pdf(_id: string, page: BrowserPage): Promise<Buffer> {
        const printed = await page.cdp.send<{ data: string }>("Page.printToPDF", { printBackground: true });

        return Buffer.from(printed.data, "base64");
    }

    /**
     * A picture of a tab: a window's tab comes to the front first, as a background tab may not draw one (pi-browser's
     * screenshots do the same); a headless browser's draws in the background.
     */
    async picture(id: string, page: BrowserPage, quality: number, timeoutMs?: number, options?: PictureOptions): Promise<string> {
        if (this.visibleOn !== undefined) {
            await this.#browser.send("Target.activateTarget", { targetId: id });
        }

        return page.screenshot(quality, timeoutMs, options);
    }

    /** On the machine, where the browser reads it. */
    async stage(name: string, bytes: Uint8Array): Promise<string> {
        const path = `${this.#options.home}/${BROWSER_DIR}/uploads/${crypto.randomUUID()}/${name.replace(/[/\\]/g, "_")}`;

        await this.#options.writeFile(path, bytes);

        return path;
    }
}
