// Select words in one of Pi's replies and reply to just those (from pi-pocket, PP-345): a small Reply button appears,
// and the passage waits above the message box as a quote. With a mouse it sits by the selection. On a touch screen the
// system's own selection menu (Android's floating toolbar in pi-phone's WebView) sits just above the selection, or just
// below it when there is no room above, and its handles hang under the ends: there the button docks at the bottom or the
// top of the conversation, on whichever edge is clear of the selection, its handles, and where that menu can go.
import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n.js";
import { quoteReply } from "./store.js";
import { html, Icon } from "./ui.js";

const coarse = matchMedia("(pointer: coarse)").matches;
const WIDTH = 84;
const HEIGHT = 32;
/** How far a selection handle hangs under its line on a touch screen. */
const HANDLE = 28;
/** The room the system's selection menu takes beside the selection: its height and its margin. */
const MENU = 64;
/** The docked button's gap to the conversation's edge. */
const GAP = 12;

/** Whether a button at `top` stays out of the band from `from` to `to` (screen pixels). */
const clear = (top, from, to) => top + HEIGHT <= from || top >= to;

/** Where the button docks on a touch screen, or null when it has no room. */
function docked(view, first, last) {
    const bottom = view.bottom - GAP - HEIGHT;
    const top = view.top + GAP;
    const spots = [bottom, top].filter((spot) => spot >= view.top && spot + HEIGHT <= view.bottom);
    // Clear of the words, the handles, and the menu on either side of them; else of the words and the handles only, as
    // a menu over a selection taller than the screen sits over its middle.
    const spot =
        spots.find((each) => clear(each, first.top - MENU, last.bottom + HANDLE + MENU)) ??
        spots.find((each) => clear(each, first.top, last.bottom + HANDLE)) ??
        spots[0];

    return spot === undefined ? null : { top: spot, left: view.left + (view.width - WIDTH) / 2 };
}

/** The selected passage and where to put the button, when the selection lies within one reply of Pi's. */
function selected() {
    const selection = getSelection();

    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        return null;
    }

    const range = selection.getRangeAt(0);
    const within = (node) => (node.nodeType === 1 ? node : node.parentElement)?.closest(".reply");
    // A triple-click can end the range at the start of the next block: that end does not count.
    const end =
        range.endOffset === 0 && range.endContainer !== range.startContainer
            ? range.commonAncestorContainer
            : range.endContainer;
    const from = within(range.startContainer);
    const to = within(end) ?? (within(range.commonAncestorContainer) ? from : null);
    const text = selection.toString().trim();

    // Whoever cannot write to Pi has no message box to put the quote in.
    if (!from || from !== to || text === "" || !document.querySelector('[data-part="composer"] textarea')) {
        return null;
    }

    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0);

    if (rects.length === 0) {
        return null;
    }

    const first = rects[0];
    const last = rects[rects.length - 1];
    // The button stays inside the scrolling area, not over the top bar or the message box.
    const box = from.closest(".scroller")?.getBoundingClientRect();
    const view = box ?? { top: 0, bottom: visualViewport?.height ?? innerHeight, left: 0, width: innerWidth };

    if (coarse) {
        const spot = docked(view, first, last);

        return spot && { text, ...spot };
    }

    const above = first.top - HEIGHT - 8;
    const under = last.bottom + 8;
    let below = above < view.top;
    let top = below ? under : above;

    if (below && top + HEIGHT > view.bottom) {
        below = false;
        top = above;
    }

    if (top < view.top || top + HEIGHT > view.bottom) {
        return null;
    }

    const anchor = below ? last.right : first.left;
    const left = Math.max(8, Math.min(anchor - (below ? WIDTH : 0), innerWidth - WIDTH - 8));

    return { text, top, left };
}

export function QuoteReplyButton() {
    const [at, setAt] = useState(null);

    useEffect(() => {
        let timer = 0;

        const look = () => {
            clearTimeout(timer);
            // Dragging a handle changes the selection all the time: show the button once it holds still.
            timer = setTimeout(() => setAt(selected()), 160);
        };

        document.addEventListener("selectionchange", look);
        addEventListener("scroll", look, true);
        addEventListener("resize", look);

        return () => {
            clearTimeout(timer);
            document.removeEventListener("selectionchange", look);
            removeEventListener("scroll", look, true);
            removeEventListener("resize", look);
        };
    }, []);

    if (!at) {
        return null;
    }

    const reply = () => {
        quoteReply(at.text);
        getSelection()?.removeAllRanges();
        setAt(null);

        if (!coarse) {
            requestAnimationFrame(() => document.querySelector('[data-part="composer"] textarea')?.focus());
        }
    };

    // Pressing the button must not take the selection away before the click reads it.
    return html`<button
        class="quote-reply-button"
        data-part="quote-reply-button"
        style=${`top:${Math.round(at.top)}px;left:${Math.round(at.left)}px`}
        onPointerDown=${(event) => event.preventDefault()}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${reply}
    >
        <${Icon} name="reply" size=${14} stroke=${2} />
        <span>${t("Reply")}</span>
    </button>`;
}
