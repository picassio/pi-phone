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
};

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
};

const FRAME = /\s*Frame: \{x: (-?\d+(?:\.\d+)?), y: (-?\d+(?:\.\d+)?), width: (\d+(?:\.\d+)?), height: (\d+(?:\.\d+)?)\}/;
const PASSWORD = "[password]";

export function parseOutline(text: string): ComputerOutline {
    const lines = text.split("\n");
    const app = /^App=(.*?)(?: \(pid \d+\))?$/.exec(lines[0] ?? "")?.[1] ?? "";
    const window = /^Window: "(.*)", App: /.exec(lines[1] ?? "")?.[1] ?? "";
    const elements: ComputerElement[] = [];
    let focused: string | undefined;

    for (const line of lines) {
        const element = /^\t*(\d+) (.*)$/.exec(line);

        if (element !== null) {
            const rest = element[2]!;
            const frame = FRAME.exec(rest);

            const what = rest.replace(FRAME, "").replace(/ Value: .*?(?= Secondary Actions: |$)/, "").trim();
            const value = / Value: (.*?)(?= Secondary Actions: |$)/.exec(rest.replace(FRAME, ""))?.[1];

            elements.push({
                index: Number(element[1]),
                what,
                name: what.replace(/\s*Secondary Actions:.*$/, "").trim(),
                ...(value === undefined ? {} : { value }),
                ...(frame === null ? {} : { frame: { x: Number(frame[1]), y: Number(frame[2]), width: Number(frame[3]), height: Number(frame[4]) } }),
                password: rest.includes(PASSWORD) || /^password text\b/.test(rest),
            });
            continue;
        }

        const focus = /^The focused UI element is (.*)\.$/.exec(line.trim());

        if (focus !== null) {
            focused = focus[1];
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
