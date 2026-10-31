// Pi's browser (src/server/browser/pi-browser.ts): the page Pi works in, live, with what Pi is doing, and Take over / Hand
// back. It docks beside the conversation where Files does (one panel at a time) and covers the screen on phones, where a
// small live preview sits above the message box while Pi browses. On wide screens it opens by itself when Pi starts
// browsing in the session shown, unless it was closed a moment ago. The owner's: the page may be signed in as them.

import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { api, attempt, browserApi, browserPath, browserPlace, closePeople, onBrowserFrame, panelsBeside, piBrowserState, setPiBrowser, store } from "./store.js";
import { Choice, html, Icon } from "./ui.js";

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
        sessionStorage.removeItem("pocket.piComputer");
        closePeople();
        store.set({ browserOpen: true, filesOpen: false, computerOpen: false, drawer: false });
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

/**
 * Pictures of Pi's page while the component shows (PP-200), as JPEGs, not in the event stream: one request waits at the
 * server for the next picture (`GET /api/browser/frame?after=<number>`, up to 2 s) while the one before is drawn, so
 * each comes as soon as it is there, and a slow link or a busy phone gets the newest picture each time, never a queue of
 * old ones. After 2 s with none, the event stream's word of a new one (its number) starts the requests again.
 * `onFrame({ bitmap, width, height })`: the picture decoded off the main thread (an ImageBitmap), the page's size in CSS
 * pixels; the caller draws it, and closes the one it replaces.
 * `sized`: the element the picture fills: the server makes frames no bigger than it on screen, in device pixels.
 */
