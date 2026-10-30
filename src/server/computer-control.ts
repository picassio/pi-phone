/**
 * Pi controls computers (PP-178): desktop apps on the owner's machines, through open-computer-use ("ocu", the machine
 * tool of PP-177), as phone control does apps on the phone (`phone-control.ts`).
 *
 * A control session is the owner's yes on one card (`extensions/computer.ts`): a machine, the apps it names (by their
 * names in ocu's list), for the minutes Pi asked (5 to 60). It runs one `ocu mcp` on the machine, through the app's ssh,
 * from its start to its end (ocu keeps each app's element numbers in its memory), and a small window on the machine's
 * desktop says Pi is using it, with Stop. It ends at its time, on Stop (that window, the panel, the menu), when Pi stops
 * it, 20 s after Pi's run ends unless another starts, or when the owner puts one of its apps on the Never list.
 *
 * Every call is checked here before ocu gets it: the session's apps only (and, with follow, the apps they open), never
 * pi-phone itself, banking and payment apps, password managers and authenticators, or the owner's own Never list; no
 * typing or character keys from Pi into a password field (ocu's outline marks them `[password]`, and pi-phone's ocu
 * build refuses them too); an element number only while it is still the element Pi read. While the owner has taken the
 * computer over (the panel's Take over), Pi's calls are refused until they hand it back, and what the owner types goes
 * to the field in focus, a password field too: only those calls, Pi's fills with a saved secret by name, and the values
 * the owner types on a computer_sign_in card (`fill`) tell ocu `allow_password_input`. A card's values never come back
 * in what Pi reads of the windows (`computer-typed.ts`).
 *
 * The panel (`web/computer-panel.js`) shows the session's windows: a picture of one after each action and every 3 s while
 * a tab watches, with a box on the element Pi acted on. Only the owner sees it.
 *
 * On Windows (PP-179) ocu runs in the owner's desktop session behind pi-phone's bridge (`computer-windows.ts`), started by
 * a per-user scheduled task the owner allows on a card, and reached through the app's ssh forward; the sign is the
 * bridge's small topmost window. Every check here is the same.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ComputerOutline, type DesktopApp, type Frame, parseApps, parseOutline, pngSize } from "./computer-outline.ts";
import { hideTyped, SHORT_TYPED_NOTE, shortTypedShowing, type TypedFill, typedAreas } from "./computer-typed.ts";
import { imageOf, OcuClient, type OcuProcess, type OcuResult, textOf } from "./ocu-client.ts";
import {
    CONNECT_EXIT,
    connectBridge,
    connectScript,
    describeWindowsState,
    installScript as windowsInstallScript,
    parseWindowsState,
    removeScript as windowsRemoveScript,
    statusScript as windowsStatusScript,
    taskPlan,
    BRIDGE,
    BRIDGE_FILE,
    type WindowsState,
} from "./computer-windows.ts";
import { clockText } from "./phone-events.ts";
import { IDLE_END_MS, MINUTES } from "./phone-control.ts";

export { IDLE_END_MS, MINUTES };

/** The app pi-phone's own window on the machine is (`SIGN`): never read or controlled, like pi-phone on the phone. */
export const PI_PHONE_APP = "pi-phone";

/** How often a watched panel's picture is read again, between Pi's actions. */
export const REFRESH_MS = 3000;

/**
 * Desktop apps Pi never reads or controls, matched in an app's name, id and window title (case does not matter): the
 * phone's groups, as desktop apps. The owner adds others in the app (Menu › Computer control).
 */
export const NEVER_GROUPS = [
    {
        id: "banking",
        label: "Banking and payment apps",
        names: [
            "bank", "paypal", "venmo", "revolut", "transferwise", "wise.com", "payoneer", "skrill", "stripe", "alipay", "paytm", "phonepe", "momo",
            "zalopay", "vnpay", "viettelpay", "vietcombank", "techcombank", "vietinbank", "agribank", "sacombank", "vpbank", "tpbank", "mbbank",
            "hdbank", "seabank", "coinbase", "binance", "metamask", "exodus", "ledger live", "electrum", "trust wallet", "kraken", "bybit", "okx",
            "wallet",
        ],
    },
    {
        id: "passwords",
        label: "Password managers and authenticators",
        names: [
            "1password", "bitwarden", "lastpass", "dashlane", "keepass", "keeper", "enpass", "nordpass", "proton pass", "roboform", "zoho vault",
            "authy", "authenticator", "yubico", "ente auth", "2fas", "aegis", "seahorse", "passwords and keys", "kwallet", "keychain",
        ],
    },
] as const;

export type ComputerApp = { label: string; name: string };

export type ComputerMachine = { id: string; name: string; platform?: string; connected: boolean; tools?: Record<string, string>; user?: string };

export type ComputerSession = {
    machine: string;
    machineName: string;
    /** The conversation whose Pi it is for, and its session (the root, for a subagent's). */
    conversationId: number;
    session: number;
    approvedBy: string;
    apps: ComputerApp[];
    /** Apps the named ones open while Pi acts in them join (`followed`): one step, never the Never list. */
    follow?: boolean;
    followed?: ComputerApp[];
    reason: string;
    startedAt: number;
    until: number;
};

/** What the panel shows of a session. */
export type ComputerPanel = {
    session: number;
    conversationId: number;
    machine: string;
    machineName: string;
    apps: ComputerApp[];
    /** The app whose window shows (a tab). */
    tab: string;
    /** What Pi is doing now, or null. */
    doing: string | null;
    takenOver: boolean;
    until: number;
    open: boolean;
};

/** A picture of a window, for the tabs that watch: with the box on what Pi last acted on, in fractions of the picture. */
export type ComputerFrame = {
    session: number;
    app: string;
    png: string;
    width: number;
    height: number;
    at: number;
    hit?: { x: number; y: number; width: number; height: number; label: string };
};

type Ended = { at: number; why: string };
type Kept = { never: { label: string }[]; ended: Record<string, Ended>; prepare: Record<string, string> };

/** Where the ocu wrapper is on a machine (`machine-tools.ts`). */
const OCU = '"$HOME/.pi/mobile/tools/bin/ocu"';

/** A value for a single-quoted sh word. */
export const shellWord = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
const q = shellWord;

/**
 * The window on the machine's desktop while a session runs (GTK 3, through python3-gi, which ocu needs on Linux too):
 * always on top, never taking the focus, with Stop. It prints `ready` once it shows and `stop` when Stop is pressed; it
 * goes when its input closes (the session ended). Its name is pi-phone's (`PI_PHONE_APP`), so ocu never acts in it.
 */
