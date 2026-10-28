// Getting started (PP-235): the owner's session where Pi shows them around, and its checklist under the session's header
// (the `guide` tool keeps it: the topics they picked, ticked as Pi finishes each). On a phone the bar is one line, with
// the part Pi is on; it opens to the whole list. On a wide screen the whole list shows.
import { useState } from "preact/hooks";
import { currentLanguage, t } from "./i18n.js";
import { api, attempt, closeSheet, navigate, store } from "./store.js";
import { html, Icon, WIDE } from "./ui.js";

/**
 * Open the owner's Getting started session: again when there is one, else a new one that Pi starts. With no model yet
 * Pi cannot guide: the welcome opens instead, at its model step's way. `whatsNew`: a version Pi then walks through.
 */
export function openGettingStarted({ whatsNew } = {}) {
    closeSheet();

    if (store.state.models.length === 0) {
        return attempt(() => api("me", { welcome: "show" }));
    }

    return attempt(async () => {
        const { session } = await api("getting-started", { language: currentLanguage(), ...(whatsNew === undefined ? {} : { whatsNew }) });

        navigate(session);
    });
}

/** The checklist bar, in a session whose view has one. */
export function GuideBar() {
    const guide = store.state.view.guide;
    const [open, setOpen] = useState(false);

    if (!guide || guide.items.length === 0) {
        return null;
    }

    const done = guide.items.filter((item) => item.done).length;
    const now = guide.items.find((item) => !item.done);
    const full = open || WIDE.matches;

    return html`<section class=${`guide-bar ${full ? "open" : ""}`} data-part="guide-checklist" aria-label=${t("Getting started")}>
        <button class="guide-head" type="button" aria-expanded=${full} disabled=${WIDE.matches} onClick=${() => setOpen(!open)}>
            <b>${t("Getting started")}</b>
            <span class="muted small">${t("{done} of {n} done", { done, n: guide.items.length })}</span>
            <span class="guide-progress" aria-hidden="true"><i style=${`width:${Math.round((done / guide.items.length) * 100)}%`}></i></span>
            ${!WIDE.matches && html`<${Icon} name="chevron" size=${14} class=${open ? "guide-chevron up" : "guide-chevron"} />`}
        </button>
        ${
            !full &&
            html`<div class="guide-now muted small">
                ${guide.finished || now === undefined ? t("All done.") : html`${t("Now:")} <b>${now.text}</b>`}
            </div>`
        }
        ${
            full &&
            html`<ul class="guide-items">
                ${guide.items.map(
                    (item) => html`<li class=${item.done ? "done" : item === now && !guide.finished ? "now" : ""}>
                        <span class="guide-mark" role="img" aria-label=${item.done ? t("done") : t("to do")}>${item.done && html`<${Icon} name="check" size=${12} />`}</span>
                        ${item.text}
                    </li>`,
                )}
            </ul>`
        }
    </section>`;
}