function useFrames(onFrame, sized) {
    const { streamId, conversationId: session } = store.state;
    const place = browserPlace();
    const latest = useRef(onFrame);

    latest.current = onFrame;

    useEffect(() => {
        if (streamId === undefined || typeof session !== "number") {
            return undefined;
        }

        const path = browserPath("browser/watch");
        const framePath = `api/${browserPath("browser/frame")}&connection=${encodeURIComponent(streamId)}`;
        const size = () => {
            const box = sized?.current?.getBoundingClientRect();
            // Twice the CSS pixels at most: sharper hardly shows on a phone, and costs a slow link a third of its frames.
            const ratio = Math.min(window.devicePixelRatio || 1, 2);

            return box && box.width > 0 && box.height > 0 ? { width: Math.round(box.width * ratio), height: Math.round(box.height * ratio) } : {};
        };
        const watch = (on) => api(path, { connection: streamId, on, ...(on ? size() : {}) });
        /** The newest picture's number this tab has. */
        let have = 0;
        let running = false;
        let stopped = false;
        /** The picture being decoded and shown, and the one before it. */
        let showing = Promise.resolve();
        let previous = Promise.resolve();
        const pull = async () => {
            if (running || stopped) {
                return;
            }

            running = true;

            try {
                while (!stopped) {
                    const response = await fetch(`${framePath}&after=${have}`, { headers: { "X-Pocket": "1" }, cache: "no-store" });

                    // None for 2 s (a still page): the event stream says when the next is there.
                    if (response.status !== 200) {
                        break;
                    }

                    const seq = Number(response.headers.get("x-frame-seq"));
                    const width = Number(response.headers.get("x-frame-width"));
                    const height = Number(response.headers.get("x-frame-height"));
                    // Decoded off the main thread; drawn once the one before is.
                    const decoded = createImageBitmap(await response.blob());
                    const before = showing;

                    have = Math.max(have, seq);
                    showing = Promise.all([decoded, before]).then(
                        ([bitmap]) => (stopped ? bitmap.close() : latest.current({ bitmap, width, height })),
                        () => {},
                    );
                    // The next request goes at once: it waits at the server while this one decodes. One more goes only
                    // once the picture before this one is drawn: never more than two wait to be drawn.
                    await previous;
                    previous = before;
                }
            } catch {
                // A request that failed (the server restarting): the event stream's next word starts them again.
            } finally {
                running = false;
            }
        };
        const off = onBrowserFrame((frame) => {
            if ((frame.place ?? "phone") === place && frame.session === session && !(Number(frame.seq) <= have)) {
                void pull();
            }
        });
        // A new size on screen (a turned phone, a resized window): frames of that size.
        let resized;
        const observer =
            typeof ResizeObserver === "function" && sized?.current
                ? new ResizeObserver(() => {
                      clearTimeout(resized);
                      resized = setTimeout(() => void watch(true).catch(() => {}), 300);
                  })
                : undefined;

        observer?.observe(sized.current);
        void watch(true).then(setPiBrowser, () => {});

        return () => {
            stopped = true;
            off();
            observer?.disconnect();
            clearTimeout(resized);
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
 * The last picture of each session's browser (`place#session`), an ImageBitmap: the panel opened again shows it at once,
 * until the next frame comes. In this tab's memory only.
 */
const lastFrames = new Map();

/** Draw `bitmap` on `canvas`, at the bitmap's own size (the canvas is sized on screen by its box). */
function draw(canvas, bitmap) {
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
    }

    canvas.getContext("2d").drawImage(bitmap, 0, 0);
}

/**
 * The live picture: a canvas drawn in place (frames skip the store, which would redraw the whole app each time; a
 * canvas takes a picture decoded off the main thread, with no layout, PP-200).
 */
function Frame({ interactive, onWheel }) {
    const image = useRef(null);
    const box = useRef(null);
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
        const before = lastFrames.get(key);

        lastFrames.set(key, frame.bitmap);

        if (image.current) {
            draw(image.current, frame.bitmap);
        }

        // The picture before is no longer shown anywhere: its memory goes.
        if (before !== undefined && before !== frame.bitmap) {
            before.close();
        }

        setHas(true);
    }, box);

    // Opened again: the last picture at once.
    useEffect(() => {
        const kept = lastFrames.get(key);

        if (kept !== undefined && image.current) {
            draw(image.current, kept);
        }
    }, [key]);

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
    /**
     * A press on the picture leaves the focus where it is, as the take-over keys do (PP-181): the press's default would
     * focus the panel before the tap's click gives it back to the field, and on a phone the keyboard goes when the focus
     * leaves a text field, even for that moment. The click still comes.
     */
    const down = (event) => {
        if (!interactive) {
            return;
        }

        event.preventDefault();

        if (event.pointerType === "mouse") {
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
        ref=${box}
        class=${`pb-frame ${interactive ? "live" : ""}`}
        style=${`aspect-ratio:${viewport.width}/${viewport.height};--ratio:${viewport.width / viewport.height};--frame-max:${state?.size === "desktop" ? "100cqw" : "460px"}`}
    >
        <canvas
            ref=${image}
            role="img"
            aria-label=${has ? t("Pi's browser, live") : ""}
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
        ></canvas>
        ${!has && !state?.pictureError && html`<span class="pb-wait">${t("Waiting for the page…")}</span>`}
        ${
            state?.pictureError &&
            html`<div class=${`pb-picture-error ${has ? "over" : ""}`} role="status">
                <span>${has ? t("The picture is not live: this is the last one.") : t("The page's picture did not come.")}</span>
                ${!has && html`<small>${state.pictureError}</small>`}
                <button class="button small" type="button" onClick=${() => attempt(async () => setPiBrowser(await browserApi("browser/frames", {})))}>${t("Retry")}</button>
            </div>`
        }
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

/**
 * Where this session browses (PP-274): this phone or one of the owner's machines, as browser_open's machine does; or,
 * attached to a browser on a machine (browser_attach), its name with Detach, which leaves it running.
 */
function BrowseOn({ state }) {
    const machines = store.state.server?.browserMachines ?? [];
    const place = browserPlace();

    if (place.startsWith("attach:")) {
        return html`<div class="pb-on">
            <span class="pb-on-label">${t("Attached to {label}", { label: state?.attached ?? place })}</span>
            <button class="link small" type="button" onClick=${() => attempt(() => browserApi("browser/detach", {}))}>${t("Detach")}</button>
        </div>`;
    }

    if (machines.length === 0) {
        return null;
    }

    return html`<div class="pb-on">
        <span class="pb-on-label">${t("Browse on")}</span>
        <${Choice}
            label=${t("Browse on")}
            value=${place}
            options=${[{ value: "phone", label: t("This phone") }, ...machines.map((machine) => ({ value: `machine:${machine.id}`, label: machine.name }))]}
            onChange=${(chosen) =>
                chosen !== place &&
                void attempt(async () => {
                    const answer = await api(browserPath("browser/place"), { place: chosen === "phone" ? "phone" : chosen.slice("machine:".length) }, { method: "PUT" });

                    store.set((now) => ({ browserPlaces: { ...now.browserPlaces, [String(now.conversationId)]: answer.place } }));
                    setPiBrowser(answer.browser);
                })}
        />
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
                ${state?.attached && html`<span class="pb-attached">${t("Attached: {label}", { label: state.attached })}</span>`}
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
        ${state?.windowInUse && html`<div class="pb-in-use" role="status">${t("Someone is using this browser's window on {where}.", { where: state.where })}</div>`}
        <div class="pb-body">
            ${
                state?.open
                    ? html`<${Frame} interactive=${takenOver} onWheel=${(point) => send({ type: "scroll", ...point })} />`
                    : html`<div class="pb-empty">
                          <${Icon} name="globe" size=${28} />
                          <p>${t("Pi's browser opens when Pi browses: ask Pi to open a page, or to do something on a site.")}</p>
                          <${BrowseOn} state=${state} />
                      </div>`
            }
        </div>
        ${takenOver && html`<${TakeOverBar} />`}
        ${
            state?.open &&
            html`<footer class="pb-foot">
                <${SizeSwitch} state=${state} />
                <${BrowseOn} state=${state} />
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
            draw(image.current, frame.bitmap);
        }

        frame.bitmap.close();
    }, image);

    return html`<canvas ref=${image} aria-hidden="true" class="pb-thumb"></canvas>`;
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
