// Pi's computer (src/server/computer-control.ts, PP-178): a session's control of a machine's desktop apps, live, built as
// Pi's browser panel is (browser-panel.js): it docks beside the conversation where Files does (one panel at a time) and
// covers the screen on phones, where a small live preview sits above the message box while Pi acts. The windows of the
// session's apps are its tabs; the picture is ocu's screenshot of one, after each action and every few seconds while the
// panel shows, with a box on the element Pi acted on. Take over: Pi waits, and the person's taps are ocu's clicks there,
// their keys go to the field in focus (never a password field). The owner's.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { fromServer } from "./seen.js";
import { api, attempt, closePeople, computerApi, computerState, onComputerFrame, panelsBeside, setComputer, store } from "./store.js";
import { html, Icon } from "./ui.js";

const OPEN_KEY = "pocket.piComputer";
/** After the panel was closed, Pi's actions do not open it again for this long. */
const QUIET_MS = 60_000;
let closedAt = 0;

export const computerAvailable = () => store.state.me?.role === "owner";

/** Show or hide the panel. It takes the Files tile's, the browser's and the People panel's place. */
export function setComputerOpen(open) {
    if (open) {
        sessionStorage.setItem(OPEN_KEY, "1");
        sessionStorage.removeItem("pocket.files");
        sessionStorage.removeItem("pocket.piBrowser");
        closePeople();
        store.set({ computerOpen: true, browserOpen: false, filesOpen: false, drawer: false });
    } else {
        closedAt = Date.now();
        sessionStorage.removeItem(OPEN_KEY);

        if (document.documentElement.dataset.focus === "computer-panel") {
            document.documentElement.dataset.focus = "pane";
        }

        store.set({ computerOpen: false });
    }
}

/** The panel shows now: asked for, in a conversation whose session controls (or controlled) a computer, for the owner. */
export function computerShown(state = store.state) {
    return state.computerOpen && state.conversationId !== null && state.me?.role === "owner" && computerState(state) !== null;
}

/** The last picture of each session's computer, by session and app: shown at once when the panel opens again. */
const lastFrames = new Map();

/** Pictures while the component shows: the server reads the window again every few seconds while a tab watches. */
function useFrames(panel, onFrame) {
    const { streamId } = store.state;
    const session = panel?.session;

    useEffect(() => {
        if (streamId === undefined || typeof session !== "number") {
            return undefined;
        }

        const off = onComputerFrame((frame) => {
            if (frame.session === session) {
                lastFrames.set(`${session}#${frame.app}`, frame);
                onFrame(frame);
            }
        });
        const watch = (on) => api(`computer/watch?session=${session}`, { connection: streamId, on });

        void watch(true).then(setComputer, () => {});

        return () => {
            off();
            void watch(false).catch(() => {});
        };
    }, [streamId, session]);
}

/** What the person sends the window while they have it, in order (a fast typist's keys must not overtake each other). */
let sending = Promise.resolve();

const send = (body) => {
    const next = sending.then(() => computerApi("computer/input", body));

    sending = next.catch(() => {});

    return attempt(() => next);
};

/**
 * The keyboard while the person has the window: a hidden field the phone's keyboard (or a computer's) types into; each
 * keystroke goes to the field in focus there, and the field here is emptied, so nothing typed stays here. Over a password
 * field there, nothing is sent: ocu refuses it, and the person types it on the computer itself.
 */
function Capture({ field }) {
    const sent = useRef("");
    const composing = useRef(false);
    const clear = (input) => {
        input.value = "";
        sent.current = "";
    };
    const flush = (input) => {
        const now = input.value;
        const before = sent.current;
        let same = 0;

        while (same < now.length && same < before.length && now[same] === before[same]) {
            same += 1;
        }

        for (let gone = before.length - same; gone > 0; gone -= 1) {
            void send({ type: "key", key: "Backspace" });
        }

        if (now.length > same) {
            void send({ type: "text", text: now.slice(same) });
        }

        sent.current = now;

        if (!composing.current) {
            clear(input);
        }
    };

    return html`<input
        ref=${field}
        class="pb-capture"
        type="text"
        aria-label=${t("Type into the window")}
        autocomplete="off"
        autocorrect="off"
        autocapitalize="off"
        spellcheck="false"
        enterkeyhint="go"
        data-lpignore="true"
        data-1p-ignore="true"
        onInput=${(event) => flush(event.currentTarget)}
        onCompositionStart=${() => (composing.current = true)}
        onCompositionEnd=${(event) => {
            composing.current = false;
            flush(event.currentTarget);
        }}
        onKeyDown=${(event) => {
            const keys = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];

            if (keys.includes(event.key) || (event.key === "Backspace" && event.currentTarget.value === "")) {
                event.preventDefault();
                void send({ type: "key", key: event.key });
            }
        }}
        onBlur=${(event) => clear(event.currentTarget)}
    />`;
}

