// Pi's browser (src/server/browser/pi-browser.ts): the page Pi works in, live, with what Pi is doing, and Take over / Hand
// back. It docks beside the conversation where Files does (one panel at a time) and covers the screen on phones, where a
// small live preview sits above the message box while Pi browses. On wide screens it opens by itself when Pi starts
// browsing in the session shown, unless it was closed a moment ago. The owner's: the page may be signed in as them.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { api, attempt, closePeople, onBrowserFrame, panelsBeside, store } from "./store.js";
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
    const streamId = store.state.streamId;

    useEffect(() => {
        if (streamId === undefined) {
            return undefined;
        }

        const off = onBrowserFrame(onFrame);

        void api("browser/watch", { connection: streamId, on: true }).then(
            (state) => store.set({ piBrowser: state }),
            () => {},
        );

        return () => {
            off();
            void api("browser/watch", { connection: streamId, on: false }).catch(() => {});
        };
    }, [streamId]);
}

/** The live picture: an image updated in place (frames skip the store, which would redraw the whole app each time). */
function Frame({ interactive, onTap, onWheel }) {
    const image = useRef(null);
    const [has, setHas] = useState(false);
    const viewport = store.state.piBrowser?.viewport ?? { width: 412, height: 860 };

    useFrames((frame) => {
        if (image.current) {
            image.current.src = `data:image/jpeg;base64,${frame.jpeg}`;
        }

        setHas(true);
    });

    /** A pointer on the picture, in the page's CSS pixels. */
    const at = (event) => {
        const box = image.current.getBoundingClientRect();

        return {
            x: Math.round(((event.clientX - box.left) / box.width) * viewport.width),
            y: Math.round(((event.clientY - box.top) / box.height) * viewport.height),
        };
    };

    return html`<div class=${`pb-frame ${interactive ? "live" : ""}`} style=${`aspect-ratio:${viewport.width}/${viewport.height}`}>
        <img
            ref=${image}
            alt=${has ? "Pi's browser, live" : ""}
            draggable="false"
            onClick=${(event) => interactive && onTap?.(at(event))}
            onWheel=${(event) => {
                if (interactive) {
                    event.preventDefault();
                    onWheel?.({ ...at(event), dy: Math.round(event.deltaY) });
                }
            }}
        />
        ${!has && html`<span class="pb-wait">Waiting for the page…</span>`}
    </div>`;
}

const send = (body) => attempt(() => api("browser/input", body));

/** Typing, keys, and an address, while the person has the page. */
function TakeOverBar() {
    const [text, setText] = useState("");
    const [address, setAddress] = useState("");

    return html`<div class="pb-takeover">
        <form
            class="pb-row"
            onSubmit=${(event) => {
                event.preventDefault();

                if (address.trim() !== "") {
                    void attempt(async () => {
                        store.set({ piBrowser: await api("browser/open", { url: address }) });
                        setAddress("");
                    });
                }
            }}
        >
            <input value=${address} placeholder="Address or search" aria-label="Open an address" onInput=${(event) => setAddress(event.currentTarget.value)} />
            <button class="button small">Go</button>
        </form>
        <form
            class="pb-row"
            onSubmit=${(event) => {
                event.preventDefault();

                if (text !== "") {
                    void send({ type: "text", text }).then(() => setText(""));
                }
            }}
        >
            <input value=${text} placeholder="Type into the page" aria-label="Type into the page" onInput=${(event) => setText(event.currentTarget.value)} />
            <button class="button small">Type</button>
        </form>
        <div class="pb-keys">
            ${["Enter", "Backspace", "Tab", "Escape"].map((key) => html`<button class="pb-key" onClick=${() => send({ type: "key", key })}>${key === "Backspace" ? "⌫" : key}</button>`)}
        </div>
    </div>`;
}