export const SIGN = String.raw`import sys, gi
gi.require_version("Gtk", "3.0")
gi.require_version("Gdk", "3.0")
from gi.repository import Gtk, Gdk, GLib
GLib.set_prgname("pi-phone")
GLib.set_application_name("pi-phone")
window = Gtk.Window(title="pi-phone")
window.set_keep_above(True)
window.set_decorated(False)
window.set_skip_taskbar_hint(True)
window.set_skip_pager_hint(True)
window.set_accept_focus(False)
window.set_focus_on_map(False)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
box = Gtk.Box(spacing=10, margin=8)
label = Gtk.Label(label=sys.argv[1])
button = Gtk.Button(label="Stop")
def stop(_):
    print("stop", flush=True)
    Gtk.main_quit()
button.connect("clicked", stop)
box.pack_start(label, False, False, 0)
box.pack_start(button, False, False, 0)
window.add(box)
window.show_all()
screen = Gdk.Screen.get_default()
width, _ = window.get_size()
window.move(max(0, screen.get_width() - width - 16), 16)
def heard(source, condition):
    line = sys.stdin.readline()
    if not line:
        Gtk.main_quit()
        return False
    return True
GLib.io_add_watch(sys.stdin, GLib.IO_IN | GLib.IO_HUP, heard)
print("ready", flush=True)
Gtk.main()
`;

/** Whether a press_key chord types a character (a, shift+a, space), not a command (ctrl+a, Return). */
export function typesCharacter(key: string): boolean {
    const parts = key.split("+").filter((part) => part !== "");
    const main = parts.at(-1);

    if (main === undefined || parts.slice(0, -1).some((part) => part.toLowerCase() !== "shift")) {
        return false;
    }

    return main.length === 1 || main.toLowerCase() === "space" || /^KP_\d$/.test(main);
}

type Live = {
    ocu: OcuClient;
    sign: OcuProcess;
    /** The newest read of each app ocu made (its element numbers), and the one Pi read last. */
    outlines: Map<string, ComputerOutline>;
    piOutlines: Map<string, ComputerOutline>;
    frames: Map<string, ComputerFrame>;
    hit?: { app: string; frame: Frame; label: string };
    tab: string;
    doing: string | null;
    takenOver: boolean;
    /** Calls in flight: the panel does not read again meanwhile. */
    busy: number;
    /** What the owner typed on computer_sign_in cards (PP-183): kept out of all Pi reads of the windows (`computer-typed.ts`). */
    typed: TypedFill[];
};

export type ComputerControlOptions = {
    dataDir: string;
    gateway: boolean;
    /** The owner's machines, as the Machines sheet has them. */
    machines: () => ComputerMachine[];
    /** Run `script` with sh on a machine, its input, output and errors here (ssh through the app's keys). */
    launch: (machine: string, script: string) => OcuProcess;
    /** Ask a machine again which tools it has, and keep the answer (`machines()` then has it). */
    refreshTools?: (machine: string) => Promise<void>;
    /** Windows (PP-179): port `port` of the machine's 127.0.0.1, open here (the app's ssh forward): its port here, and how to close it. */
    forward?: (machine: string, port: number) => Promise<{ port: number; close(): void }>;
    /**
     * Windows: run a script with Git Bash on the machine, through pi-env's daemon (Windows' sshd's own shell may be
     * cmd.exe): its exit code and output (stdout and stderr together).
     */
    run?: (machine: string, script: string, timeoutSeconds: number) => Promise<{ code: number; out: string }>;
    /** Windows: write a file under the machine's home (a `/`-separated path relative to it), its folder made first. */
    writeFile?: (machine: string, path: string, text: string) => Promise<void>;
    now?: () => number;
    log?: (line: string) => void;
    idleEndMs?: number;
    refreshMs?: number;
};

export class ComputerControl {
    readonly #file: string;
    readonly #kept: Kept;
    readonly #options: ComputerControlOptions;
    readonly #now: () => number;
    readonly #log: (line: string) => void;
    readonly #sessions = new Map<string, ComputerSession>();
    readonly #live = new Map<string, Live>();
    readonly #timers = new Map<string, NodeJS.Timeout>();
    readonly #idle = new Map<number, NodeJS.Timeout>();
    readonly #listeners = new Set<() => void>();
    readonly #panelListeners = new Set<(panel: ComputerPanel) => void>();
    readonly #frameListeners = new Set<(frame: ComputerFrame) => void>();
    /** Tabs watching each machine's panel, and its refresh timer. */
    readonly #watchers = new Map<string, number>();
    readonly #refresh = new Map<string, NodeJS.Timeout>();
    /** Windows: each bridge's forward here (by machine and port there), and the connections through it; it closes after the last. */
    readonly #tunnels = new Map<string, { forward: Promise<{ port: number; close(): void }>; users: number }>();

    constructor(options: ComputerControlOptions) {
        this.#options = options;
        this.#file = join(options.dataDir, "computer-control.json");
        this.#now = options.now ?? Date.now;
        this.#log = options.log ?? (() => {});
        const kept = existsSync(this.#file) ? (JSON.parse(readFileSync(this.#file, "utf8")) as Partial<Kept> & { sessions?: ComputerSession[] }) : {};

        this.#kept = { never: kept.never ?? [], ended: kept.ended ?? {}, prepare: kept.prepare ?? {} };

        // A session's ocu and its window on the machine went with the server: it ends, and Pi asks again.
        for (const session of kept.sessions ?? []) {
            this.#kept.ended[session.machine] = { at: this.#now(), why: "pi-phone restarted" };
        }

        if ((kept.sessions ?? []).length > 0) {
            this.#save();
        }
    }

    #save(): void {
        writeFileSync(this.#file, JSON.stringify({ ...this.#kept, sessions: [...this.#sessions.values()] }), { mode: 0o600 });
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);

        return () => this.#listeners.delete(listener);
    }

    onPanel(listener: (panel: ComputerPanel) => void): () => void {
        this.#panelListeners.add(listener);

        return () => this.#panelListeners.delete(listener);
    }

    onFrame(listener: (frame: ComputerFrame) => void): () => void {
        this.#frameListeners.add(listener);

        return () => this.#frameListeners.delete(listener);
    }