/** The picture of the window shown, with the box on what Pi last acted on; while the person has it, a tap is a click. */
function Frame({ panel, interactive }) {
    const key = `${panel.session}#${panel.tab}`;
    const [frame, setFrame] = useState(lastFrames.get(key) ?? null);
    const image = useRef(null);
    const field = useRef(null);

    useEffect(() => setFrame(lastFrames.get(key) ?? null), [key]);
    useFrames(panel, (next) => {
        if (next.app === panel.tab) {
            setFrame(next);
        }
    });

    const tap = (event) => {
        if (!interactive || frame === null) {
            return;
        }

        field.current?.focus({ preventScroll: true });
        const box = image.current.getBoundingClientRect();

        void send({ type: "tap", x: Math.round(((event.clientX - box.left) / box.width) * frame.width), y: Math.round(((event.clientY - box.top) / box.height) * frame.height) }).then((focus) => {
            if (focus?.password) {
                field.current?.blur();
            }
        });
    };
    /**
     * A press on the picture leaves the focus where it is, as the take-over keys do: the press's default would focus the
     * panel before the tap's click gives it back to the field, and on a phone the keyboard goes when the focus leaves a
     * text field, even for that moment. The click still comes.
     */
    const keep = (event) => interactive && event.preventDefault();
    const ratio = frame === null ? 1.6 : frame.width / frame.height;

    return html`<div
        class=${`pb-frame ${interactive ? "live" : ""}`}
        style=${`aspect-ratio:${frame === null ? "16/10" : `${frame.width}/${frame.height}`};--ratio:${ratio};--frame-max:100cqw`}
    >
        ${frame !== null && html`<img ref=${image} src=${`data:image/png;base64,${frame.png}`} alt=${t("{app} on {machine}", { app: panel.apps.find((each) => each.name === panel.tab)?.label ?? panel.tab, machine: panel.machineName })} draggable="false" data-no-swipe=${interactive ? "" : undefined} onPointerDown=${keep} onClick=${tap} />`}
        ${
            frame?.hit &&
            !interactive &&
            html`<span
                class="cu-hit"
                style=${`left:${frame.hit.x * 100}%;top:${frame.hit.y * 100}%;width:${frame.hit.width * 100}%;height:${frame.hit.height * 100}%`}
                ><span class="cu-hit-tag">${frame.hit.label}</span></span
            >`
        }
        ${frame === null && html`<span class="pb-wait">${t("Waiting for the window…")}</span>`}
        ${interactive && html`<${Capture} field=${field} />`}
    </div>`;
}

/** Keys a phone's keyboard lacks, while the person has the window. Typing goes straight to the field in focus there. */
function TakeOverBar() {
    // The keys keep the keyboard up: pressing one does not take the focus from the hidden field.
    const keep = (event) => event.preventDefault();

    return html`<div class="pb-takeover">
        <p class="pb-hint">${t("Tap the window to click there. Your keys go to the field in focus, never into a password field: type those on the computer itself.")}</p>
        <div class="pb-keys">
            ${["Enter", "Backspace", "Tab", "Escape"].map((key) => html`<button class="pb-key" onPointerDown=${keep} onClick=${() => send({ type: "key", key })}>${key === "Backspace" ? "⌫" : key}</button>`)}
        </div>
    </div>`;
}

/** The session's windows, as tabs: the one shown marked; tapping one shows it (Pi works where it works). */
function Tabs({ panel }) {
    return html`<div class="pb-tabs" role="tablist" aria-label=${t("The session's windows")}>
        ${panel.apps.map(
            (app) => html`<button
                class=${`pb-tab ${app.name === panel.tab ? "on" : ""}`}
                role="tab"
                aria-selected=${app.name === panel.tab}
                title=${app.name}
                onClick=${() => app.name !== panel.tab && attempt(async () => setComputer(await computerApi("computer/tab", { app: app.name })))}
            >
                ${app.label}
            </button>`,
        )}
    </div>`;
}

/** Minutes left, from the server's clock. */
const minutesLeft = (until) => Math.max(0, Math.ceil((fromServer(until) - Date.now()) / 60_000));

