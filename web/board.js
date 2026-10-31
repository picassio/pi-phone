// The floating progress board (PP-283, GitHub issue #5): what the pi bubble opens over the app in front
// (`ProgressBubble.java`, `/?board=1`). The sessions at work and the ones waiting for the owner, each with what it does
// now; a simple card is answered here (Approve, Deny), a row opens its session in the app, the dash folds the board back
// to the bubble. Read from the server's progress board (`progress.ts`), a long poll for each new version.
import { useEffect, useState } from "preact/hooks";
import { t, timeAgo } from "./i18n.js";
import { api, attempt } from "./store.js";
import { html, Icon } from "./ui.js";

/** This page is the floating board, not the app. */
export const BOARD = new URLSearchParams(location.search).has("board");

/** The Android bubble's bridge: open a session, open the app, fold the board. Absent in a browser (a test's). */
const bubble = () => window.PiBoard;

/** pi's logo (web/icon.svg's mark), at `size` pixels. */
export const PiMark = ({ size = 18 }) =>
    html`<svg viewBox="105 105 470 470" width=${size} height=${size} aria-hidden="true" class="pi-mark">
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
    </svg>`;

export function BoardView() {
    const [board, setBoard] = useState(null);

    // The board as the server says it, each new version as it comes.
    useEffect(() => {
        let stopped = false;
        let version = -1;

        const poll = async () => {
            while (!stopped) {
                try {
                    const next = await api(`phone/progress?after=${version}&lang=${encodeURIComponent(navigator.language)}`);

                    version = next.version;
                    setBoard(next);
                } catch {
                    await new Promise((resolve) => setTimeout(resolve, 3000));
                }
            }
        };

        void poll();

        return () => {
            stopped = true;
        };
    }, []);

    const open = (session) => (bubble() ? bubble().open(session) : location.assign(`/s/${session}`));
    const answer = (id, allow) => attempt(() => api(`approvals/${encodeURIComponent(id)}`, { allow }));

    return html`<div class="pgb" data-part="progress-board">
        <div class="pgb-head">
            <${PiMark} />
            <b>${board === null ? t("Loading…") : board.heading}</b>
            ${bubble() && html`<button class="icon-button" type="button" aria-label=${t("Fold")} onClick=${() => bubble().fold()}><${Icon} name="minus" size=${16} /></button>`}
        </div>
        ${board !== null && board.rows.length === 0 && html`<p class="muted small pgb-empty">${t("Nothing runs now.")}</p>`}
        ${(board?.rows ?? []).map(
            (row) => html`<div class="pgb-row" data-part="pgb-row" data-state=${row.state} key=${row.conversationId}>
                <span class=${`pgb-dot ${row.state}`} aria-hidden="true"></span>
                <button type="button" class="pgb-text" onClick=${() => open(row.session)}>
                    <b>${row.title}</b>
                    <small>${row.doing} · ${timeAgo(row.since)}</small>
                </button>
                ${
                    row.approval?.simple
                        ? html`<span class="pgb-answer">
                              <button type="button" class="button small primary" data-part="board-approve" onClick=${() => answer(row.approval.id, true)}>${t("Approve")}</button>
                              <button type="button" class="button small" onClick=${() => answer(row.approval.id, false)}>${t("Deny")}</button>
                          </span>`
                        : html`<${Icon} name="chevron" size=${15} />`
                }
            </div>`,
        )}
        ${board !== null && board.more > 0 && html`<p class="muted small pgb-empty">${t("and {n} more", { n: board.more })}</p>`}
        <div class="pgb-foot">
            <span class="muted small">${board === null || board.done === 0 ? "" : t("{n} done in the last hour", { n: board.done })}</span>
            <button type="button" class="button small ghost" onClick=${() => (bubble() ? bubble().openApp() : location.assign("/"))}>${t("Open pi-phone")}</button>
        </div>
    </div>`;
}
