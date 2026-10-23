// Pi's browser (src/server/browser/pi-browser.ts): the page Pi works in, live, with what Pi is doing, and Take over / Hand
// back. It docks beside the conversation where Files does (one panel at a time) and covers the screen on phones, where a
// small live preview sits above the message box while Pi browses. On wide screens it opens by itself when Pi starts
// browsing in the session shown, unless it was closed a moment ago. The owner's: the page may be signed in as them.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { api, attempt, browserApi, browserPath, browserPlace, closePeople, onBrowserFrame, panelsBeside, piBrowserState, setPiBrowser, store } from "./store.js";
import { html, Icon } from "./ui.js";

const OPEN_KEY = "pocket.piBrowser";
/** After the panel was closed, Pi's browsing does not open it again for this long. */
const QUIET_MS = 60_000;
let closedAt = 0;

export const browserAvailable = () => store.state.me?.role === "owner";

/** Show or hide the panel. It takes the Files tile's and the People panel's place. */
export function setBrowserOpen(open) {
    if (open) {
        sessionStorage.setItem(OPEN_KEY, "1");
        sessionStorage.removeItem("pocket.files");
        closePeople();
        store.set({ browserOpen: true, filesOpen: false, drawer: false });
    } else {
        closedAt = Date.now();
        sessionStorage.removeItem(OPEN_KEY);

        if (document.documentElement.dataset.focus === "browser-panel") {
            document.documentElement.dataset.focus = "pane";
        }

        store.set({ browserOpen: false });
    }
}

/** The panel shows now: asked for, in a conversation, for the owner. */
export function browserShown(state = store.state) {
    return state.browserOpen && state.conversationId !== null && state.me?.role === "owner";
}

/** Frames of Pi's page while the component shows: the server sends them to this tab only while it watches. */
function useFrames(onFrame) {
    const { streamId, conversationId: session } = store.state;
    const place = browserPlace();

    useEffect(() => {
        if (streamId === undefined || typeof session !== "number") {
            return undefined;
        }

        const off = onBrowserFrame((frame) => (frame.place ?? "phone") === place && frame.session === session && onFrame(frame));
        const path = browserPath("browser/watch");
        const watch = (on) => api(path, { connection: streamId, on });

        void watch(true).then(setPiBrowser, () => {});

        return () => {
            off();
            void watch(false).catch(() => {});
        };
    }, [streamId, place, session]);
}

/**
 * What the person sends the page while they have it, in order (a fast typist's keys must not overtake each other).
 * Answers where the focus is then: whether it takes text, and whether it is a password.
 */
let sending = Promise.resolve();

const send = (body) => {
    const next = sending.then(() => browserApi("browser/input", body));

    sending = next.catch(() => {});

    return attempt(() => next);
};

/**
 * The keyboard, while the person has the page (PP-14): a hidden field that the phone's keyboard (or a computer's) types
 * into. Each keystroke goes to the page as it is typed, and the field is emptied, so nothing typed stays on screen, in
 * the panel, or in the keyboard's memory: autocomplete, autocorrect and spellcheck are off, and over a password field
 * it is a password field itself, which keyboards do not learn from. Words a keyboard composes go as they change.
 */