export function ComputerPanel({ leaving = false }) {
    const panel = computerState();
    const beside = panelsBeside();
    const [, tick] = useState(0);
    const takenOver = panel?.takenOver === true;
    const open = panel?.open === true;

    useBack(!beside && !leaving, () => setComputerOpen(false));
    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 15_000);

        return () => clearInterval(timer);
    }, []);

    if (panel === null) {
        return null;
    }

    const tab = panel.apps.find((each) => each.name === panel.tab);

    return html`<section
        class=${`files-tile window pb-panel ${leaving ? "leaving" : ""}`}
        data-part="computer-panel"
        data-state=${leaving ? "closing" : undefined}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label=${t("Pi's computer")}
        tabindex="-1"
        inert=${leaving}
    >
        <header class="files-bar pb-bar">
            ${
                !beside &&
                html`<button class="icon-button files-back" type="button" aria-label=${t("Back to the conversation")} onClick=${() => setComputerOpen(false)}>
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="pb-title">
                <b>${t("Pi's computer")}</b>
                <span class="pb-url" title=${panel.machineName}>${open ? [panel.machineName, tab?.label].filter(Boolean).join(" · ") : t("{machine}: ended", { machine: panel.machineName })}</span>
            </div>
            ${
                open &&
                html`<button
                    class=${`button small ${takenOver ? "primary" : ""}`}
                    onClick=${() => attempt(async () => setComputer(await computerApi("computer/take-over", { on: !takenOver })))}
                >
                    ${takenOver ? t("Hand back") : t("Take over")}
                </button>`
            }
            ${
                beside &&
                html`<button class="icon-button" type="button" aria-label=${t("Close the panel")} title=${t("Close")} onClick=${() => setComputerOpen(false)}>
                    <${Icon} name="close" size=${17} />
                </button>`
            }
        </header>
        ${open && panel.apps.length > 1 && html`<${Tabs} panel=${panel} />`}
        <div class=${`pb-status ${panel.doing ? "busy" : ""}`} aria-live="polite">
            ${
                panel.doing
                    ? html`<span class="pb-spin" aria-hidden="true"></span>${panel.doing}`
                    : takenOver
                      ? t("You have the window: Pi waits until you hand it back.")
                      : open
                        ? t("Pi is not using the computer now.")
                        : t("Computer control ended.")
            }
        </div>
        <div class="pb-body">
            ${
                open
                    ? html`<${Frame} panel=${panel} interactive=${takenOver} />`
                    : html`<div class="pb-empty">
                          <${Icon} name="monitor" size=${28} />
                          <p>${t("Pi's computer shows here while Pi controls one of your machines, after you approve its card.")}</p>
                      </div>`
            }
        </div>
        ${open && takenOver && html`<${TakeOverBar} />`}
        ${
            open &&
            html`<footer class="pb-foot">
                <span class="muted small">${[panel.conversationId === store.state.conversationId ? t("This session") : t("Session #{n}", { n: panel.session }), t("{n} min left", { n: minutesLeft(panel.until) })].join(" · ")}</span>
                <button class="button small" onClick=${() => attempt(async () => api(`computer/stop?session=${panel.session}`, {}))}>${t("Stop")}</button>
            </footer>`
        }
    </section>`;
}

/** The top bar's way to the panel, while the session shown controls a computer. */
export function ComputerButton() {
    const panel = computerState();

    if (!computerAvailable() || panel?.open !== true) {
        return null;
    }

    const shown = computerShown();

    return html`<button
        class=${`icon-button ${shown ? "on" : ""} ${panel.doing ? "pb-active" : ""}`}
        aria-label=${shown ? t("Hide Pi's computer") : t("Pi's computer")}
        title=${t("Pi's computer")}
        aria-pressed=${shown}
        onClick=${() => setComputerOpen(!shown)}
    >
        <${Icon} name="monitor" />
    </button>`;
}

/** On a phone, while Pi acts on a computer in this session: a small live preview above the message box; a tap opens the panel. */
export function ComputerPreview() {
    const panel = computerState();
    const [frame, setFrame] = useState(null);

    if (!computerAvailable() || panelsBeside() || computerShown() || !panel?.open || !panel.doing) {
        return null;
    }

    return html`<button class="pb-preview" onClick=${() => setComputerOpen(true)} aria-label=${t("Pi's computer: {doing}. Open it.", { doing: panel.doing })}>
        <${PreviewImage} panel=${panel} frame=${frame} onFrame=${setFrame} />
        <span class="pb-preview-text"><b>${t("Pi's computer")} · ${panel.machineName}</b><span>${panel.doing}</span></span>
        <${Icon} name="chevron" size=${14} />
    </button>`;
}

function PreviewImage({ panel, frame, onFrame }) {
    useFrames(panel, (next) => next.app === panel.tab && onFrame(next));
    const shown = frame ?? lastFrames.get(`${panel.session}#${panel.tab}`) ?? null;

    return html`<img alt="" class="pb-thumb cu-thumb" src=${shown === null ? undefined : `data:image/png;base64,${shown.png}`} />`;
}

/**
 * Keeps the owner's tab up to date with the session shown's computer, and opens the panel on wide screens when Pi starts
 * acting there (not within a minute of it being closed).
 */
export function ComputerWatcher() {
    const { conversationId, me } = store.state;
    const panel = computerState();
    const owner = me?.role === "owner";
    const doing = panel?.doing ?? null;

    useEffect(() => {
        if (owner && typeof conversationId === "number") {
            void api(`computer?session=${conversationId}`).then(setComputer, () => {});
        }
    }, [owner, conversationId]);

    useEffect(() => {
        if (owner && doing !== null && panel?.open && panelsBeside() && !computerShown() && Date.now() - closedAt > QUIET_MS) {
            setComputerOpen(true);
        }
    }, [doing !== null, panel?.session, conversationId]);

    return null;
}