export function BrowserPanel({ leaving = false }) {
    const state = store.state.piBrowser;
    const beside = panelsBeside();
    const takenOver = state?.takenOver === true;

    useBack(!beside && !leaving, () => setBrowserOpen(false));

    return html`<section
        class=${`files-tile window pb-panel ${leaving ? "leaving" : ""}`}
        data-part="browser-panel"
        data-state=${leaving ? "closing" : undefined}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label="Pi's browser"
        tabindex="-1"
        inert=${leaving}
    >
        <header class="files-bar pb-bar">
            ${
                !beside &&
                html`<button class="icon-button files-back" type="button" aria-label="Back to the conversation" onClick=${() => setBrowserOpen(false)}>
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="pb-title">
                <b>Pi's browser</b>
                <span class="pb-url" title=${state?.url ?? ""}>${state?.open ? state.title || state.url || "Blank page" : "Closed"}</span>
            </div>
            ${
                state?.open &&
                html`<button
                    class=${`button small ${takenOver ? "primary" : ""}`}
                    onClick=${() => attempt(async () => store.set({ piBrowser: await api("browser/take-over", { on: !takenOver }) }))}
                >
                    ${takenOver ? "Hand back" : "Take over"}
                </button>`
            }
            ${
                beside &&
                html`<button class="icon-button" type="button" aria-label="Close the panel" title="Close" onClick=${() => setBrowserOpen(false)}>
                    <${Icon} name="close" size=${17} />
                </button>`
            }
        </header>
        <div class=${`pb-status ${state?.doing ? "busy" : ""}`} aria-live="polite">
            ${state?.doing ? html`<span class="pb-spin" aria-hidden="true"></span>${state.doing}` : takenOver ? "You have the page: Pi waits until you hand it back." : state?.open ? "Pi is not browsing now." : ""}
        </div>
        <div class="pb-body">
            ${
                state?.open
                    ? html`<${Frame}
                          interactive=${takenOver}
                          onTap=${(point) => send({ type: "tap", ...point })}
                          onWheel=${(point) => send({ type: "scroll", ...point })}
                      />`
                    : html`<div class="pb-empty">
                          <${Icon} name="globe" size=${28} />
                          <p>Pi's browser opens when Pi browses: ask Pi to open a page, or to do something on a site.</p>
                      </div>`
            }
        </div>
        ${takenOver && html`<${TakeOverBar} />`}
        ${
            state?.open &&
            html`<footer class="pb-foot">
                <button class="link small" onClick=${() => attempt(async () => store.set({ piBrowser: await api("browser/close", {}) }))}>Close Pi's browser</button>
            </footer>`
        }
    </section>`;
}

/** The top bar's way to the panel, while Pi's browser is open. */
export function BrowserButton() {
    const state = store.state.piBrowser;

    if (!browserAvailable() || !state?.open) {
        return null;
    }

    const shown = browserShown();

    return html`<button
        class=${`icon-button ${shown ? "on" : ""} ${state.doing ? "pb-active" : ""}`}
        aria-label=${shown ? "Hide Pi's browser" : "Pi's browser"}
        title="Pi's browser"
        aria-pressed=${shown}
        onClick=${() => setBrowserOpen(!shown)}
    >
        <${Icon} name="globe" />
    </button>`;
}

/** On a phone, while Pi browses in this session: a small live preview above the message box; a tap opens the panel. */
export function BrowserPreview() {
    const { piBrowser: state, conversationId } = store.state;
    const image = useRef(null);

    if (!browserAvailable() || panelsBeside() || browserShown() || !state?.doing || state.session !== conversationId) {
        return null;
    }

    return html`<button class="pb-preview" onClick=${() => setBrowserOpen(true)} aria-label=${`Pi's browser: ${state.doing}. Open it.`}>
        <${PreviewImage} image=${image} />
        <span class="pb-preview-text"><b>Pi's browser</b><span>${state.doing}</span></span>
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
    const { piBrowser: state, conversationId, me } = store.state;
    const owner = me?.role === "owner";
    const doing = state?.doing ?? null;

    useEffect(() => {
        if (owner) {
            void api("browser").then(
                (answer) => store.set({ piBrowser: answer }),
                () => {},
            );
        }
    }, [owner]);

    useEffect(() => {
        if (owner && doing !== null && state?.session === conversationId && panelsBeside() && !browserShown() && Date.now() - closedAt > QUIET_MS) {
            setBrowserOpen(true);
        }
    }, [doing !== null, state?.session, conversationId]);

    return null;
}
