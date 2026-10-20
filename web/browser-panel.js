// Pi's browser (src/server/browser/pi-browser.ts): the page Pi works in, live, with what Pi is doing, and Take over / Hand
// back. It docks beside the conversation where Files does (one panel at a time) and covers the screen on phones, where a
// small live preview sits above the message box while Pi browses. On wide screens it opens by itself when Pi starts
// browsing in the session shown, unless it was closed a moment ago. The owner's: the page may be signed in as them.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { api, attempt, browserApi, browserPlace, closePeople, onBrowserFrame, panelsBeside, piBrowserState, setPiBrowser, store } from "./store.js";
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
    const place = browserPlace();

    useEffect(() => {
        if (streamId === undefined) {
            return undefined;
        }

        const off = onBrowserFrame((frame) => (frame.place ?? "phone") === place && onFrame(frame));
        const watch = (on) => api(`browser/watch?place=${encodeURIComponent(place)}`, { connection: streamId, on });

        void watch(true).then(setPiBrowser, () => {});

        return () => {
            off();
            void watch(false).catch(() => {});
        };
    }, [streamId, place]);
}

/** The live picture: an image updated in place (frames skip the store, which would redraw the whole app each time). */
function Frame({ interactive, onTap, onWheel }) {
    const image = useRef(null);
    const [has, setHas] = useState(false);
    const viewport = piBrowserState()?.viewport ?? { width: 412, height: 860 };

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

    return html`<div class=${`pb-frame ${interactive ? "live" : ""}`} style=${`aspect-ratio:${viewport.width}/${viewport.height};--ratio:${viewport.width / viewport.height}`}>
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

const send = (body) => attempt(() => browserApi("browser/input", body));

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
                        setPiBrowser(await browserApi("browser/open", { url: address }));
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

/** A tab's name in the strip: its title, or where it is. */
const tabName = (tab) => {
    if (tab.title) {
        return tab.title;
    }

    try {
        return new URL(tab.url).host || "Blank page";
    } catch {
        return "Blank page";
    }
};

/** Pi's tabs, when it has more than one: the one in front marked; tapping one brings it to the front. */
function Tabs({ state }) {
    return html`<div class="pb-tabs" role="tablist" aria-label="Pi's tabs">
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
                <b>Pi's browser${state?.place && state.place !== "phone" ? ` on ${state.where}` : ""}</b>
                <span class="pb-url" title=${state?.url ?? ""}>${state?.open ? state.title || state.url || "Blank page" : "Closed"}</span>
            </div>
            ${
                state?.open &&
                html`<button
                    class=${`button small ${takenOver ? "primary" : ""}`}
                    onClick=${() => attempt(async () => setPiBrowser(await browserApi("browser/take-over", { on: !takenOver })))}
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
        ${state?.open && (state.tabs?.length ?? 0) > 1 && html`<${Tabs} state=${state} />`}
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
                <button class="link small" onClick=${() => attempt(async () => setPiBrowser(await browserApi("browser/close", {})))}>Close Pi's browser</button>
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
    const { conversationId } = store.state;
    const state = piBrowserState();
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
    const { conversationId, me } = store.state;
    const state = piBrowserState();
    const place = browserPlace();
    const owner = me?.role === "owner";
    const doing = state?.doing ?? null;

    useEffect(() => {
        if (owner) {
            void browserApi("browser").then(setPiBrowser, () => {});
        }
    }, [owner, place]);

    useEffect(() => {
        if (owner && doing !== null && state?.session === conversationId && panelsBeside() && !browserShown() && Date.now() - closedAt > QUIET_MS) {
            setBrowserOpen(true);
        }
    }, [doing !== null, state?.session, conversationId]);

    return null;
}
