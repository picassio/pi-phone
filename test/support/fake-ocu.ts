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
import { appendFileSync } from "node:fs";
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

type Element = { role: string; name: string; value?: string; password?: boolean; editable?: boolean; frame: [number, number, number, number]; actions?: string };

function serve(): void {
    const state = { name: "", secret: "", shout: false, label: "Nobody greeted yet", focus: 2, help: false, editor: "", ticks: 0 };
    const read = new Map<string, Element[]>();
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
                { role: "password text", name: "", value: state.secret === "" ? "" : "\u25cf".repeat(state.secret.length), password: true, editable: true, frame: [12, 54, 396, 34], actions: "activate" },
                { role: "check box", name: "Shout", frame: [12, 96, 396, 21], actions: "click" },
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
    };
    const running = () => Object.keys(windows).filter((name) => name !== "help-viewer" || state.help);

    const render = (app: string): string => {
        const elements = windows[app]!.elements();
        const focused = app === "demo_app.py" ? elements[state.focus] : undefined;

        read.set(app, elements);

        return [
            `App=${app} (pid 4242)`,
            `Window: "${windows[app]!.title}", App: ${app}.`,
            ...elements.map((each, index) => {
                const value = each.value === undefined || each.value === "" ? "" : ` Value: ${each.value}`;

                const title = [each.name, each.password ? "[password]" : ""].filter((part) => part !== "").join(" ");

                return `${"\t".repeat(index === 0 ? 1 : index === 1 ? 2 : 3)}${index} ${each.role} ${title}${value}${each.actions === undefined ? "" : ` Secondary Actions: ${each.actions}`} Frame: {x: ${each.frame[0]}, y: ${each.frame[1]}, width: ${each.frame[2]}, height: ${each.frame[3]}}`;
            }),
            ...(focused === undefined ? [] : ["", `The focused UI element is ${focused.role}${focused.password ? " [password]" : ""}.`]),
        ].join("\n");
    };
    const state_ = (app: string) => ({ content: [{ type: "text", text: render(app) }, { type: "image", data: picture, mimeType: "image/png" }], isError: false });
    const fail = (text: string) => ({ content: [{ type: "text", text }], isError: true });

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
            return fail(`unknown element_index '${index}'`);
        }

        const refused = "Refused: the target is a password field. Open Computer Use (pi-phone build) does not type into password fields.";

        switch (name) {
            case "click": {
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
                if (element?.password) {
                    return fail(refused);
                }

                if (app === "demo_app.py" && index === 2) {
                    state.name = String(args.value);
                } else if (app === "gedit") {
                    state.editor = String(args.value);
                }

                break;
            }

            case "type_text": {
                if (app === "demo_app.py") {
                    if (windows[app]!.elements()[state.focus]?.password) {
                        return fail(refused);
                    }

                    state.name += String(args.text);
                } else if (app === "gedit") {
                    state.editor += String(args.text);
                }

                break;
            }

            case "press_key": {
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
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26", serverInfo: { name: "open-computer-use", version: "1.1.2-pp.1" }, capabilities: { tools: {} } } })}\n`);
        } else if (request.method === "tools/call") {
            log({ tool: request.params!.name, args: request.params!.arguments ?? {} });
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: call(request.params!.name!, request.params!.arguments ?? {}) })}\n`);
        }
    });
    process.stdin.on("end", () => process.exit(0));
}
