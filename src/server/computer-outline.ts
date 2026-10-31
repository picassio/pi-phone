/**
 * An app's window as ocu reads it (`get_app_state`, PP-178), for pi-phone's own checks: its numbered elements (with
 * their frames in the window, and whether each is a password field, which pi-phone's ocu build marks `[password]`), and
 * the element in focus. Pi reads ocu's text as it is; this is what pi-phone checks an action against.
 *
 *   App=demo_app.py (pid 27702)
 *   Window: "Pi OCU Demo", App: demo_app.py.
 *   \t0 frame Pi OCU Demo Frame: {x: 0, y: 0, width: 420, height: 220}
 *   \t\t3 password text [password] Secondary Actions: activate Frame: {x: 12, y: 54, width: 396, height: 34}
 *
 *   The focused UI element is password text [password].
 *
 * pi-phone's ocu 1.1.2-pp.3 (PP-270) adds, after the `Window:` line, `Snapshot: <id>` (this read), `Window id: <id>`,
 * `Other windows: <id> "title" (app), …` when the app's name matches more windows, and `Covered: [{x, y, width, height},
 * …] (…)` for the parts other windows cover (black in the picture), or `Covered: unknown (…)`; element lines carry
 * ` States: checked, focused` (before `Frame:`); a window with no picture says `Screenshot omitted: …`, and a refusal
 * ends with `Error: <code> retry=<safe|unsafe> suggestion=<text>`.
 */

export type Frame = { x: number; y: number; width: number; height: number };

export type ComputerElement = {
    index: number;
    /**
     * What it is (its role, name and actions, without its value and frame): to tell whether `[n]` is still the same
     * element, whatever was typed into it since.
     */
    what: string;
    /** Its role and name, for saying what Pi acted on. */
    name: string;
    /** What it holds, as ocu shows it (`Value: …`), if it shows one. */
    value?: string;
    frame?: Frame;
    password: boolean;
    /** Its states, as ocu names them (checked, selected, expanded, collapsed, focused, disabled, readonly, secure), if any. */
    states?: string[];
};

/** Another window the app's name matches, which ocu reads with its id. */
export type OtherWindow = { id: string; title: string; app: string };

/** What covers the window: parts of it (black in the picture), all of it, or it is minimised; unknown when ocu cannot tell. */
export type Cover = "partial" | "full" | "minimized" | "unknown";

export type ComputerOutline = {
    app: string;
    window: string;
    elements: ComputerElement[];
    /** The focused element's summary, if ocu named one. */
    focused?: string;
    /** The element in focus is a password field: Pi never types or presses a character there. */
    focusedPassword: boolean;
    /** The window's size, from its root element's frame (window points). */
    size?: { width: number; height: number };
    /** This read's id (`Snapshot:`): an action names it so ocu refuses it once the window was read again or changed. */
    snapshot?: string;
    /** The window's id (`Window id:`), and the other windows the app's name matches (`Other windows:`). */
    windowId?: string;
    otherWindows?: OtherWindow[];
    /** What covers the window, and the covered parts (window points), black in its picture. */
    cover?: Cover;
    covered?: Frame[];
    /** Why the read has no picture, as ocu says it (`Screenshot omitted: …`). */
    omitted?: string;
};

/** The machine-readable line of an ocu refusal or failure: `Error: <code> retry=<safe|unsafe> suggestion=<text>`. */
export type OcuError = { code: string; retry: "safe" | "unsafe"; suggestion: string };

const FRAME = /\s*Frame: \{x: (-?\d+(?:\.\d+)?), y: (-?\d+(?:\.\d+)?), width: (\d+(?:\.\d+)?), height: (\d+(?:\.\d+)?)\}/;
const PASSWORD = "[password]";
const STATE = "checked|selected|expanded|collapsed|focused|disabled|readonly|secure";
/** ` States: …` at the end of an element's line once its frame is cut off. */
const STATES = new RegExp(` States: ((?:${STATE})(?:, (?:${STATE}))*)$`);
const RECT = /\{x: (-?\d+(?:\.\d+)?), y: (-?\d+(?:\.\d+)?), width: (\d+(?:\.\d+)?), height: (\d+(?:\.\d+)?)\}/g;

/** The `Error:` line of an ocu result's text, if it has one. */
export function parseError(text: string): OcuError | undefined {
    const found = /^Error: (\w+) retry=(safe|unsafe) suggestion=(.*)$/m.exec(text);

    return found === null ? undefined : { code: found[1]!, retry: found[2] as "safe" | "unsafe", suggestion: found[3]!.trim() };
}