    #changed(): void {
        for (const listener of this.#listeners) {
            listener();
        }
    }

    #panelChanged(machine: string): void {
        const panel = this.panelOf(machine);

        if (panel !== undefined) {
            for (const listener of this.#panelListeners) {
                listener(panel);
            }
        }
    }

    unavailable(): string | undefined {
        return this.#options.gateway ? "Computer control is the owner's, on their pi-phone: not on the team server." : undefined;
    }

    // ─── Machines ───────────────────────────────────────────────────────────

    /** A machine by name or id, connected, with ocu installed, on a system computer control runs on: or why not. */
    machine(wanted: string): ComputerMachine {
        const machines = this.#options.machines();
        const name = wanted.trim().toLowerCase();
        const machine = machines.find((each) => each.id === wanted.trim()) ?? machines.find((each) => each.name.toLowerCase() === name);

        if (machine === undefined) {
            throw new Error(`There is no machine ${wanted}. Machines: ${machines.map((each) => each.name).join(", ") || "none"}.`);
        }

        if (!machine.connected) {
            throw new Error(`${machine.name} is not connected: connect it in Settings › Machines.`);
        }

        if (machine.platform !== "linux" && machine.platform !== "windows") {
            throw new Error(`Computer control runs on Linux and Windows machines; ${machine.name} is ${machine.platform ?? "of an unknown system"}.`);
        }

        if (machine.tools?.ocu === undefined) {
            throw new Error(`Computer use (ocu) is not installed on ${machine.name}: install it in Settings › Machines › Install tools.`);
        }

        return machine;
    }

    /**
     * `machine`, after asking the machine itself when the app's record says ocu is not there: the record is only as new
     * as the last look at its tools (Settings › Machines), and ocu may have been installed since.
     */
    async ready(wanted: string): Promise<ComputerMachine> {
        try {
            return this.machine(wanted);
        } catch (error) {
            const found = this.#options.machines().find((each) => each.id === wanted.trim() || each.name.toLowerCase() === wanted.trim().toLowerCase());

            if (found === undefined || !found.connected || found.tools?.ocu !== undefined || this.#options.refreshTools === undefined) {
                throw error;
            }

            await this.#options.refreshTools(found.id);

            return this.machine(found.id);
        }
    }

    /** The shell line run on a machine before ocu starts (its desktop's environment), as the owner set it. */
    prepareOf(machine: string): string {
        return this.#kept.prepare[machine] ?? "";
    }

    /** Set it (Menu › Computer control, or Pi's `computer_control setup`): one line, or empty. */
    setPrepare(machine: string, line: string): void {
        if (line.trim() !== "" && this.#options.machines().find((each) => each.id === machine)?.platform === "windows") {
            throw new Error("A desktop setup line is for Linux: on Windows, ocu runs in your desktop session through pi-phone's task (computer_control setup with task: install).");
        }

        if (/[\r\n]/.test(line) || line.length > 500) {
            throw new Error("Give the desktop's setup as one shell line of at most 500 characters.");
        }

        if (line.trim() === "") {
            delete this.#kept.prepare[machine];
        } else {
            this.#kept.prepare[machine] = line.trim();
        }

        this.#save();
        this.#changed();
    }

    #script(machine: string, command: string): string {
        const prepare = this.prepareOf(machine);

        return [
            `if [ ! -x ${OCU} ]; then echo "Computer use (ocu) is not installed here: Settings › Machines › Install tools." >&2; exit 9; fi`,
            ...(prepare === "" ? [] : [prepare]),
            command,
        ].join("\n");
    }

    /** A new ocu on a machine, started (its handshake done): on Windows, through the bridge in its desktop session. */
    async #ocu(machine: string, onEnd: (why: string) => void = () => {}): Promise<OcuClient> {
        const found = this.machine(machine);
        const process =
            found.platform === "windows"
                ? await this.#bridge(found, (token) => ({ token, run: "mcp", ocu: found.tools!.ocu! }))
                : this.#options.launch(machine, this.#script(machine, `exec ${OCU} mcp`));
        const client = new OcuClient(process, onEnd);

        try {
            await client.start();
        } catch (error) {
            client.close();

            throw error;
        }

        return client;
    }

    // ─── Windows (PP-179) ─────────────────────────────────────────────────────

    /** Run a script on a Windows machine with Git Bash: its exit code and output. */
    #run(machine: string, script: string, timeoutSeconds = 90): Promise<{ code: number; out: string }> {
        if (this.#options.run === undefined) {
            throw new Error("Computer control on Windows needs pi-env's daemon to run its scripts, which this server has not got.");
        }

        return this.#options.run(machine, script, timeoutSeconds);
    }

    /** The last lines of a script's output, for an error (never a connect script's success line: it holds the token). */
    #tail(out: string, lines = 4): string {
        return out
            .trim()
            .split("\n")
            .filter((line) => !line.startsWith("bridge "))
            .slice(-lines)
            .join(" ");
    }

    /** A Windows machine by name or id, or why it is not one. */
    #windows(wanted: string): ComputerMachine {
        const machine = this.machine(wanted);

        if (machine.platform !== "windows") {
            throw new Error(`${machine.name} is not a Windows machine: pi-phone's task is for Windows. On Linux, ocu runs in its desktop session itself (with a desktop setup line where needed).`);
        }

        return machine;
    }

    /** How a Windows machine stands: pi-phone's task, someone signed in to its desktop, its bridge. */
    async windowsState(wanted: string): Promise<WindowsState> {
        const machine = this.#windows(wanted);
        const { out } = await this.#run(machine.id, windowsStatusScript());

        try {
            return parseWindowsState(out);
        } catch (error) {
            throw new Error(`${machine.name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /** That state as a line, for Pi and the menu. */
    describeWindows(machine: ComputerMachine, state: WindowsState): string {
        return describeWindowsState(machine.name, state);
    }

    /** Make pi-phone's task on a Windows machine (after the owner's yes: a card, or their tap in the menu): how it stands then. */
    async installTask(wanted: string): Promise<WindowsState> {
        const machine = this.#windows(wanted);

        if (this.#options.writeFile === undefined) {
            throw new Error("Computer control on Windows needs pi-env's daemon to write its bridge, which this server has not got.");
        }

        await this.#options.writeFile(machine.id, BRIDGE_FILE, BRIDGE);
        const { code, out } = await this.#run(machine.id, windowsInstallScript());

        if (code !== 0) {
            throw new Error(`pi-phone's task could not be made on ${machine.name}: ${this.#tail(out) || `exit ${code}`}`);
        }

        this.#log(`Computer control: pi-phone's task was made on ${machine.name}.`);

        return parseWindowsState(out);
    }

    /**
     * Pi's `computer_control setup` with task (install or remove) on a Windows machine: the owner reads on a card exactly
     * what changes there (`taskPlan`) and approves it first; then it is done. What to tell Pi.
     */
    async setupTask(
        wanted: string,
        what: "install" | "remove",
        reason: string,
        ask: (request: { tool: string; subject: string; reason: string }) => Promise<{ allow: boolean; by: string }>,
    ): Promise<string> {
        const machine = this.#windows(wanted);
        const answer = await ask({
            tool: "computer_control",
            subject: taskPlan(machine.name, machine.user ?? "the user pi-phone signs in as", what),
            reason: reason || (what === "install" ? `Let Pi use ${machine.name}'s desktop apps, in sessions you approve` : `Remove computer control from ${machine.name}`),
        });

        if (!answer.allow) {
            return `${answer.by === "superseded" ? "The request was replaced" : `${answer.by} said no`}: nothing changed on ${machine.name}.`;
        }

        const state = what === "install" ? await this.installTask(machine.id) : await this.removeTask(machine.id);

        return what === "install"
            ? `pi-phone's task is on ${machine.name}. It is ${describeWindowsState(machine.name, state)}.`
            : `pi-phone's task, its bridge and ~/.pi/mobile/computer are gone from ${machine.name} (ocu stays installed).`;
    }

    /** Remove pi-phone's task, its bridge and its folder from a Windows machine (its sessions end first). */
    async removeTask(wanted: string): Promise<WindowsState> {
        const machine = this.#windows(wanted);

        await this.end(machine.id, "pi-phone's task was removed");
        const { code, out } = await this.#run(machine.id, windowsRemoveScript());

        if (code !== 0) {
            throw new Error(`pi-phone's task could not be removed from ${machine.name}: ${this.#tail(out) || `exit ${code}`}`);
        }

        this.#log(`Computer control: pi-phone's task was removed from ${machine.name}.`);

        return parseWindowsState(out);
    }

    /**
     * A connection to the bridge on a Windows machine: its port and token read over ssh (the task started first when the
     * owner is signed in and it is not running), its port opened here, then what to run said with the token.
     */
    async #bridge(machine: ComputerMachine, hello: (token: string) => Parameters<typeof connectBridge>[1]): Promise<OcuProcess> {
        if (this.#options.forward === undefined) {
            throw new Error("Computer control on Windows needs the app's ssh forwards, which this server has not got.");
        }

        const { code, out } = await this.#run(machine.id, connectScript());

        if (code === CONNECT_EXIT.notSetUp) {
            throw new Error(describeWindowsState(machine.name, { task: false, loggedOn: false, locked: false, running: false }));
        }

        if (code === CONNECT_EXIT.notLoggedOn) {
            throw new Error(describeWindowsState(machine.name, { task: true, loggedOn: false, locked: false, running: false }));
        }

        const found = /^bridge (\d+) ([0-9a-f]{64})\s*$/m.exec(out);

        if (code !== 0 || found === null) {
            throw new Error(`pi-phone's bridge on ${machine.name} is not running: ${this.#tail(out, 6) || `exit ${code}`}`);
        }

        const remote = Number(found[1]);
        const key = `${machine.id}:${remote}`;
        let tunnel = this.#tunnels.get(key);

        if (tunnel === undefined) {
            tunnel = { forward: this.#options.forward(machine.id, remote), users: 0 };
            this.#tunnels.set(key, tunnel);
        }

        tunnel.users += 1;
        const release = () => {
            const now = this.#tunnels.get(key);

            if (now !== undefined && (now.users -= 1) <= 0) {
                this.#tunnels.delete(key);
                void now.forward.then((forward) => forward.close()).catch(() => {});
            }
        };

        try {
            const local = (await tunnel.forward).port;
            const connection = await connectBridge(local, hello(found[2]!), `pi-phone's bridge on ${machine.name}`);

            connection.once("exit", release);

            return connection;
        } catch (error) {
            release();

            throw error;
        }
    }

    /** The apps with a window on a machine's desktop now, as ocu lists them (each with why it is never controlled). */
    async apps(machineId: string): Promise<(DesktopApp & { never: string | null })[]> {
        const machine = this.machine(machineId);
        const ocu = await this.#ocu(machine.id);

        try {
            const result = await ocu.call("list_apps", {});
            const text = textOf(result);

            if (result.isError) {
                throw new Error(`ocu on ${machine.name} could not list its apps: ${text}`);
            }

            return parseApps(text).map((app) => ({ ...app, never: this.neverReason(app) ?? null }));
        } finally {
            ocu.close();
        }
    }

    // ─── Never ──────────────────────────────────────────────────────────────

    /** Why Pi never touches an app (its name, id or window title), or undefined. */
    neverReason(app: { name: string; id?: string; window?: string; label?: string }): string | undefined {
        const words = [app.name, app.id ?? "", app.window ?? "", app.label ?? ""].map((each) => each.toLowerCase());

        if (words.some((each) => each === PI_PHONE_APP)) {
            return "pi-phone itself";
        }

        for (const group of NEVER_GROUPS) {
            if (group.names.some((name) => words.some((each) => each.includes(name)))) {
                return group.id === "banking" ? "a banking or payment app" : "a password manager or authenticator";
            }
        }

        const own = this.#kept.never.find((each) => words.some((word) => word.includes(each.label.toLowerCase())));

        return own === undefined ? undefined : "on the owner's Never list";
    }

    neverList(): { groups: { id: string; label: string; names: string[] }[]; own: { label: string }[] } {
        return { groups: NEVER_GROUPS.map((group) => ({ id: group.id, label: group.label, names: [...group.names] })), own: [...this.#kept.never] };
    }

    /** The owner adds an app (by a name it shows) to their Never list: Menu › Computer control only. It ends a session using it. */
    async addNever(label: string): Promise<void> {
        const name = label.trim();

        if (name.length < 2 || name.length > 80) {
            throw new Error("Give the app's name as the machine shows it (2 to 80 characters).");
        }

        if (!this.#kept.never.some((each) => each.label.toLowerCase() === name.toLowerCase())) {
            this.#kept.never.push({ label: name });
            this.#save();
        }

        for (const session of this.sessions()) {
            const app = [...session.apps, ...(session.followed ?? [])].find((each) => this.neverReason(each) !== undefined);

            if (app !== undefined) {
                await this.end(session.machine, `the owner put ${app.label} on the Never list`);
            }
        }

        this.#changed();
    }

    removeNever(label: string): void {
        this.#kept.never = this.#kept.never.filter((each) => each.label.toLowerCase() !== label.trim().toLowerCase());
        this.#save();
        this.#changed();
    }

    // ─── Sessions ───────────────────────────────────────────────────────────

    sessions(): ComputerSession[] {
        const now = this.#now();

        for (const session of [...this.#sessions.values()].filter((each) => each.until <= now)) {
            void this.end(session.machine, "time ran out");
        }

        return [...this.#sessions.values()].filter((each) => each.until > now);
    }

    active(machine: string): ComputerSession | undefined {
        return this.sessions().find((each) => each.machine === machine);
    }

    /** Why there is no session on a machine, with what to do. */
    noSession(machine: string, name = machine): string {
        const ended = this.#kept.ended[machine];
        const last = ended === undefined ? "" : ` (the last one ended at ${clockText(ended.at)}: ${ended.why})`;

        return `No computer control session is active on ${name}${last}. Ask for one with computer_control start, naming the machine and the apps: the owner approves it on a card.`;
    }

    /** The session a conversation's Pi controls a machine in: or why not. */
    sessionFor(machine: string, conversationId: number): ComputerSession {
        const session = this.active(machine);

        if (session === undefined) {
            throw new Error(this.noSession(machine, this.#options.machines().find((each) => each.id === machine)?.name));
        }

        if (session.conversationId !== conversationId) {
            throw new Error(`Session #${session.session}'s Pi is using ${session.machineName} until ${clockText(session.until)}: one session controls it at a time.`);
        }

        return session;
    }

    /** The session a conversation's Pi controls any machine in (the newest), or undefined. */
    sessionOfConversation(conversationId: number): ComputerSession | undefined {
        return this.sessions()
            .filter((each) => each.conversationId === conversationId)
            .at(-1);
    }

    /**
     * Start a session the owner approved: the window on the machine first (when the machine cannot show it, nothing
     * starts: nobody would see that Pi has the computer), then its ocu.
     */
    async start(given: Omit<ComputerSession, "startedAt" | "until"> & { minutes: number }): Promise<ComputerSession> {
        const { minutes, ...rest } = given;

        if (!Number.isInteger(minutes) || minutes < MINUTES.min || minutes > MINUTES.max) {
            throw new Error(`minutes is a whole number from ${MINUTES.min} to ${MINUTES.max}.`);
        }

        await this.end(given.machine, "a new session started");
        const startedAt = this.#now();
        const session: ComputerSession = { ...rest, startedAt, until: startedAt + minutes * 60_000 };
        // Stop pressed on the machine before ocu is up ends it as soon as it is.
        let stopped = false;
        const sign = await this.#sign(session, () => {
            if (this.#sessions.get(session.machine) === session) {
                void this.end(session.machine, "Stop on the computer");
            } else {
                stopped = true;
            }
        });
        let ocu: OcuClient;

        try {
            ocu = await this.#ocu(session.machine, (why) => void this.end(session.machine, why));
        } catch (error) {
            sign.stdin.end();
            sign.kill();

            throw new Error(`ocu did not start on ${session.machineName}: ${error instanceof Error ? error.message : String(error)}`);
        }

        this.#sessions.set(session.machine, session);
        this.#live.set(session.machine, {
            ocu,
            sign,
            outlines: new Map(),
            piOutlines: new Map(),
            frames: new Map(),
            tab: session.apps[0]!.name,
            doing: null,
            takenOver: false,
            busy: 0,
            typed: [],
        });
        this.#save();
        this.#arm(session);
        this.#log(`Computer control on ${session.machineName} started for session #${session.session}: ${session.apps.map((each) => each.label).join(", ")}.`);
        this.#changed();
        this.#panelChanged(session.machine);
        this.#startRefresh(session.machine);

        if (stopped) {
            await this.end(session.machine, "Stop on the computer");

            throw new Error(`Stop was pressed on ${session.machineName} as the session started: it is stopped.`);
        }

        return session;
    }

    /** The window on the machine that says Pi is using it, with Stop: shown, or why not. */
    async #sign(session: ComputerSession, onStop: () => void): Promise<OcuProcess> {
        const text = `Pi is using this computer until ${clockText(session.until)} (pi-phone)`;
        const machine = this.machine(session.machine);
        const windows = machine.platform === "windows";
        const sign = windows
            ? await this.#bridge(machine, (token) => ({ token, run: "sign", text }))
            : this.#options.launch(session.machine, this.#script(session.machine, `exec python3 -c ${q(SIGN)} ${q(text)}`));
        let said = "";

        sign.stderr.on("data", (chunk: Buffer) => {
            said = (said + chunk.toString()).slice(-2000);
        });

        await new Promise<void>((resolve, reject) => {
            let buffer = "";
            let shown = false;
            const timer = setTimeout(() => fail("it did not show in 20 s"), 20_000);
            const fail = (why: string) => {
                clearTimeout(timer);
                sign.kill();
                reject(
                    new Error(
                        `${session.machineName} could not show that Pi is using it, so the session did not start: ${said.trim().split("\n").at(-1) || why}. ${windows ? "pi-phone's bridge shows it with Windows Forms, in the signed-in desktop." : "It needs python3 with GTK 3 (python3-gi) on its desktop, as ocu does."}`,
                    ),
                );
            };

            sign.stdout.on("data", (chunk: Buffer) => {
                buffer += chunk.toString();

                for (let end = buffer.indexOf("\n"); end !== -1; end = buffer.indexOf("\n")) {
                    const line = buffer.slice(0, end).trim();

                    buffer = buffer.slice(end + 1);

                    if (line === "ready" && !shown) {
                        shown = true;
                        clearTimeout(timer);
                        resolve();
                    } else if (line === "stop") {
                        onStop();
                    }
                }
            });
            sign.once("exit", (code) => {
                if (!shown) {
                    fail(`it ended (exit ${code})`);
                } else {
                    void this.end(session.machine, "its window on the computer closed");
                }
            });
            sign.once("error", (error) => fail(error.message));
        });

        return sign;
    }

    #arm(session: ComputerSession): void {
        clearTimeout(this.#timers.get(session.machine));
        const timer = setTimeout(() => void this.end(session.machine, "time ran out"), Math.max(0, session.until - this.#now()) + 50);

        timer.unref();
        this.#timers.set(session.machine, timer);
    }

    /** End a machine's session (`why`: "time ran out", "Stop on the computer", …): its ocu and its window go. */
    async end(machine: string, why: string): Promise<boolean> {
        const session = this.#sessions.get(machine);
        const live = this.#live.get(machine);

        clearTimeout(this.#timers.get(machine));
        this.#timers.delete(machine);
        this.#stopRefresh(machine);

        if (session === undefined) {
            return false;
        }

        this.#sessions.delete(machine);
        this.#live.delete(machine);
        this.#kept.ended[machine] = { at: this.#now(), why };
        this.#save();

        if (live !== undefined) {
            live.ocu.close();
            live.sign.stdin.end();
            setTimeout(() => live.sign.kill(), 2000).unref();
        }

        this.#log(`Computer control on ${session.machineName} ended: ${why}.`);
        this.#changed();

        for (const listener of this.#panelListeners) {
            listener({ ...this.#panelBase(session), open: false, doing: null, takenOver: false });
        }

        return true;
    }

    /** Pi's run in `conversationId` ended: its sessions end a little later, unless a run starts again. */
    runEnded(conversationId: number): void {
        if (![...this.#sessions.values()].some((each) => each.conversationId === conversationId)) {
            return;
        }

        clearTimeout(this.#idle.get(conversationId));
        const timer = setTimeout(() => {
            this.#idle.delete(conversationId);

            for (const session of [...this.#sessions.values()].filter((each) => each.conversationId === conversationId)) {
                void this.end(session.machine, "Pi's turn ended");
            }
        }, this.#options.idleEndMs ?? IDLE_END_MS);

        timer.unref();
        this.#idle.set(conversationId, timer);
    }

    runStarted(conversationId: number): void {
        clearTimeout(this.#idle.get(conversationId));
        this.#idle.delete(conversationId);
    }

    // ─── Reading and acting ─────────────────────────────────────────────────

    #liveOf(session: ComputerSession): Live {
        const live = this.#live.get(session.machine);

        if (live === undefined) {
            throw new Error(this.noSession(session.machine, session.machineName));
        }

        return live;
    }

    /** An app of the session by its label or name (default: the panel's tab), checked: or why Pi may not touch it. */
    app(session: ComputerSession, wanted?: string): ComputerApp {
        const apps = [...session.apps, ...(session.followed ?? [])];
        const live = this.#liveOf(session);
        const name = (wanted ?? live.tab).trim().toLowerCase();
        const app = apps.find((each) => each.name.toLowerCase() === name) ?? apps.find((each) => each.label.toLowerCase() === name);

        if (app === undefined) {
            throw new Error(
                `${wanted} is not in this session (${apps.map((each) => `${each.label} (${each.name})`).join(", ")}): Pi does not read or touch it. Ask for it with computer_control start${session.follow === true ? "" : " (follow: true lets apps the named ones open join)"}.`,
            );
        }

        const never = this.neverReason(app);

        if (never !== undefined) {
            throw new Error(`${app.label} is ${never}: Pi never reads or controls it.`);
        }

        return app;
    }

    /** Pi may act now: not while the owner has taken the computer over. */
    #mayAct(live: Live): void {
        if (live.takenOver) {
            throw new Error("The owner took the computer over: wait until they hand it back (or ask them to).");
        }
    }

    /** A call to the session's ocu, the panel saying what Pi does meanwhile; its picture goes to the tabs that watch. */
    async #call(session: ComputerSession, app: ComputerApp, tool: string, args: Record<string, unknown>, doing: string | null, hit?: { frame: Frame; label: string }): Promise<OcuResult> {
        const live = this.#liveOf(session);

        live.busy += 1;

        if (doing !== null) {
            live.doing = doing;
            live.tab = app.name;
            this.#panelChanged(session.machine);
        }

        try {
            const result = await live.ocu.call(tool, { app: app.name, ...args });

            if (!result.isError && textOf(result).startsWith("App=")) {
                live.outlines.set(app.name, parseOutline(textOf(result)));
            }

            if (hit !== undefined) {
                live.hit = { app: app.name, ...hit };
            }

            const png = imageOf(result);

            if (png !== undefined) {
                this.#frame(session, live, app.name, png);
            }

            return result;
        } finally {
            live.busy -= 1;

            if (doing !== null) {
                live.doing = null;
                this.#panelChanged(session.machine);
            }
        }
    }

    #frame(session: ComputerSession, live: Live, app: string, png: string): void {
        const size = pngSize(png);

        if (size === undefined) {
            return;
        }

        const outline = live.outlines.get(app);
        const window = outline?.size;
        const hit = live.hit?.app === app && window !== undefined ? live.hit : undefined;
        const frame: ComputerFrame = {
            session: session.session,
            app,
            png,
            width: size.width,
            height: size.height,
            at: this.#now(),
            ...(hit === undefined || window === undefined
                ? {}
                : {
                      hit: {
                          x: hit.frame.x / window.width,
                          y: hit.frame.y / window.height,
                          width: hit.frame.width / window.width,
                          height: hit.frame.height / window.height,
                          label: hit.label,
                      },
                  }),
        };

        live.frames.set(app, frame);

        for (const listener of this.#frameListeners) {
            listener(frame);
        }
    }

    /** Pi reads an app's window: ocu's outline, as Pi then numbers its actions. */
    async screen(session: ComputerSession, wanted?: string, full = false): Promise<{ app: ComputerApp; text: string }> {
        const live = this.#liveOf(session);

        this.#mayAct(live);
        const app = this.app(session, wanted);
        const result = await this.#call(session, app, "get_app_state", full ? { text_limit: "max" } : {}, `Reading ${app.label}`);
        const text = textOf(result);

        if (result.isError) {
            throw new Error(`ocu could not read ${app.label}: ${hideTyped(text, live.typed)}`);
        }

        const outline = parseOutline(text);

        live.piOutlines.set(app.name, outline);

        return { app, text: shortTypedShowing(live.typed, outline) ? SHORT_TYPED_NOTE : hideTyped(text, live.typed) };
    }

    /** An element of the window as Pi read it last, still the same element in ocu's newest read: or why not. */
    element(session: ComputerSession, app: ComputerApp, index: number) {
        const live = this.#liveOf(session);
        const read = live.piOutlines.get(app.name);

        if (read === undefined) {
            throw new Error(`Read ${app.label} first (computer_screen): [n] numbers are from your newest read.`);
        }

        const element = read.elements.find((each) => each.index === index);

        if (element === undefined) {
            throw new Error(`There is no [${index}] in ${app.label} as you read it last: read it again.`);
        }

        const now = live.outlines.get(app.name)?.elements.find((each) => each.index === index);

        if (now === undefined || now.what !== element.what) {
            throw new Error(`[${index}] in ${app.label} is no longer what you read (the window changed): read it again with computer_screen.`);
        }

        return element;
    }

    /** The newest read of an app (whoever made it), for its focus. */
    outlineOf(session: ComputerSession, app: ComputerApp): ComputerOutline | undefined {
        return this.#liveOf(session).outlines.get(app.name);
    }

    /**
     * Pi acts in an app: checked here first (the app, the owner's hands, password fields, the element still the one read),
     * then ocu acts and answers with the window after it. With follow, an app that opens from it joins the session.
     * A password field takes only a saved secret by name (`secret`, `extensions/computer.ts`), never Pi's own text.
     */
    async act(
        session: ComputerSession,
        wanted: string | undefined,
        action:
            | { op: "click"; index?: number; x?: number; y?: number; count?: number; button?: "left" | "right" | "middle" }
            | { op: "set_value"; index: number; value: string; secret?: string }
            | { op: "type_text"; text: string; secret?: string }
            | { op: "press_key"; key: string }
            | { op: "scroll"; index: number; direction: "up" | "down" | "left" | "right"; pages?: number }
            | { op: "secondary_action"; index: number; name: string },
    ): Promise<{ app: ComputerApp; did: string; text: string; joined: ComputerApp[] }> {
        const live = this.#liveOf(session);

        this.#mayAct(live);
        const app = this.app(session, wanted);
        const outline = live.outlines.get(app.name);
        const element = "index" in action && action.index !== undefined ? this.element(session, app, action.index) : undefined;
        const named = element === undefined ? "" : `[${element.index}] ${element.name}`;
        let tool: string;
        let args: Record<string, unknown>;
        let did: string;

        switch (action.op) {
            case "click": {
                if (element === undefined && (action.x === undefined || action.y === undefined)) {
                    throw new Error("click needs index, or x and y in the window's picture.");
                }

                tool = "click";
                args = {
                    ...(element === undefined ? { x: action.x, y: action.y } : { element_index: String(element.index) }),
                    ...(action.count === undefined ? {} : { click_count: action.count }),
                    ...(action.button === undefined ? {} : { mouse_button: action.button }),
                };
                did = `${action.count === 2 ? "Double-clicked" : action.button === "right" ? "Right-clicked" : "Clicked"} ${element === undefined ? `(${action.x},${action.y})` : named}`;
                break;
            }

            // A saved secret by name (`secret`, its value in value or text): the one way Pi fills a password field, and
            // the only call of Pi's that tells ocu `allow_password_input`. What it did says the name, never the value.
            case "set_value": {
                if (element!.password && action.secret === undefined) {
                    throw new Error(`[${element!.index}] is a password field: Pi never types a password as text. Fill it with a saved secret by name (secret: "NAME", secrets_list), or ask the owner to type it with computer_sign_in.`);
                }

                tool = "set_value";
                args = { element_index: String(element!.index), value: action.value, ...(action.secret === undefined ? {} : { allow_password_input: true }) };
                did = `Set ${named} to ${action.secret === undefined ? JSON.stringify(action.value) : `[secret ${action.secret}]`}`;
                break;
            }

            case "type_text": {
                if (outline?.focusedPassword === true && action.secret === undefined) {
                    throw new Error(`The field in focus is a password field: Pi never types a password as text. Fill it with a saved secret by name (secret: "NAME", secrets_list), or ask the owner to type it with computer_sign_in.`);
                }

                tool = "type_text";
                args = { text: action.text, ...(action.secret === undefined ? {} : { allow_password_input: true }) };
                did = `Typed ${action.secret === undefined ? JSON.stringify(action.text) : `[secret ${action.secret}]`}`;
                break;
            }

            case "press_key": {
                if (typesCharacter(action.key) && outline?.focusedPassword === true) {
                    throw new Error(`The field in focus is a password field: Pi never types a password as text, a key at a time either. Fill it with a saved secret by name (secret: "NAME", secrets_list), or ask the owner to type it with computer_sign_in.`);
                }

                tool = "press_key";
                args = { key: action.key };
                did = `Pressed ${action.key}`;
                break;
            }

            case "scroll": {
                tool = "scroll";
                args = { element_index: String(element!.index), direction: action.direction, pages: action.pages ?? 1 };
                did = `Scrolled ${named} ${action.direction}`;
                break;
            }

            case "secondary_action": {
                tool = "perform_secondary_action";
                args = { element_index: String(element!.index), action: action.name };
                did = `${action.name} on ${named}`;
                break;
            }
        }

        const before = session.follow === true && session.apps.some((each) => each.name === app.name) ? await this.#appNames(live) : undefined;
        const hit =
            element?.frame !== undefined
                ? { frame: element.frame, label: `${tool === "click" ? "click" : tool === "set_value" ? "set" : tool === "scroll" ? "scroll" : "act"} [${element.index}]` }
                : action.op === "click" && action.x !== undefined && action.y !== undefined && outline?.size !== undefined
                  ? { frame: { x: action.x - 6, y: action.y - 6, width: 12, height: 12 }, label: "click" }
                  : undefined;
        const result = await this.#call(session, app, tool, args, `${did}`, hit);
        const filled = action.op === "set_value" ? action.value : action.op === "type_text" ? action.text : "";
        // A secret's value never comes back in what Pi reads (ocu does not read password fields; elsewhere, its name).
        // What the owner typed on a sign-in card never either (`computer-typed.ts`).
        const text = hideTyped("secret" in action && action.secret !== undefined && filled !== "" ? textOf(result).split(filled).join(`[secret ${action.secret}]`) : textOf(result), live.typed);

        if (result.isError) {
            throw new Error(`ocu: ${text}`);
        }

        const after = parseOutline(textOf(result));

        live.piOutlines.set(app.name, after);
        const joined = before === undefined ? [] : await this.#follow(session, live, before);

        return { app, did: `${did}.`, text: shortTypedShowing(live.typed, after) ? SHORT_TYPED_NOTE : text, joined };
    }

    async #appNames(live: Live): Promise<Set<string>> {
        const result = await live.ocu.call("list_apps", {});

        return new Set(parseApps(textOf(result)).map((app) => app.name));
    }

    /** Apps that came up after Pi acted in a named app join a session that follows along (never the Never list). */
    async #follow(session: ComputerSession, live: Live, before: Set<string>): Promise<ComputerApp[]> {
        const now = parseApps(textOf(await live.ocu.call("list_apps", {})));
        const known = new Set([...session.apps, ...(session.followed ?? [])].map((each) => each.name));
        const joined = now
            .filter((app) => app.running && !before.has(app.name) && !known.has(app.name) && this.neverReason(app) === undefined)
            .map((app) => ({ label: app.window || app.name, name: app.name }));

        if (joined.length > 0) {
            session.followed = [...(session.followed ?? []), ...joined];
            this.#save();
            this.#log(`Computer control on ${session.machineName} follows into ${joined.map((each) => each.name).join(", ")}.`);
            this.#changed();
            this.#panelChanged(session.machine);
        }

        return joined;
    }

    /**
     * A picture of an app's window (PNG), read now, with the window's size in its picture's pixels, and where it must be
     * blacked out before a model gets it (`hidden`, window points: what the owner typed on a sign-in card).
     */
    async picture(session: ComputerSession, wanted?: string): Promise<{ app: ComputerApp; png: string; width: number; height: number; text: string; hidden: Frame[] }> {
        const live = this.#liveOf(session);

        this.#mayAct(live);
        const app = this.app(session, wanted);
        const result = await this.#call(session, app, "get_app_state", {}, `Looking at ${app.label}`);
        const png = imageOf(result);
        const size = png === undefined ? undefined : pngSize(png);

        if (result.isError || png === undefined || size === undefined) {
            throw new Error(`ocu sent no picture of ${app.label}${result.isError ? `: ${hideTyped(textOf(result), live.typed)}` : " (its window may be hidden or too small)"}.`);
        }

        const outline = parseOutline(textOf(result));

        live.piOutlines.set(app.name, outline);

        if (shortTypedShowing(live.typed, outline)) {
            throw new Error(SHORT_TYPED_NOTE);
        }

        return { app, png, ...size, text: hideTyped(textOf(result), live.typed), hidden: typedAreas(live.typed, outline) };
    }

    /**
     * The owner's values from a computer_sign_in card (PP-183), each into the element Pi named, as ocu's set_value with
     * `allow_password_input` (the owner's own, a password field too). Each is kept first, so it stays out of all Pi reads
     * of the window from then on (`computer-typed.ts`), whatever ocu answers; an error never quotes it.
     */
    async fill(session: ComputerSession, wanted: string, fields: readonly { name: "username" | "password" | "code"; index: number; value: string }[]): Promise<void> {
        const live = this.#liveOf(session);
        const app = this.app(session, wanted);

        for (const field of fields) {
            const element = this.element(session, app, field.index);

            if (field.name === "username" && element.password) {
                throw new Error(`[${field.index}] in ${app.label} is a password field, not a username field.`);
            }

            live.typed.push({ what: element.what, value: field.value, password: element.password, mask: `[${field.name} for ${app.label}]` });
            const result = await this.#call(
                session,
                app,
                "set_value",
                { element_index: String(element.index), value: field.value, allow_password_input: true },
                `Filling in the sign-in in ${app.label}`,
                element.frame === undefined ? undefined : { frame: element.frame, label: `set [${element.index}]` },
            );

            if (result.isError) {
                throw new Error(`ocu could not fill [${element.index}] in ${app.label}: ${hideTyped(textOf(result), live.typed)}`);
            }
        }
    }

    // ─── The panel ──────────────────────────────────────────────────────────

    #panelBase(session: ComputerSession): ComputerPanel {
        const live = this.#live.get(session.machine);

        return {
            session: session.session,
            conversationId: session.conversationId,
            machine: session.machine,
            machineName: session.machineName,
            apps: [...session.apps, ...(session.followed ?? [])],
            tab: live?.tab ?? session.apps[0]!.name,
            doing: live?.doing ?? null,
            takenOver: live?.takenOver ?? false,
            until: session.until,
            open: live !== undefined,
        };
    }

    /** What the panel of a machine's session shows, or undefined without one. */
    panelOf(machine: string): ComputerPanel | undefined {
        const session = this.#sessions.get(machine);

        return session === undefined ? undefined : this.#panelBase(session);
    }

    /** The panel of a session (by its number), and its newest picture of the tab shown. */
    panelOfSession(sessionNumber: number): { panel: ComputerPanel; frame?: ComputerFrame } | undefined {
        const session = [...this.#sessions.values()].find((each) => each.session === sessionNumber);

        if (session === undefined) {
            return undefined;
        }

        const panel = this.#panelBase(session);
        const frame = this.#live.get(session.machine)?.frames.get(panel.tab);

        return { panel, ...(frame === undefined ? {} : { frame }) };
    }

    #bySession(sessionNumber: number): { session: ComputerSession; live: Live } {
        const session = [...this.#sessions.values()].find((each) => each.session === sessionNumber);
        const live = session === undefined ? undefined : this.#live.get(session.machine);

        if (session === undefined || live === undefined) {
            throw new Error("This session controls no computer now.");
        }

        return { session, live };
    }

    /** A tab watches a session's panel (or stops): while any watches, its picture is read again every few seconds. */
    watch(sessionNumber: number, on: boolean): void {
        const found = [...this.#sessions.values()].find((each) => each.session === sessionNumber);

        if (found === undefined) {
            return;
        }

        const count = Math.max(0, (this.#watchers.get(found.machine) ?? 0) + (on ? 1 : -1));

        this.#watchers.set(found.machine, count);

        if (on) {
            void this.#refreshOnce(found.machine);
        }
    }

    #startRefresh(machine: string): void {
        this.#stopRefresh(machine);
        const timer = setInterval(() => {
            if ((this.#watchers.get(machine) ?? 0) > 0) {
                void this.#refreshOnce(machine);
            }
        }, this.#options.refreshMs ?? REFRESH_MS);

        timer.unref();
        this.#refresh.set(machine, timer);
    }

    #stopRefresh(machine: string): void {
        clearInterval(this.#refresh.get(machine));
        this.#refresh.delete(machine);
    }

    /** Read the tab shown again for its picture, unless Pi is acting (its action brings one). */
    async #refreshOnce(machine: string): Promise<void> {
        const session = this.#sessions.get(machine);
        const live = this.#live.get(machine);

        if (session === undefined || live === undefined || live.busy > 0) {
            return;
        }

        const app = [...session.apps, ...(session.followed ?? [])].find((each) => each.name === live.tab);

        if (app === undefined || this.neverReason(app) !== undefined) {
            return;
        }

        await this.#call(session, app, "get_app_state", {}, null).catch((error: unknown) =>
            this.#log(`Computer control's panel could not read ${app.label}: ${error instanceof Error ? error.message : String(error)}`),
        );
    }

    /** The panel shows another of the session's windows. */
    async setTab(sessionNumber: number, name: string): Promise<ComputerPanel> {
        const { session, live } = this.#bySession(sessionNumber);
        const app = this.app(session, name);

        live.tab = app.name;
        this.#panelChanged(session.machine);
        await this.#refreshOnce(session.machine);

        return this.#panelBase(session);
    }

    /** The owner takes the computer over (Pi waits), or hands it back. */
    takeOver(sessionNumber: number, on: boolean): ComputerPanel {
        const { session, live } = this.#bySession(sessionNumber);

        live.takenOver = on;
        this.#panelChanged(session.machine);

        return this.#panelBase(session);
    }

    /**
     * What the owner does on the window while they have it (Take over): a tap is ocu's click at that point of the picture;
     * text and keys go to the field in focus, a password field too (the owner's own: these calls alone tell ocu
     * `allow_password_input`, so its guard stays for Pi's). What they type is never logged, shown on the panel, or kept.
     * Answers whether the focus is in a password field now, for the panel's keyboard.
     */
    async input(
        sessionNumber: number,
        given: { type: "tap"; x: number; y: number } | { type: "text"; text: string } | { type: "key"; key: string },
    ): Promise<{ password: boolean }> {
        const { session, live } = this.#bySession(sessionNumber);

        if (!live.takenOver) {
            throw new Error("Take the computer over first.");
        }

        const app = this.app(session, live.tab);
        const KEYS: Record<string, string> = { Enter: "Return", Backspace: "BackSpace", Tab: "Tab", Escape: "Escape", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
        let result: OcuResult;

        if (given.type === "tap") {
            if (!Number.isFinite(given.x) || !Number.isFinite(given.y)) {
                throw new Error("A tap needs x and y in the picture.");
            }

            result = await this.#call(session, app, "click", { x: Math.round(given.x), y: Math.round(given.y) }, null, { frame: { x: given.x - 6, y: given.y - 6, width: 12, height: 12 }, label: "tap" });
        } else if (given.type === "text") {
            result = await this.#call(session, app, "type_text", { text: given.text, allow_password_input: true }, null);
        } else {
            const key = KEYS[given.key];

            if (key === undefined) {
                throw new Error(`The keys are ${Object.keys(KEYS).join(", ")}.`);
            }

            result = await this.#call(session, app, "press_key", { key, allow_password_input: true }, null);
        }

        if (result.isError) {
            // ocu's message, never what was typed.
            throw new Error(given.type === "text" && given.text !== "" ? `ocu could not type there: ${textOf(result).split(given.text).join("…")}` : textOf(result));
        }

        return { password: live.outlines.get(app.name)?.focusedPassword === true };
    }

    /** The sessions as the owner's tabs and Menu › Computer control show them. */
    view(): { machine: string; machineName: string; conversationId: number; session: number; apps: ComputerApp[]; follow: boolean; until: number }[] {
        return this.sessions().map((each) => ({
            machine: each.machine,
            machineName: each.machineName,
            conversationId: each.conversationId,
            session: each.session,
            apps: [...each.apps, ...(each.followed ?? [])],
            follow: each.follow === true,
            until: each.until,
        }));
    }

    /** Each machine as Menu › Computer control lists it: its system, ocu, its desktop's setup line, and its session. */
    machinesView(): { id: string; name: string; platform: string | null; connected: boolean; ocu: string | null; prepare: string; session: ReturnType<ComputerControl["view"]>[number] | null; ended: Ended | null }[] {
        const sessions = this.view();

        return this.#options.machines().map((machine) => ({
            id: machine.id,
            name: machine.name,
            platform: machine.platform ?? null,
            connected: machine.connected,
            ocu: machine.tools?.ocu ?? null,
            prepare: this.prepareOf(machine.id),
            session: sessions.find((each) => each.machine === machine.id) ?? null,
            ended: this.#kept.ended[machine.id] ?? null,
        }));
    }

    close(): void {
        for (const machine of [...this.#sessions.keys()]) {
            void this.end(machine, "pi-phone stopped");
        }

        for (const timer of this.#idle.values()) {
            clearTimeout(timer);
        }
    }
}
