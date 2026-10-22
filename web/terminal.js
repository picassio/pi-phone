// A terminal (src/server/terminal.ts): a shell on this phone or on a machine, in xterm.js, full screen. A row of keys a
// phone's keyboard lacks sits under it: Esc, Tab, Ctrl (held for the next key), the arrows, a few symbols, and Paste
// and Select, as a finger cannot select in xterm.js. The shell outlives the sheet and the app going to the background:
// closing the sheet leaves it running a while, and opening the terminal at the same place takes it up again, with
// what it wrote meanwhile. End stops it.
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "./i18n.js";
import { closeSheet, notify, store } from "./store.js";
import { copyText, html, Icon, shortPath } from "./ui.js";

/** The shell at each place, by its id, for this tab: kept over reloads, so a reload takes it up again. */
const SHELLS_KEY = "pi-phone.terminals";
const shells = () => JSON.parse(sessionStorage.getItem(SHELLS_KEY) ?? "{}");
const remember = (place, id) => sessionStorage.setItem(SHELLS_KEY, JSON.stringify({ ...shells(), [place]: id }));
const forget = (place) => {
    const { [place]: _gone, ...rest } = shells();

    sessionStorage.setItem(SHELLS_KEY, JSON.stringify(rest));
};

/** xterm.js's own stylesheet, added to the page once. */
function loadStyles() {
    if (document.querySelector("link[data-xterm]")) {
        return;
    }

    const link = document.createElement("link");

    link.rel = "stylesheet";
    link.href = "vendor/xterm.css";
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

/** What the terminal shows and keeps above, as text, for selecting with a finger. */
function screenText(terminal) {
    const buffer = terminal.buffer.active;
    const lines = [];

    for (let index = 0; index < buffer.length; index++) {
        lines.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }

    while (lines.length > 0 && lines.at(-1) === "") {
        lines.pop();
    }

    return lines.join("\n");
}

/** A shell at `place` (a folder here, or `machine:<id>:<path>`), full screen; `run`, a command a new one starts with. */
export function TerminalSheet({ place, run }) {
    const box = useRef(null);
    const socket = useRef(null);
    const term = useRef(null);
    const fitter = useRef(null);
    const ctrl = useRef(false);
    // "connecting", "open", "away" (the socket dropped; the shell runs on), "ended".
    const [state, setState] = useState("connecting");
    const [ctrlOn, setCtrlOn] = useState(false);
    const [selecting, setSelecting] = useState(null);
    const [pasting, setPasting] = useState(false);
    const home = store.state.server?.home;

    const send = (message) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify(message));
    const input = (data) => {
        if (ctrl.current) {
            ctrl.current = false;
            setCtrlOn(false);
            data = withCtrl(data);
        }

        send({ type: "input", data });
    };

    /** Open the socket: to this place's shell when there is one, else to a new one. */
    const connect = () => {
        const terminal = term.current;
        const id = shells()[place];
        const query = new URLSearchParams(
            id ? { id } : { place, cols: String(terminal.cols), rows: String(terminal.rows) },
        );
        const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/terminal?${query}`);
        let fresh = !id;

        ws.binaryType = "arraybuffer";
        socket.current = ws;
        setState("connecting");
        ws.onmessage = (event) => {
            if (typeof event.data !== "string") {
                terminal.write(new Uint8Array(event.data));

                return;
            }

            const message = JSON.parse(event.data);

            if (message.type === "ready") {
                remember(place, message.id);
                // Taken up again: what it kept comes next, from a clean screen, at this page's size.
                terminal.reset();
                setState("open");
                send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
                terminal.focus();

                if (fresh && run) {
                    send({ type: "input", data: `${run}\n` });
                }

                fresh = false;
            } else if (message.type === "gone") {
                // It ended, or waited too long, while nobody looked: a new one, saying so.
                forget(place);
                terminal.write(`\r\n\x1b[2m${t("[that shell is gone; a new one]")}\x1b[0m\r\n`);
                connect();
            } else if (message.type === "exit") {
                forget(place);
                terminal.write(`\r\n\x1b[2m${t("[exited with {code}]", { code: message.code })}\x1b[0m\r\n`);
                setState("ended");
            } else if (message.type === "error") {
                terminal.write(`\r\n\x1b[31m${message.message}\x1b[0m\r\n`);

                if (fresh) {
                    setState("ended");
                }
            }
        };
        ws.onclose = () => {
            if (socket.current === ws) {
                setState((now) => (now === "ended" ? now : "away"));
            }
        };
    };

    useEffect(() => {
        loadStyles();
        const terminal = new Terminal({ ...themed(), fontSize: 13, cursorBlink: true, scrollback: 5000 });
        const fit = new FitAddon();

        terminal.loadAddon(fit);
        terminal.open(box.current);
        fit.fit();
        term.current = terminal;
        fitter.current = fit;
        connect();

        const typed = terminal.onData((data) => input(data));
        // The size follows the sheet (a fold opening, the keyboard): the shell hears it as SIGWINCH.
        const observer = new ResizeObserver(() => {
            fit.fit();
            send({ type: "resize", cols: terminal.cols, rows: terminal.rows });
        });
        // Back from the background, the socket is often gone: take the shell up again.
        const back = () => {
            const ws = socket.current;

            if (document.visibilityState === "visible" && ws && ws.readyState > WebSocket.OPEN && shells()[place]) {
                connect();
            }
        };

        observer.observe(box.current);
        document.addEventListener("visibilitychange", back);

        return () => {
            document.removeEventListener("visibilitychange", back);
            observer.disconnect();
            typed.dispose();
            // The shell runs on: opening the terminal here again takes it up.
            const ws = socket.current;

            socket.current = null;
            ws?.close();
            terminal.dispose();
        };
    }, [place]);

    const end = () => {
        send({ type: "close" });
        forget(place);
        closeSheet();
    };
    const toggleCtrl = () => {
        ctrl.current = !ctrl.current;
        setCtrlOn(ctrl.current);
        term.current?.focus();
    };
    const select = () => {
        const selection = term.current?.getSelection();

        // A mouse's selection is copied at once; with a finger, the text opens to select in.
        if (selection) {
            copyText(selection).then(() => notify("info", t("Copied.")));
        } else {
            setSelecting(screenText(term.current));
        }
    };

    return html`<div class="terminal-sheet" role="dialog" aria-modal="true" aria-label=${t("Terminal")} data-part="terminal">
        <div class="terminal-bar">
            <${Icon} name="terminal" size=${16} />
            <span class="terminal-title mono">${shortPath(place, home)}</span>
            <span class=${`terminal-state ${state}`}>
                ${state === "connecting" ? t("connecting…") : state === "away" ? t("disconnected") : state === "ended" ? t("ended") : ""}
            </span>
            ${state === "away" && html`<button class="button small" onClick=${connect}>${t("Reconnect")}</button>`}
            ${state !== "ended" && html`<button class="button small ghost" title=${t("Stop the shell")} onClick=${end}>${t("End")}</button>`}
            <button class="icon-button" aria-label=${t("Close the terminal; the shell runs on")} title=${t("Close (the shell runs on)")} onClick=${closeSheet}>
                <${Icon} name="close" />
            </button>
        </div>
        <div class="terminal-screen" ref=${box}></div>
        ${
            selecting !== null &&
            html`<div class="terminal-overlay">
                <textarea class="terminal-text mono" readonly ref=${(el) => el && (el.scrollTop = el.scrollHeight)}>${selecting}</textarea>
                <div class="sheet-actions">
                    <button class="button small" onClick=${() => copyText(selecting).then(() => notify("info", t("Copied all.")))}>${t("Copy all")}</button>
                    <button class="button small primary" onClick=${() => setSelecting(null)}>${t("Done")}</button>
                </div>
            </div>`
        }
        ${
            pasting &&
            html`<form
                class="terminal-overlay"
                onSubmit=${(event) => {
                    event.preventDefault();
                    const text = event.currentTarget.elements.text.value;

                    if (text !== "") {
                        send({ type: "input", data: text });
                    }

                    setPasting(false);
                    term.current?.focus();
                }}
            >
                <textarea name="text" class="terminal-text mono" placeholder=${t("Paste here, then Send")} autofocus></textarea>
                <div class="sheet-actions">
                    <button type="button" class="button small" onClick=${() => setPasting(false)}>${t("Cancel")}</button>
                    <button class="button small primary">${t("Send")}</button>
                </div>
            </form>`
        }
        <div class="terminal-keys" role="toolbar" aria-label=${t("Keys")}>
            ${KEYS.map(
                ([label, data]) => html`<button
                    class=${`terminal-key ${data === null && ctrlOn ? "on" : ""}`}
                    aria-pressed=${data === null ? ctrlOn : undefined}
                    onPointerDown=${(event) => event.preventDefault()}
                    onClick=${() => {
                        if (data === null) {
                            toggleCtrl();
                        } else {
                            input(data);
                            term.current?.focus();
                        }
                    }}
                >
                    ${label}
                </button>`,
            )}
            <button class="terminal-key" onClick=${() => setPasting(true)}>${t("Paste")}</button>
            <button class="terminal-key" onPointerDown=${(event) => event.preventDefault()} onClick=${select}>${t("Select")}</button>
        </div>
    </div>`;
}
