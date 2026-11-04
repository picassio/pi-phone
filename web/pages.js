/**
 * Artifacts kept as pages (PP-370): a person keeps an artifact from its card in the chat or from the viewer, and it shows
 * as a page of their own, opened from the rail, in the conversation's place as an extension's page is. The page is the
 * artifact in the artifacts' sandbox (an opaque origin, no cookies, the same CSP), at its newest version, which the
 * server says (`src/server/kept-pages.ts`): a new version loads it again. Its one way into the app is a message that
 * puts text into the message box of the session the person is in (`pi-compose`); the viewer takes the same message.
 */
import { useEffect, useRef } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { OpenUiFrame } from "./openui.js";
import { api, attempt, insertIntoComposer, navigate, notify, store } from "./store.js";
import { modeOf, paletteOf, themeVars } from "./theme.js";
import { html, Icon, railState, StateTag } from "./ui.js";

/** The page slot's module name for kept pages: not an extension's (theirs come from module files). */
export const KEPT_PAGE = "kept";

/** The most text a page puts into the message box at once. */
const MAX_COMPOSE = 20_000;

/** The frame's sandbox: the artifact viewer's. */
export const ARTIFACT_SANDBOX = "allow-scripts allow-forms allow-modals allow-popups allow-pointer-lock allow-downloads";

const pageId = (conversation, artifact) => `${conversation}/${artifact}`;

/**
 * The app's theme for a Markdown artifact's page, in its address: in its sandbox, the page cannot see the app's look,
 * and would otherwise take the browser's light or dark (`src/server/http/artifacts.ts`).
 */