/** An ocu message without its `Error:` line. */
export const withoutErrorLine = (text: string): string => text.replace(/\n?^Error: \w+ retry=(?:safe|unsafe) suggestion=.*$/m, "").trim();

export function parseOutline(text: string): ComputerOutline {
    const lines = text.split("\n");
    const app = /^App=(.*?)(?: \(pid \d+\))?$/.exec(lines[0] ?? "")?.[1] ?? "";
    const window = /^Window: "(.*)", App: /.exec(lines[1] ?? "")?.[1] ?? "";
    const elements: ComputerElement[] = [];
    let focused: string | undefined;
    const extra: Partial<ComputerOutline> = {};

    for (const line of lines) {
        const element = /^\t*(\d+) (.*)$/.exec(line);

        if (element !== null) {
            const rest = element[2]!;
            const frame = FRAME.exec(rest);
            // What an element is leaves out its value and its states (focus, a tick), which change while it stays the
            // same element.
            const unframed = rest.replace(FRAME, "");
            const states = STATES.exec(unframed)?.[1]?.split(", ");
            const bare = unframed.replace(STATES, "");
            const what = bare.replace(/ Value: .*?(?= Secondary Actions: |$)/, "").trim();
            const value = / Value: (.*?)(?= Secondary Actions: |$)/.exec(bare)?.[1];

            elements.push({
                index: Number(element[1]),
                what,
                name: what.replace(/\s*Secondary Actions:.*$/, "").trim(),
                ...(value === undefined ? {} : { value }),
                ...(frame === null ? {} : { frame: { x: Number(frame[1]), y: Number(frame[2]), width: Number(frame[3]), height: Number(frame[4]) } }),
                password: rest.includes(PASSWORD) || /^password text\b/.test(rest),
                ...(states === undefined ? {} : { states }),
            });
            continue;
        }

        const focus = /^The focused UI element is (.*)\.$/.exec(line.trim());

        if (focus !== null) {
            focused = focus[1];
            continue;
        }

        const snapshot = /^Snapshot: (\S+)$/.exec(line);
        const windowId = /^Window id: (\S+)$/.exec(line);
        const others = /^Other windows: (.*)$/.exec(line);
        const covered = /^Covered: (.*)$/.exec(line);

        if (snapshot !== null) {
            extra.snapshot = snapshot[1]!;
        } else if (windowId !== null) {
            extra.windowId = windowId[1]!;
        } else if (others !== null) {
            extra.otherWindows = [...others[1]!.matchAll(/(\S+) "((?:[^"\\]|\\.)*)" \(([^)]*)\)/g)].map((each) => ({ id: each[1]!, title: each[2]!.replace(/\\(.)/g, "$1"), app: each[3]! }));
        } else if (covered !== null) {
            extra.cover = covered[1]!.startsWith("unknown") ? "unknown" : /\(the whole window\)$/.test(covered[1]!) ? "full" : "partial";
            extra.covered = [...covered[1]!.matchAll(RECT)].map((each) => ({ x: Number(each[1]), y: Number(each[2]), width: Number(each[3]), height: Number(each[4]) }));
        } else if (/^Screenshot (?:omitted: (?!.*include_screenshot)|unavailable\.)/.test(line.trim())) {
            extra.omitted = line.trim();

            if (/minimi[sz]ed/.test(line)) {
                extra.cover = "minimized";
            }
        }
    }

    const root = elements.find((each) => each.index === 0)?.frame;

    return {
        app,
        window,
        elements,
        ...(focused === undefined ? {} : { focused }),
        focusedPassword: focused !== undefined && (focused.includes(PASSWORD) || /^password text\b/.test(focused)),
        ...(root === undefined ? {} : { size: { width: root.width, height: root.height } }),
        ...extra,
    };
}

/** A PNG's width and height, from its header. */
export function pngSize(base64: string): { width: number; height: number } | undefined {
    const bytes = Buffer.from(base64.slice(0, 64), "base64");

    if (bytes.length < 24 || bytes.toString("ascii", 1, 4) !== "PNG") {
        return undefined;
    }

    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** One app as `list_apps` names it: `name -- id [running, pid=…, window=Title]`. */
export type DesktopApp = { name: string; id: string; window: string; running: boolean };

export function parseApps(text: string): DesktopApp[] {
    return text
        .split("\n")
        .map((line) => /^(.*?) -- (.*?)(?: \[(.*)\])?$/.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null)
        .map((match) => {
            const details = match[3] ?? "";

            return {
                name: match[1]!,
                id: match[2]!,
                window: /window=(.*?)(?:,\s*\w+=|$)/.exec(details)?.[1]?.trim() ?? "",
                running: /\brunning\b/.test(details),
            };
        });
}
