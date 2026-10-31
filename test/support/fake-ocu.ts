// A stand-in for open-computer-use on a machine (PP-178), as the fake phone stands in for the phone's service: run with
// `mcp`, it answers ocu's MCP over stdio (list_apps, get_app_state with a PNG of the window, click, set_value,
// type_text, press_key, scroll, perform_secondary_action) for a few desktop apps, keeping each app's last read as ocu
// does, and refusing input into a password field as pi-phone's ocu build does; run with `sign`, it is the window that
// says Pi uses the machine: `ready`, then gone when its input closes. Every call it got goes to FAKE_OCU_LOG (a file),
// one JSON line each.
//
// Apps: demo_app.py ("Pi OCU Demo": a name field, a password field, Shout, Greet, a label, Help, which opens the help
// viewer), gedit ("Text Editor"), 1Password (never), ticker ("Ticker": its numbers move with every read).
// FAKE_SIGN=fail: the window cannot show (no GTK). FAKE_SIGN=stop: Stop is pressed 300 ms after it shows.
//
// As pi-phone's ocu 1.1.2-pp.3 (PP-270): each read has `Snapshot: s<n>` and `Window id:`, elements carry `States:`
// (focused, checked, secure), and refusals end with an `Error:` line. An action whose snapshot_id is not the app's
// latest read, or whose window_id is not its window, is refused with stale_ref, and so is the next element action after
// the file FAKE_OCU_STALE names appears (the file goes); a click at a point needs headed: true (policy_denied).
// FAKE_OCU_COVER=1 adds viewer ("Viewer": another window over part of it, and a second window of its app) and notes
// ("Notes": minimised, no picture).
import { appendFileSync, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { deflateSync } from "node:zlib";

const mode = process.argv[2];

if (mode === "sign") {
    if (process.env.FAKE_SIGN === "fail") {
        process.stderr.write("ModuleNotFoundError: No module named 'gi'\n");
        process.exit(1);
    }

    process.stdout.write("ready\n");

    if (process.env.FAKE_SIGN === "stop") {
        setTimeout(() => process.stdout.write("stop\n"), 300);
    }

    process.stdin.on("data", () => {});
    process.stdin.on("end", () => process.exit(0));
} else {
    serve();
}

/** A white PNG of `width` x `height`. */
function png(width: number, height: number): string {
    const crc = (bytes: Buffer) => {
        let c = ~0;

        for (const byte of bytes) {
            c ^= byte;

            for (let k = 0; k < 8; k++) {
                c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
            }
        }

        return ~c >>> 0;
    };
    const chunk = (type: string, data: Buffer) => {
        const out = Buffer.alloc(12 + data.length);

        out.writeUInt32BE(data.length, 0);
        out.write(type, 4, "ascii");
        data.copy(out, 8);
        out.writeUInt32BE(crc(out.subarray(4, 8 + data.length)), 8 + data.length);

        return out;
    };
    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header.writeUInt8(8, 8);
    header.writeUInt8(2, 9);
    const rows = Buffer.alloc((width * 3 + 1) * height, 255);

    for (let row = 0; row < height; row++) {
        rows[row * (width * 3 + 1)] = 0;
    }

    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]).toString("base64");
}

type Element = { role: string; name: string; value?: string; password?: boolean; editable?: boolean; frame: [number, number, number, number]; actions?: string; states?: string[] };

/** A refusal as pi-phone's ocu 1.1.2-pp.3 words it: the message, then its machine-readable line. */
const refusal = (message: string, code: string, suggestion: string) => `${message}\nError: ${code} retry=safe suggestion=${suggestion}`;