function Capture({ field, password }) {
    const sent = useRef("");
    const composing = useRef(false);
    const clear = (input) => {
        input.value = "";
        sent.current = "";
    };
    /** Send what changed since the last keystroke: backspaces for what went, then what came. */
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
        type=${password ? "password" : "text"}
        aria-label=${t("Type into the page")}
        autocomplete=${password ? "new-password" : "off"}
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

/**
 * The last picture of each session's browser (`place#session`): the panel opened again shows it at once, until the next
 * frame comes. In this tab's memory only.
 */
const lastFrames = new Map();

/** The live picture: an image updated in place (frames skip the store, which would redraw the whole app each time). */
function Frame({ interactive, onWheel }) {
    const image = useRef(null);
    const field = useRef(null);
    const key = `${browserPlace()}#${store.state.conversationId}`;
    const [has, setHas] = useState(lastFrames.has(key));
    const [password, setPassword] = useState(false);
    const state = piBrowserState();
    const viewport = state?.viewport ?? { width: 412, height: 860 };
    /** A tap on the picture: the keyboard comes up at once (it must, within the tap), and goes if the page took no text. */
    const tap = (event) => {
        field.current?.focus({ preventScroll: true });
        void send({ type: "tap", ...at(event) }).then((focus) => {
            if (focus?.editable) {
                setPassword(focus.password === true);
            } else {
                field.current?.blur();
            }
        });
    };

    useFrames((frame) => {
        const src = `data:image/jpeg;base64,${frame.jpeg}`;

        lastFrames.set(key, src);

        if (image.current) {
            image.current.src = src;
        }

        setHas(true);
    });

    /**
     * A pointer on the picture, in the page's CSS pixels: against the frame, which has the page's shape. (On the phone a
     * desktop-sized page is drawn shrunk at the top of a phone-shaped view: the picture runs below, cut off.)
     */
    const at = (event) => {
        const box = image.current.parentElement.getBoundingClientRect();

        return {
            x: Math.round(((event.clientX - box.left) / box.width) * viewport.width),
            y: Math.round(((event.clientY - box.top) / box.height) * viewport.height),
        };
    };

    /**
     * A finger dragged on the picture (PP-124): scrolls the page as a wheel at the point where it went down, so what is
     * under the finger scrolls (an open panel's own list before the page), as in a browser. The page's pixels a finger
     * moved, one request at a time, the movement meanwhile added up. A drag is no tap: the click after it is dropped.
     */
    const drag = useRef(null);
    const scroll = () => {
        const now = drag.current;

        if (now === null || now.sending || (Math.round(now.dx) === 0 && Math.round(now.dy) === 0)) {
            return;
        }

        const [dx, dy] = [Math.round(now.dx), Math.round(now.dy)];

        now.dx -= dx;
        now.dy -= dy;
        now.sending = true;
        void send({ type: "scroll", ...now.at, dx, dy }).finally(() => {
            now.sending = false;
            scroll();
        });
    };
    const down = (event) => {
        if (!interactive || event.pointerType === "mouse") {
            return;
        }

        drag.current = { x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY, at: at(event), moved: false, dx: 0, dy: 0, sending: false, dropClick: false };
    };
    const move = (event) => {
        const now = drag.current;

        if (now === null) {
            return;
        }

        if (!now.moved && Math.hypot(event.clientX - now.x, event.clientY - now.y) > 8) {
            now.moved = true;
        }

        if (now.moved) {
            const box = image.current.parentElement.getBoundingClientRect();
            const scale = viewport.width / box.width;

            // Dragging up shows what is below: the page scrolls down, as a finger does.
            now.dx += (now.lastX - event.clientX) * scale;
            now.dy += (now.lastY - event.clientY) * scale;
            scroll();
        }

        now.lastX = event.clientX;
        now.lastY = event.clientY;
    };
    const up = () => {
        if (drag.current?.moved) {
            drag.current.dropClick = true;
            // Kept until the click that follows (if any) has come and gone.
            const was = drag.current;

            setTimeout(() => drag.current === was && (drag.current = null), 400);
        } else {
            drag.current = null;
        }
    };

    return html`<div
        class=${`pb-frame ${interactive ? "live" : ""}`}
        style=${`aspect-ratio:${viewport.width}/${viewport.height};--ratio:${viewport.width / viewport.height};--frame-max:${state?.size === "desktop" ? "100cqw" : "460px"}`}
    >
        <img
            ref=${image}
            src=${lastFrames.get(key)}
            alt=${has ? t("Pi's browser, live") : ""}
            draggable="false"
            data-no-swipe=${interactive ? "" : undefined}
            onPointerDown=${down}
            onPointerMove=${move}
            onPointerUp=${up}
            onPointerCancel=${up}
            onClick=${(event) => {
                if (drag.current?.dropClick) {
                    drag.current = null;

                    return;
                }

                if (interactive) {
                    tap(event);
                }
            }}
            onWheel=${(event) => {
                if (interactive) {
                    event.preventDefault();
                    onWheel?.({ ...at(event), dy: Math.round(event.deltaY) });
                }
            }}
        />
        ${!has && html`<span class="pb-wait">${t("Waiting for the page…")}</span>`}
        ${interactive && html`<${Capture} field=${field} password=${password} />`}
    </div>`;
}

/** Phone or Desktop: the size this session's pages are laid out at (PP-15). */
function SizeSwitch({ state }) {
    return html`<div class="segmented pb-size" role="group" aria-label=${t("Page size")}>
        ${[
            ["phone", t("Phone")],
            ["desktop", t("Desktop")],
        ].map(
            ([size, label]) => html`<button
                class=${state.size === size ? "on" : ""}
                aria-pressed=${state.size === size}
                onClick=${() => state.size !== size && attempt(async () => setPiBrowser(await browserApi("browser/size", { size })))}
            >
                ${label}
            </button>`,
        )}
    </div>`;
}

/** Keys a phone's keyboard lacks, and an address, while the person has the page. Typing goes straight to the page. */
function TakeOverBar() {
    const [address, setAddress] = useState("");
    // The keys keep the keyboard up: pressing one does not take the focus from the page's field.
    const keep = (event) => event.preventDefault();

    return html`<div class="pb-takeover">
        <form
            class="pb-row"
            onSubmit=${(event) => {
                event.preventDefault();

                if (address.trim() !== "") {
                    void attempt(async () => {
                        setPiBrowser(await browserApi("browser/open", { url: address }));
                        setAddress("");
                    });
                }
            }}
        >
            <input value=${address} placeholder=${t("Address or search")} aria-label=${t("Open an address")} onInput=${(event) => setAddress(event.currentTarget.value)} />
            <button class="button small">${t("Go")}</button>
        </form>
        <p class="pb-hint">${t("Tap the page to type into it: your keys go straight there, and nothing you type stays here.")}</p>
        <div class="pb-keys">
            ${["Enter", "Backspace", "Tab", "Escape"].map((key) => html`<button class="pb-key" onPointerDown=${keep} onClick=${() => send({ type: "key", key })}>${key === "Backspace" ? "⌫" : key}</button>`)}
        </div>
    </div>`;
}

/** A tab's name in the strip: its title, or where it is. */
const tabName = (tab) => {
    if (tab.title) {
        return tab.title;
    }

    try {
        return new URL(tab.url).host || t("Blank page");
    } catch {
        return t("Blank page");
    }
};

/** Pi's tabs, when it has more than one: the one in front marked; tapping one brings it to the front. */
function Tabs({ state }) {
    return html`<div class="pb-tabs" role="tablist" aria-label=${t("Pi's tabs")}>
        ${state.tabs.map(
            (tab, index) => html`<button
                class=${`pb-tab ${index === state.tab ? "on" : ""}`}
                role="tab"
                aria-selected=${index === state.tab}
                title=${tab.url}
                onClick=${() => index !== state.tab && attempt(async () => setPiBrowser(await browserApi("browser/tab", { number: index + 1 })))}
            >
                ${tabName(tab)}
            </button>`,
        )}
    </div>`;
}

export function BrowserPanel({ leaving = false }) {
    const state = piBrowserState();
    const beside = panelsBeside();
    const takenOver = state?.takenOver === true;

    useBack(!beside && !leaving, () => setBrowserOpen(false));

    return html`<section
        class=${`files-tile window pb-panel ${leaving ? "leaving" : ""}`}
        data-part="browser-panel"
        data-state=${leaving ? "closing" : undefined}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label=${t("Pi's browser")}
        tabindex="-1"
        inert=${leaving}
    >
        <header class="files-bar pb-bar">
            ${
                !beside &&
                html`<button class="icon-button files-back" type="button" aria-label=${t("Back to the conversation")} onClick=${() => setBrowserOpen(false)}>
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="pb-title">
                <b>${state?.place && state.place !== "phone" ? t("Pi's browser on {where}", { where: state.where }) : t("Pi's browser")}</b>
                <span class="pb-url" title=${state?.url ?? ""}>${state?.open ? state.title || state.url || t("Blank page") : t("Closed")}</span>
            </div>
            ${
                state?.open &&
                html`<button
                    class=${`button small ${takenOver ? "primary" : ""}`}
                    onClick=${() => attempt(async () => setPiBrowser(await browserApi("browser/take-over", { on: !takenOver })))}
                >
                    ${takenOver ? t("Hand back") : t("Take over")}
                </button>`
            }
            ${
                beside &&
                html`<button class="icon-button" type="button" aria-label=${t("Close the panel")} title=${t("Close")} onClick=${() => setBrowserOpen(false)}>
                    <${Icon} name="close" size=${17} />
                </button>`
            }
        </header>
        ${state?.open && (state.tabs?.length ?? 0) > 1 && html`<${Tabs} state=${state} />`}
        <div class=${`pb-status ${state?.doing ? "busy" : ""}`} aria-live="polite">
            ${state?.doing ? html`<span class="pb-spin" aria-hidden="true"></span>${state.doing}` : takenOver ? t("You have the page: Pi waits until you hand it back.") : state?.open ? t("Pi is not browsing now.") : ""}
        </div>
        <div class="pb-body">
            ${
                state?.open
                    ? html`<${Frame} interactive=${takenOver} onWheel=${(point) => send({ type: "scroll", ...point })} />`
                    : html`<div class="pb-empty">
                          <${Icon} name="globe" size=${28} />
                          <p>${t("Pi's browser opens when Pi browses: ask Pi to open a page, or to do something on a site.")}</p>
                      </div>`
            }
        </div>
        ${takenOver && html`<${TakeOverBar} />`}
        ${
            state?.open &&
            html`<footer class="pb-foot">
                <${SizeSwitch} state=${state} />
                <button class="link small" onClick=${() => attempt(async () => setPiBrowser(await browserApi("browser/close", {})))}>${t("Close this session's tabs")}</button>
            </footer>`
        }
    </section>`;
}

/** The top bar's way to the panel, while Pi's browser is open. */
export function BrowserButton() {
    const state = piBrowserState();

    if (!browserAvailable() || !state?.open) {
        return null;
    }

    const shown = browserShown();

    return html`<button
        class=${`icon-button ${shown ? "on" : ""} ${state.doing ? "pb-active" : ""}`}
        aria-label=${shown ? t("Hide Pi's browser") : t("Pi's browser")}
        title=${t("Pi's browser")}
        aria-pressed=${shown}
        onClick=${() => setBrowserOpen(!shown)}
    >
        <${Icon} name="globe" />
    </button>`;
}

/** On a phone, while Pi browses in this session: a small live preview above the message box; a tap opens the panel. */
export function BrowserPreview() {
    const { conversationId } = store.state;
    const state = piBrowserState();
    const image = useRef(null);

    if (!browserAvailable() || panelsBeside() || browserShown() || !state?.doing || state.session !== conversationId) {
        return null;
    }

    return html`<button class="pb-preview" onClick=${() => setBrowserOpen(true)} aria-label=${t("Pi's browser: {doing}. Open it.", { doing: state.doing })}>
        <${PreviewImage} image=${image} />
        <span class="pb-preview-text"><b>${t("Pi's browser")}</b><span>${state.doing}</span></span>
        <${Icon} name="chevron" size=${14} />
    </button>`;
}

function PreviewImage({ image }) {
    useFrames((frame) => {
        if (image.current) {
            image.current.src = `data:image/jpeg;base64,${frame.jpeg}`;
        }
    });

    return html`<img ref=${image} alt="" class="pb-thumb" />`;
}

/**
 * Keeps the owner's tab up to date with Pi's browser, and opens the panel on wide screens when Pi starts browsing in the
 * session shown (not within a minute of it being closed).
 */
export function BrowserWatcher() {
    const { conversationId, me } = store.state;
    const state = piBrowserState();
    const place = browserPlace();
    const owner = me?.role === "owner";
    const doing = state?.doing ?? null;

    useEffect(() => {
        if (owner && typeof conversationId === "number") {
            void browserApi("browser").then(setPiBrowser, () => {});
        }
    }, [owner, place, conversationId]);

    useEffect(() => {
        if (owner && doing !== null && state?.session === conversationId && panelsBeside() && !browserShown() && Date.now() - closedAt > QUIET_MS) {
            setBrowserOpen(true);
        }
    }, [doing !== null, state?.session, conversationId]);

    return null;
}
