// The floating progress board (PP-283, GitHub issue #5): what the pi bubble opens over the app in front
// (`ProgressBubble.java`, `/?board=1`). The sessions at work and the ones waiting for the owner, each with what it does
// now; a simple card is answered here (Approve, Deny), a row opens its session in the app, the dash folds the board back
// to the bubble. Read from the server's progress board (`progress.ts`), a long poll for each new version.
import { useEffect, useState } from "preact/hooks";
import { t, timeAgo } from "./i18n.js";
import { InterviewSheet } from "./sheets/interview.js";
import { actions, api, attempt, navigate, openSheet, store } from "./store.js";
import { Transcript } from "./transcript.js";
import { folderColor } from "./avatar.js";
import { html, Icon } from "./ui.js";

/**
 * A session opened on the board (the owner: a tapped row opens it in the floating panel, not the app): its transcript,
 * approvals and cards included, and a line to write to Pi; back to the board, or on to the app.
 */
function BoardSession({ session, title, back, toApp }) {
    const [text, setText] = useState("");
    const send = (event) => {
        event.preventDefault();

        const message = text.trim();

        if (message === "") {
            return;
        }

        setText("");
        attempt(() => actions.submit(message, [], store.state.view.live?.busy ? "steer" : "followUp"));
    };

    return html`<div class="pgb pgb-session" data-part="board-session">
        <div class="pgb-head">
            <button class="icon-button" type="button" aria-label=${t("Back")} onClick=${back}><${Icon} name="back" size=${16} /></button>
            <b>${title}</b>
            <button class="button small ghost" type="button" onClick=${toApp}>${t("Open pi-phone")}</button>
        </div>
        <div class="pgb-transcript">${store.state.conversationId === session && store.state.view.agent !== undefined ? html`<${Transcript} key=${session} />` : html`<p class="muted small pgb-empty">${t("Loading…")}</p>`}</div>
        <form class="pgb-reply" onSubmit=${send}>
            <input value=${text} placeholder=${t("Ask Pi anything…")} aria-label=${t("Ask Pi anything…")} onInput=${(event) => setText(event.currentTarget.value)} />
            <button class="icon-button" type="submit" aria-label=${t("Send")} disabled=${text.trim() === ""}><${Icon} name="send" size=${16} /></button>
        </form>
    </div>`;
}