function serve(): void {
    const state = { name: "", secret: "", shout: false, label: "Nobody greeted yet", focus: 2, help: false, editor: "", ticks: 0 };
    const read = new Map<string, Element[]>();
    /** Each app's latest read, as ocu keeps it. */
    const latest = new Map<string, string>();
    let reads = 0;
    const cover = process.env.FAKE_OCU_COVER === "1";
    const picture = png(420, 220);
    const log = (entry: Record<string, unknown>) => {
        if (process.env.FAKE_OCU_LOG !== undefined) {
            appendFileSync(process.env.FAKE_OCU_LOG, `${JSON.stringify(entry)}\n`);
        }
    };

    const windows: Record<string, { title: string; elements: () => Element[] }> = {
        "demo_app.py": {
            title: "Pi OCU Demo",
            elements: () => [
                { role: "frame", name: "Pi OCU Demo", frame: [0, 0, 420, 220] },
                { role: "filler", name: "", frame: [12, 12, 396, 196] },
                { role: "text", name: "", value: state.name, editable: true, frame: [12, 12, 396, 34], actions: "activate" },
                { role: "password text", name: "", value: state.secret === "" ? "" : "\u25cf".repeat(state.secret.length), password: true, editable: true, frame: [12, 54, 396, 34], actions: "activate", states: ["secure"] },
                { role: "check box", name: "Shout", frame: [12, 96, 396, 21], actions: "click", ...(state.shout ? { states: ["checked"] } : {}) },
                { role: "push button", name: "Greet", frame: [12, 125, 396, 34], actions: "click" },
                { role: "label", name: state.label, frame: [12, 167, 396, 17] },
                { role: "push button", name: "Help", frame: [12, 190, 80, 24], actions: "click" },
            ],
        },
        gedit: {
            title: "Text Editor",
            elements: () => [
                { role: "frame", name: "Text Editor", frame: [0, 0, 420, 220] },
                { role: "text", name: "Document", value: state.editor, editable: true, frame: [10, 10, 400, 200], actions: "activate" },
            ],
        },
        "1password": { title: "1Password", elements: () => [{ role: "frame", name: "1Password", frame: [0, 0, 420, 220] }] },
        ticker: {
            title: "Ticker",
            elements: () => [
                { role: "frame", name: "Ticker", frame: [0, 0, 420, 220] },
                ...(state.ticks % 2 === 1 ? [{ role: "label", name: "Notice", frame: [10, 10, 100, 20] } as Element] : []),
                { role: "push button", name: "OK", frame: [10, 40, 100, 30], actions: "click" },
            ],
        },
        "help-viewer": { title: "Help", elements: () => [{ role: "frame", name: "Help", frame: [0, 0, 420, 220] }] },
        viewer: {
            title: "Viewer",
            elements: () => [
                { role: "frame", name: "Viewer", frame: [0, 0, 420, 220] },
                { role: "push button", name: "Open", frame: [10, 10, 100, 30], actions: "click" },
            ],
        },
        notes: { title: "Notes", elements: () => [{ role: "frame", name: "Notes", frame: [0, 0, 420, 220] }] },
    };
    const running = () => Object.keys(windows).filter((name) => (name !== "help-viewer" || state.help) && ((name !== "viewer" && name !== "notes") || cover));

    const render = (app: string): string => {
        const elements = windows[app]!.elements();
        const focused = app === "demo_app.py" ? elements[state.focus] : undefined;
        const snapshot = `s${++reads}`;

        read.set(app, elements);
        latest.set(app, snapshot);

        return [
            `App=${app} (pid 4242)`,
            `Window: "${windows[app]!.title}", App: ${app}.`,
            `Snapshot: ${snapshot}`,
            `Window id: 4242:${Object.keys(windows).indexOf(app) + 6}`,
            ...(app === "viewer" ? ['Other windows: 4242:99 "Viewer 2" (viewer)', "Covered: [{x: 300, y: 0, width: 120, height: 80}] (other windows; blacked out in the screenshot)"] : []),
            ...elements.map((each, index) => {
                const value = each.value === undefined || each.value === "" ? "" : ` Value: ${each.value}`;

                const title = [each.name, each.password ? "[password]" : ""].filter((part) => part !== "").join(" ");
                const states = [...(each.states ?? []), ...(each === focused ? ["focused"] : [])];

                return `${"\t".repeat(index === 0 ? 1 : index === 1 ? 2 : 3)}${index} ${each.role} ${title}${value}${each.actions === undefined ? "" : ` Secondary Actions: ${each.actions}`}${states.length === 0 ? "" : ` States: ${states.join(", ")}`} Frame: {x: ${each.frame[0]}, y: ${each.frame[1]}, width: ${each.frame[2]}, height: ${each.frame[3]}}`;
            }),
            ...(app === "notes" ? ["Screenshot omitted: the window is minimised. Restore it, then read it again."] : []),
            ...(focused === undefined ? [] : ["", `The focused UI element is ${focused.role}${focused.password ? " [password]" : ""}.`]),
        ].join("\n");
    };
    const state_ = (app: string) => {
        const text = render(app);

        return { content: [{ type: "text", text }, ...(app === "notes" ? [] : [{ type: "image", data: picture, mimeType: "image/png" }])], isError: false };
    };
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });
    const stale = (message: string) => fail(refusal(message, "stale_ref", "Call get_app_state again and act on its element numbers and snapshot id."));

    const call = (name: string, args: Record<string, unknown>): Record<string, unknown> => {
        if (name === "list_apps") {
            return { content: [{ type: "text", text: running().map((app) => `${app} -- ${app} [running, pid=4242, window=${windows[app]!.title}]`).join("\n") }], isError: false };
        }

        const app = String(args.app ?? "");

        if (!running().includes(app)) {
            return fail(`appNotFound("${app}")`);
        }

        if (name === "get_app_state") {
            if (app === "ticker") {
                state.ticks += 1;
            }

            return state_(app);
        }

        const elements = read.get(app);

        if (elements === undefined) {
            return fail(`No app state is available for ${app}. Run get_app_state before action tools.`);
        }

        const index = args.element_index === undefined ? undefined : Number(args.element_index);
        const element = index === undefined ? undefined : elements[index];

        if (index !== undefined && element === undefined) {
            return fail(refusal(`unknown element_index "${index}"`, "not_found", "Use an element number from the latest get_app_state."));
        }

        if (args.snapshot_id !== undefined && args.snapshot_id !== latest.get(app)) {
            return stale(`Snapshot ${String(args.snapshot_id)} is not the latest read of ${app} (the latest is ${latest.get(app)}).`);
        }

        if (args.window_id !== undefined && args.window_id !== `4242:${Object.keys(windows).indexOf(app) + 6}`) {
            return stale(`The latest read of ${app} is not of window ${String(args.window_id)}.`);
        }

        const staleOnce = process.env.FAKE_OCU_STALE;

        if (element !== undefined && staleOnce !== undefined && existsSync(staleOnce)) {
            rmSync(staleOnce);

            return stale(`[${index}] is no longer the ${element.role} '${element.name}' that the snapshot saw (it changed or went away).`);
        }

        if (name === "click" && element === undefined && args.headed !== true) {
            return fail(refusal("Refused: a coordinate or global click is physical input (it moves the real pointer or keyboard) and needs headed: true on the call.", "policy_denied", "Use an element_index action; physical input needs headed: true, which only the host sends."));
        }

        const refused = refusal("Refused: the target is a password field. Open Computer Use (pi-phone build) does not type into password fields.", "password_field", "Do not type into a password field; ask the person to type it.");
        // pi-phone's ocu 1.1.2-pp.2: one call may opt out (the owner typing, a saved secret by name), only with true.
        const allowed = args.allow_password_input === true;
        const focusedPassword = app === "demo_app.py" && windows[app]!.elements()[state.focus]?.password === true;

        switch (name) {
            case "click": {
                // A click at a point of the picture focuses the field there, as a real click does.
                if (app === "demo_app.py" && element === undefined && typeof args.x === "number" && typeof args.y === "number") {
                    const [x, y] = [args.x, args.y];
                    const at = elements.findIndex((each) => each.editable === true && x >= each.frame[0] && x < each.frame[0] + each.frame[2] && y >= each.frame[1] && y < each.frame[1] + each.frame[3]);

                    if (at !== -1) {
                        state.focus = at;
                    }
                }

                if (app === "demo_app.py" && element !== undefined) {
                    if (element.editable) {
                        state.focus = index!;
                    } else if (element.name === "Shout") {
                        state.shout = !state.shout;
                    } else if (element.name === "Greet") {
                        const text = `Hello, ${state.name || "stranger"}!`;

                        state.label = state.shout ? text.toUpperCase() : text;
                    } else if (element.name === "Help") {
                        state.help = true;
                    }
                }

                break;
            }

            case "set_value": {
                if (element?.password && !allowed) {
                    return fail(refused);
                }

                if (app === "demo_app.py" && index === 2) {
                    state.name = String(args.value);
                } else if (app === "demo_app.py" && index === 3) {
                    state.secret = String(args.value);
                } else if (app === "gedit") {
                    state.editor = String(args.value);
                }

                break;
            }

            case "type_text": {
                if (app === "demo_app.py") {
                    if (focusedPassword && !allowed) {
                        return fail(refused);
                    }

                    if (focusedPassword) {
                        state.secret += String(args.text);
                    } else {
                        state.name += String(args.text);
                    }
                } else if (app === "gedit") {
                    state.editor += String(args.text);
                }

                break;
            }

            case "press_key": {
                if (focusedPassword && !allowed && /^(shift\+)?(.|space)$/.test(String(args.key))) {
                    return fail(refused);
                }

                if (app === "demo_app.py" && args.key === "Tab") {
                    state.focus = state.focus === 2 ? 3 : 2;
                }

                break;
            }

            case "scroll":
            case "perform_secondary_action":
                break;

            default:
                return fail(`unsupportedTool("${name}")`);
        }

        return state_(app);
    };

    createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } };

        if (request.method === "initialize") {
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "open-computer-use", version: "1.1.2-pp.3" }, capabilities: { tools: {} } } })}\n`);
        } else if (request.method === "tools/call") {
            log({ tool: request.params!.name, args: request.params!.arguments ?? {} });
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: call(request.params!.name!, request.params!.arguments ?? {}) })}\n`);
        }
    });
    process.stdin.on("end", () => process.exit(0));
}