export function themeQuery() {
    const palette = paletteOf();
    const vars = themeVars(palette);
    const hex = (name) => vars[name].replace(/^#/, "");

    return `?${new URLSearchParams({
        mode: modeOf(palette),
        bg: hex("--o-bg"),
        fg: hex("--o-fg"),
        text: hex("--o-fg-bright"),
        accent: hex("--o-accent"),
        code: hex("--o-bg-dark"),
    })}`;
}

/** This person's kept page of an artifact, or undefined. */
export function keptPage(conversation, artifact) {
    return store.state.keptPages.pages.find((page) => page.conversation === Number(conversation) && page.artifact === artifact);
}

/** Keep an artifact as a page, or take it off the rail; the list comes back from the server, and to every device. */
export function keepPage(conversation, artifact, kept) {
    return attempt(async () => {
        store.set({ keptPages: await api("kept-pages", { conversation: Number(conversation), artifact, kept }) });
    });
}

/** Put the pages in this order (Settings › Pages). */
export function orderPages(pages) {
    return attempt(async () => {
        store.set({
            keptPages: await api("kept-pages/order", { pages: pages.map(({ conversation, artifact }) => ({ conversation, artifact })) }),
        });
    });
}

/** Open a kept page in the conversation's place, over what shows there. */
export function openKeptPage(page) {
    store.set({
        page: { module: KEPT_PAGE, id: pageId(page.conversation, page.artifact) },
        sheet: null,
        launcher: false,
        board: false,
        boardAgents: null,
        drawer: false,
    });
}

const closePage = () => store.set({ page: null });

/**
 * Text from an artifact into the message box of the session the person is in, after what is there: the page or the
 * viewer closes, and the person sends it, or not. With no session open (a page opened from the rail on a phone, where
 * the rail is the home screen's), it goes to `home`, the session the artifact is from, which opens; with neither,
 * nothing goes anywhere, and it says so.
 */
function compose(text, home) {
    if (store.state.conversationId === null && home === undefined) {
        notify("error", t("Open a session first: a page puts its text into the message box of the session you are in."));

        return;
    }

    if (text.length > MAX_COMPOSE) {
        notify("error", t("The page sent more text than the message box takes ({n} characters at most).", { n: MAX_COMPOSE }));

        return;
    }

    if (store.state.conversationId === null) {
        // Going to the session closes the page; its message box takes the text as it opens.
        navigate(home);
    } else {
        closePage();
    }

    insertIntoComposer(text);
}

/**
 * An artifact's frame may put text into the message box: `parent.postMessage({ type: "pi-compose", text }, "*")`. Only
 * that frame's own window counts, and only text. `home`: the session the artifact is from (a kept page's).
 */
export function useComposeBridge(frame, home) {
    useEffect(() => {
        const onMessage = (event) => {
            const data = event.data;

            if (frame.current === null || event.source !== frame.current.contentWindow || data?.type !== "pi-compose") {
                return;
            }

            if (typeof data.text === "string" && data.text.trim() !== "") {
                compose(data.text, home);
            }
        };

        addEventListener("message", onMessage);

        return () => removeEventListener("message", onMessage);
    }, [home]);
}

/**
 * Keep as a page, on an artifact's card in the chat and in the viewer; once kept, a word that says so and a way to the
 * page. Nothing while pages are off (`artifacts.pages`).
 */
export function KeepButton({ conversation, artifact }) {
    const { keptPages } = store.state;

    if (!keptPages.on) {
        return null;
    }

    const page = keptPage(conversation, artifact);

    return page === undefined
        ? html`<button class="button small" data-part="keep-page" onClick=${() => keepPage(conversation, artifact, true)}>
              ${t("Keep as a page")}
          </button>`
        : html`<span class="kept-state" data-part="kept-page-state">
              <${StateTag} label=${t("Kept as a page")} />
              <button class="button small ghost" data-part="open-kept-page" onClick=${() => openKeptPage(page)}>${t("Open the page")}</button>
          </span>`;
}

/** The kept pages on the rail, after the extensions' buttons: each its title, one line icon, open or not. */
export function KeptPageRailButtons() {
    const { keptPages, page: open } = store.state;

    if (!keptPages.on || keptPages.pages.length === 0) {
        return null;
    }

    return html`<div class="rail-exts" data-part="kept-pages">
        ${keptPages.pages.map((page) => {
            const shown = open?.module === KEPT_PAGE && open.id === pageId(page.conversation, page.artifact);

            return html`<button
                key=${pageId(page.conversation, page.artifact)}
                class=${`rail-button rail-ext ${shown ? "open" : ""}`}
                data-part="rail-button"
                data-page=${pageId(page.conversation, page.artifact)}
                data-state=${railState(shown)}
                title=${page.title}
                aria-label=${page.title}
                aria-pressed=${shown}
                onClick=${() => (shown ? closePage() : openKeptPage(page))}
            >
                <${Icon} name="artifact" size=${20} />
            </button>`;
        })}
    </div>`;
}

/** A kept page, in the conversation's place: its title, where it is from, Reload, Remove from the rail, and Close. */
export function KeptPage({ id }) {
    const frame = useRef(null);
    const page = store.state.keptPages.pages.find((each) => pageId(each.conversation, each.artifact) === id);

    useBack(true, closePage);
    useComposeBridge(frame, page?.conversation);

    // Esc closes it, as it closes an extension's page, unless a sheet or the launcher is over it.
    useEffect(() => {
        const onKey = (event) => {
            const { sheet, launcher } = store.state;

            if (event.key === "Escape" && !event.isComposing && !event.defaultPrevented && !sheet && !launcher) {
                event.preventDefault();
                closePage();
            }
        };

        addEventListener("keydown", onKey);

        return () => removeEventListener("keydown", onKey);
    }, []);

    const src =
        page === undefined
            ? null
            : `a/${page.conversation}/${encodeURIComponent(page.artifact)}/${page.version}${page.type === "markdown" ? themeQuery() : ""}`;

    return html`<section class="ext-page kept-page" data-part="kept-page" aria-label=${page?.title ?? t("Page")}>
        <header class="board-head">
            <div class="board-title">
                <h2>${page?.title ?? t("Page")}</h2>
                ${page && html`<div class="board-sub">${t("{session} · version {version}", { session: page.session, version: page.version })}</div>`}
            </div>
            ${
                page &&
                html`<button
                    class="button small ghost"
                    data-part="unkeep-page"
                    onClick=${() => keepPage(page.conversation, page.artifact, false)}
                >
                    ${t("Remove from the rail")}
                </button>`
            }
            <button class="icon-button" title=${t("Back to the conversation (Esc)")} aria-label=${t("Close")} onClick=${closePage}>
                <${Icon} name="close" />
            </button>
        </header>
        ${
            page === undefined
                ? html`<div class="ext-page-body">
                      <p class="muted">${t("This page is no longer on your rail.")}</p>
                  </div>`
                : page.type === "openui"
                  ? html`<${OpenUiFrame}
                        key=${src}
                        src=${`${src}?theme=${modeOf(paletteOf()) === "dark" ? "dark" : "light"}`}
                        title=${page.title}
                        fill
                        ask=${compose}
                        conversation=${page.conversation}
                    />`
                  : html`<iframe
                        key=${src}
                        ref=${frame}
                        class="kept-page-frame"
                        src=${src}
                        sandbox=${ARTIFACT_SANDBOX}
                        allow="fullscreen; clipboard-write; accelerometer; gyroscope"
                        title=${page.title}
                    ></iframe>`
        }
    </section>`;
}

/** Settings › Pages: whether pages are on (the owner's), and this person's pages, to order and remove. */
export function PagesSheetBody() {
    const { keptPages, me } = store.state;
    const pages = keptPages.pages;
    const move = (index, by) => {
        const next = [...pages];
        const [moved] = next.splice(index, 1);

        next.splice(index + by, 0, moved);
        orderPages(next);
    };
    const setOn = (on) => attempt(async () => store.set({ keptPages: await api("kept-pages/on", { on }, { method: "PUT" }) }));

    return html`<div class="pages-sheet" data-part="pages-sheet">
        ${
            me?.role === "owner" &&
            html`<div class="sheet-list">
                <div class="setting-row">
                    <div class="setting-text">
                        <span>${t("Keep artifacts as pages")}</span>
                        <span>
                            ${keptPages.on
                                ? t("Anyone can keep an artifact they see as a page of their own, opened from the rail. A page runs in the artifacts' sandbox and can only put text into the message box.")
                                : t("No artifact can be kept, and kept pages leave every rail until this is on again.")}
                        </span>
                    </div>
                    <div class="segmented">
                        ${[
                            [true, t("On")],
                            [false, t("Off")],
                        ].map(
                            ([key, label]) =>
                                html`<button class=${keptPages.on === key ? "on" : ""} aria-pressed=${keptPages.on === key} onClick=${() => key !== keptPages.on && setOn(key)}>
                                    ${label}
                                </button>`,
                        )}
                    </div>
                </div>
            </div>`
        }
        ${
            keptPages.on &&
            html`<div class="group-title">${t("Your pages")}</div>
                ${
                    pages.length === 0
                        ? html`<p class="muted small">${t("None yet. Keep an artifact as a page from its card in the chat, or from the artifact viewer.")}</p>`
                        : html`<div class="sheet-list" data-part="kept-pages-list">
                              ${pages.map(
                                  (page, index) => html`<div class="kept-row" key=${pageId(page.conversation, page.artifact)} data-page=${pageId(page.conversation, page.artifact)}>
                                      <button class="kept-name" onClick=${() => openKeptPage(page)}>
                                          <${Icon} name="artifact" size=${16} />
                                          <span class="kept-text">
                                              <span class="kept-title">${page.title}</span>
                                              <span class="kept-from muted small">${t("{session} · version {version}", { session: page.session, version: page.version })}</span>
                                          </span>
                                      </button>
                                      <button class="icon-button small" aria-label=${t("Move up")} title=${t("Move up")} disabled=${index === 0} onClick=${() => move(index, -1)}>
                                          <${Icon} name="up" size=${16} />
                                      </button>
                                      <button class="icon-button small" aria-label=${t("Move down")} title=${t("Move down")} disabled=${index === pages.length - 1} onClick=${() => move(index, 1)}>
                                          <${Icon} name="arrow-down" size=${16} />
                                      </button>
                                      <button class="button small ghost" data-part="unkeep-page" onClick=${() => keepPage(page.conversation, page.artifact, false)}>
                                          ${t("Remove from the rail")}
                                      </button>
                                  </div>`,
                              )}
                          </div>`
                }`
        }
    </div>`;
}