/** The board's filter chip picked last, on this phone: all, waiting, or working. */
const FILTER_KEY = "pocket.boardFilter";

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

    // A row opens its session here, in the panel; the app only from the session's Open pi-phone.
    const [viewing, setViewing] = useState(null);
    const [filter, setFilter] = useState(() => localStorage.getItem(FILTER_KEY) ?? "all");
    // The sessions whose subagents show, unfolded.
    const [folds, setFolds] = useState([]);
    // A subagent's row opens the subagent's own conversation (its work, its cards), titled "session · name".
    const open = (row) => {
        setViewing({ session: row.conversationId, title: row.title });
        navigate(row.conversationId, { route: false });
    };
    const answer = (id, allow) => attempt(() => api(`approvals/${encodeURIComponent(id)}`, { allow }));
    // A decision Pi asks (PP-284) is answered here, in its form: the board's window grows for it, and takes the keyboard.
    const sheet = store.state.sheet;
    const asking = sheet?.type === "interview";

    useEffect(() => {
        bubble()?.expand?.(asking || viewing !== null);
    }, [asking, viewing !== null]);

    if (asking) {
        return html`<div class="pgb-form"><${InterviewSheet} key=${sheet.callId} conversationId=${sheet.conversationId} callId=${sheet.callId} /></div>`;
    }

    if (viewing !== null) {
        return html`<${BoardSession}
            session=${viewing.session}
            title=${viewing.title}
            back=${() => setViewing(null)}
            toApp=${() => (bubble() ? bubble().open(viewing.session) : location.assign(`/s/${viewing.session}`))}
        />`;
    }

    // Every row (the owner's pick): what waits first, then at work; chips filter them, the pick kept on this phone.
    const rows = board?.rows ?? [];
    const counts = { all: rows.length, waiting: rows.filter((row) => row.state === "waiting").length, working: rows.filter((row) => row.state === "working").length };
    const shown = (state) => (filter === "all" || filter === state ? rows.filter((row) => row.state === state) : []);
    const pick = (next) => {
        localStorage.setItem(FILTER_KEY, next);
        setFilter(next);
    };
    const toggle = (id) => setFolds((was) => (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]));
    // Design A (the owner's pick): an inbox list. A square in the session folder's color with its initial, the title,
    // what it does under; a badge and the time on the right; what waits for you has its answer under it.
    const square = (row) => html`<span class="pgb-av" style=${`--av:${row.cwd ? folderColor(row.cwd) : "var(--accent)"}`} aria-hidden="true">${(row.title.trim()[0] ?? "P").toUpperCase()}</span>`;
    const badge = (row) =>
        row.approval?.interview
            ? html`<button type="button" class="pgb-badge wait" data-part="board-answer" onClick=${() => openSheet({ type: "interview", conversationId: row.conversationId, callId: row.approval.interview.callId })}>${t("Answer")}</button>`
            : row.state === "waiting"
            ? html`<span class="pgb-badge wait">${row.approval?.simple ? t("Approve?") : t("waiting")}</span>`
            : html`<span class="pgb-badge work">${t("working")}</span>`;
    const rowOf = (row) => {
        const unfolded = folds.includes(row.conversationId);

        return html`<div class=${`pgb-item ${row.state}`} key=${row.conversationId}>
            <div class="pgb-row" data-part="pgb-row" data-state=${row.state}>
                ${square(row)}
                <button type="button" class="pgb-text" onClick=${() => open(row)}>
                    <b>${row.title}</b>
                    <small>${row.doing}</small>
                </button>
                <span class="pgb-meta">${badge(row)}<time>${timeAgo(row.since)}</time></span>
            </div>
            ${
                row.approval?.simple &&
                html`<div class="pgb-ask">
                    <button type="button" class="pgb-btn" onClick=${() => answer(row.approval.id, false)}>${t("Deny")}</button>
                    <button type="button" class="pgb-btn primary" data-part="board-approve" onClick=${() => answer(row.approval.id, true)}>${t("Approve")}</button>
                </div>`
            }
            ${
                row.subagents?.length > 0 &&
                html`<button type="button" class="pgb-fold" data-part="pgb-fold" aria-expanded=${String(unfolded)} onClick=${() => toggle(row.conversationId)}>
                        ${row.subagentsText}<${Icon} name=${unfolded ? "up" : "down"} size=${12} />
                    </button>
                    ${
                        unfolded &&
                        html`<div class="pgb-subs">
                            ${row.subagents.map(
                                (sub) => html`<button type="button" class="pgb-sub" data-part="pgb-sub" key=${sub.conversationId} onClick=${() => open({ conversationId: sub.conversationId, title: `${row.title} · ${sub.name}` })}>
                                    <span class="pgb-tx"><b>${sub.name}</b><small>${sub.doing}</small></span><time>${timeAgo(sub.since)}</time>
                                </button>`,
                            )}
                        </div>`
                    }`
            }
        </div>`;
    };

    return html`<div class="pgb" data-part="progress-board">
        <div class="pgb-head">
            <${PiMark} size=${18} />
            <b>Pi</b>
            <span class="pgb-counts">${board === null ? t("Loading…") : board.heading}</span>
            ${bubble() && html`<button class="icon-button" type="button" aria-label=${t("Fold")} onClick=${() => bubble().fold()}><${Icon} name="minus" size=${16} /></button>`}
        </div>
        ${
            rows.length > 0 &&
            html`<div class="pgb-tabs" role="group" aria-label=${t("Show")}>
                ${[
                    ["all", t("All"), counts.all],
                    ["waiting", t("Waiting"), counts.waiting],
                    ["working", t("Working"), counts.working],
                ].map(([key, label, n]) => html`<button type="button" class=${`pgb-tab ${filter === key ? "on" : ""}`} data-part=${`pgb-chip-${key}`} aria-pressed=${String(filter === key)} onClick=${() => pick(key)}>${label} <em>${n}</em></button>`)}
            </div>`
        }
        <div class="pgb-list">
            ${board !== null && rows.length === 0 && html`<div class="pgb-idle"><${PiMark} size=${28} /><p class="muted small pgb-empty">${t("Nothing runs now.")}</p></div>`}
            ${shown("waiting").map(rowOf)}
            ${shown("working").map(rowOf)}
        </div>
        <div class="pgb-foot">
            <span>${board === null || board.done === 0 ? "" : t("{n} done in the last hour", { n: board.done })}</span>
            <button type="button" class="pgb-link" onClick=${() => (bubble() ? bubble().openApp() : location.assign("/"))}>${t("Open pi-phone")}</button>
        </div>
    </div>`;
}
