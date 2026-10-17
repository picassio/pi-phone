// A terminal (src/server/terminal.ts): a shell on this phone or on a machine, in xterm.js, full screen. A row of keys a
// phone's keyboard lacks sits under it: Esc, Tab, Ctrl (held for the next key), the arrows, and a few symbols.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "preact/hooks";
import { closeSheet, store } from "./store.js";
import { html, Icon, shortPath } from "./ui.js";

/** xterm.js's own stylesheet, added to the page once. */
function loadStyles() {
    if (document.querySelector("link[data-xterm]")) {
        return;
    }

    const link = document.createElement("link");

    link.rel = "stylesheet";
    link.href = "/vendor/xterm.css";
    link.dataset.xterm = "";
    document.head.append(link);
}

/** The terminal's look, from the app's theme (style.css and theme.js define these on the root). */
function themed() {
    const css = getComputedStyle(document.documentElement);
    const value = (name) => css.getPropertyValue(name).trim();

    return {
        fontFamily: value("--mono"),
        theme: {
            background: value("--code-bg"),
            foreground: value("--text"),
            cursor: value("--accent"),
            selectionBackground: value("--accent-soft"),
        },
    };
}

/** Keys under the terminal: what each sends. Ctrl is a toggle that changes the next key. */
const KEYS = [
    ["Esc", "\x1b"],
    ["Tab", "\t"],
    ["Ctrl", null],
    ["↑", "\x1b[A"],
    ["↓", "\x1b[B"],
    ["←", "\x1b[D"],
    ["→", "\x1b[C"],
    ["|", "|"],
    ["~", "~"],
    ["/", "/"],
    ["-", "-"],
];

/** A letter as Ctrl and that letter: Ctrl+C is 0x03. Anything else goes as it is. */
const withCtrl = (data) =>
    data.length === 1 && /[a-z@[\\\]^_]/i.test(data) ? String.fromCharCode(data.toUpperCase().charCodeAt(0) & 0x1f) : data;

/** A shell at `place` (a folder here, or `machine:<id>:<path>`), full screen; `run`, a command it starts with. */
export function TerminalSheet({ place, run }) {
    const box = useRef(null);
    const socket = useRef(null);
    const term = useRef(null);
    const ctrl = useRef(false);
    const [ctrlOn, setCtrlOn] = useState(false);
    const [state, setState] = useState("connecting");
    const home = store.state.server?.home;

    const send = (data) => {
        const ws = socket.current;

        if (ws?.readyState !== WebSocket.OPEN) {
            return;
        }

        if (ctrl.current) {
            ctrl.current = false;
            setCtrlOn(false);
            data = withCtrl(data);
        }

        ws.send(JSON.stringify({ type: "input", data }));
    };

    useEffect(() => {
        loadStyles();
        const terminal = new Terminal({ ...themed(), fontSize: 13, cursorBlink: true, scrollback: 5000 });
        const fit = new FitAddon();

        terminal.loadAddon(fit);
        terminal.open(box.current);
        fit.fit();
        term.current = terminal;

        const query = new URLSearchParams({ place, cols: String(terminal.cols), rows: String(terminal.rows) });
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?${query}`);

        ws.binaryType = "arraybuffer";
        socket.current = ws;
        ws.onopen = () => {
            setState("open");

            // A command to start with (Continue in Pi's "Open Pi in a terminal"), typed as if by hand.
            if (run) {
                ws.send(JSON.stringify({ type: "input", data: `${run}\n` }));
            }

            terminal.focus();
        };
        ws.onmessage = (event) => {
            if (typeof event.data !== "string") {
                terminal.write(new Uint8Array(event.data));

                return;
            }

            const message = JSON.parse(event.data);

            if (message.type === "exit") {
                terminal.write(`\r\n\x1b[2m[exited with ${message.code}]\x1b[0m\r\n`);
                setState("ended");
            } else if (message.type === "error") {
                terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);
                setState("ended");
            }
        };
        ws.onclose = () => setState((now) => (now === "ended" ? now : "closed"));

        const input = terminal.onData((data) => send(data));
        // The size follows the sheet (a fold opening, the keyboard): the shell hears it as SIGWINCH.
        const observer = new ResizeObserver(() => {
            fit.fit();

            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }));
            }
        });

        observer.observe(box.current);

        return () => {
            observer.disconnect();
            input.dispose();
            ws.close();
            terminal.dispose();
        };
    }, [place]);

    const toggleCtrl = () => {
        ctrl.current = !ctrl.current;
        setCtrlOn(ctrl.current);
        term.current?.focus();
    };

    return html`<div class="terminal-sheet" role="dialog" aria-modal="true" aria-label="Terminal" data-part="terminal">
        <div class="terminal-bar">
            <${Icon} name="terminal" size=${16} />
            <span class="terminal-title mono">${shortPath(place, home)}</span>
            <span class=${`terminal-state ${state}`}>
                ${state === "connecting" ? "connecting…" : state === "open" ? "" : state === "ended" ? "ended" : "disconnected"}
            </span>
            <button class="icon-button" aria-label="Close the terminal" title="Close" onClick=${closeSheet}>
                <${Icon} name="close" />
            </button>
        </div>
        <div class="terminal-screen" ref=${box}></div>
        <div class="terminal-keys" role="toolbar" aria-label="Keys">
            ${KEYS.map(
                ([label, data]) => html`<button
                    class=${`terminal-key ${data === null && ctrlOn ? "on" : ""}`}
                    aria-pressed=${data === null ? ctrlOn : undefined}
                    onPointerDown=${(event) => event.preventDefault()}
                    onClick=${() => {
                        if (data === null) {
                            toggleCtrl();
                        } else {
                            send(data);
                            term.current?.focus();
                        }
                    }}
                >
                    ${label}
                </button>`,
            )}
        </div>
    </div>`;
}
