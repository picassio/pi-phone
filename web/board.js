// The floating progress board (PP-283, GitHub issue #5): what the pi bubble opens over the app in front
// (`ProgressBubble.java`, `/?board=1`). The sessions at work and the ones waiting for the owner, each with what it does
// now; a simple card is answered here (Approve, Deny), a row opens its session in the app, the dash folds the board back
// to the bubble. Read from the server's progress board (`progress.ts`), a long poll for each new version.
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { LAST_SESSION_KEY, targetFor } from "./assist.js";
import { t, timeAgo } from "./i18n.js";
import { InterviewSheet } from "./sheets/interview.js";
import { actions, api, attempt, navigate, openSheet, store } from "./store.js";
import { Transcript } from "./transcript.js";
import { folderColor } from "./avatar.js";
import { finishedUnseen, markSeen } from "./seen.js";
import { Choice, html, Icon, shortPath } from "./ui.js";
import { endVoice, sessionVoiceMode, setVoiceMuted, startVoice, toggleMic, voiceAvailable } from "./voice-call.js";
import { CallControls, ModeChoice, Recent, VOICE_MODES, Wave } from "./voice-view.js";

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

/**
 * A voice call from the bubble (PP-290, the owner's pick): to the session Menu › Assistant names (the last one, a new
 * one, or the one picked there), changeable here for this call. The bubble's service is told first, so the microphone
 * is pi's from behind another app; Android allows that only to the phone's digital assistant.
 */
const assistantSettings = () => ({ opens: "last", folder: null, session: null, ...store.state.server?.assistant });

async function callFrom(opens) {
    const settings = assistantSettings();
    const target = targetFor(opens, settings, store.state);

    if (bubble() && !bubble().assistantHeld()) {
        throw new Error(t("To talk to Pi from over other apps, make pi the phone's digital assistant app."));
    }

    if (bubble() && !bubble().micAllowed()) {
        throw new Error(t("Allow pi the microphone first: open pi-phone and start a voice call there once."));
    }

    let to = target.kind === "session" ? target.id : null;

    if (to === null) {
        to = (await actions.createSession(target.folder)).id;
        localStorage.setItem(LAST_SESSION_KEY, String(to));
    }

    bubble()?.callStarting(to, store.state.sessions.find((each) => each.id === to)?.title ?? t("New session"));
    navigate(to, { route: false });
    await startVoice(to);

    // It did not start (no voice set up, the microphone refused): the call's service goes too.
    if (store.state.voiceCall == null) {
        bubble()?.voiceCall(JSON.stringify({ state: "end" }));
    }
}

/** Where a call from the board goes: Menu › Assistant's choice, or another for this call. */
function callOptions() {
    const settings = assistantSettings();
    const state = store.state;
    const title = (opens) => {
        const target = targetFor(opens, settings, state);

        return target.kind === "session" ? target.title : t("A new session");
    };

    return [
        { value: "last", label: title("last"), detail: t("The last session") },
        { value: "new", label: t("A new session"), detail: shortPath(settings.folder ?? state.server?.defaultCwd ?? "", state.server?.home ?? "") },
        ...(settings.session !== null ? [{ value: "session", label: title("session"), detail: t("Picked in Menu › Assistant") }] : []),
    ];
}

/** The board's Voice line: where it talks to, and Voice. */
function VoiceRow({ problem, setProblem }) {
    const [opens, setOpens] = useState(() => assistantSettings().opens);

    return html`<div class="pgb-callrow" data-part="board-call-row">
            <div class="pgb-callto"><${Choice} value=${opens} options=${callOptions()} label=${t("Talk to")} onChange=${setOpens} /></div>
            <button
                type="button"
                class="pgb-callbtn"
                data-part="board-call"
                onClick=${() => {
                    setProblem(null);
                    callFrom(opens).catch((error) => setProblem(error.message));
                }}
            >
                <${Icon} name="voice" size=${16} />${t("Voice")}
            </button>
        </div>
        ${
            problem &&
            html`<div class="pgb-problem" data-part="board-call-problem">
                <span>${problem}</span>
                ${bubble() && !bubble().assistantHeld() && html`<button type="button" class="pgb-link" onClick=${() => bubble().openAssistantSettings()}>${t("Default apps")}</button>`}
            </div>`
        }`;
}

const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** Voice's state in a few words, with the time. */
function voiceStatus(call) {
    const status =
        call.status === "connecting"
            ? t("Connecting…")
            : call.status === "speaking"
              ? t("Speaking")
              : call.muted
                ? t("Mic off")
                : store.state.view.live?.busy
                  ? t("Pi working")
                  : t("Listening");

    return `${status} · ${clock(Date.now() - call.startedAt)}`;
}

/** Ticks every second, for the time shown. */
function useSecond() {
    const [, tick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);
}

/**
 * pi-phone's Voice on the board (PP-290, the owner's pick): the app's voice view in the panel. Its session is the title,
 * changeable there (Voice starts again in the one picked); the voice mode; what was said; the controls of the app's
 * Voice. The dash makes it the small Voice chip; pi's mark shows the board, with Voice as a bar over it.
 */
function BoardVoice({ call, small, toBoard, onType }) {
    // What waits for the owner is answered on the board (Approve, Deny, Answer): Show goes there.
    const [modes, setModes] = useState(false);
    const title = store.state.sessions.find((each) => each.id === call.session)?.title ?? t("New session");
    const mode = sessionVoiceMode(call.session);
    const modeName = VOICE_MODES().find(([value]) => value === mode)?.[1] ?? mode;
    const retarget = (opens) =>
        attempt(async () => {
            if (opens === "current") {
                return;
            }

            await endVoice({ quiet: true });
            await callFrom(opens);
        });

    return html`<div class="pgb pgb-voice" data-part="board-voice" data-state=${call.status}>
        <div class="pgb-head">
            <button type="button" class="icon-button" aria-label=${t("Show the board")} title=${t("Show the board")} data-part="board-voice-board" onClick=${toBoard}><${PiMark} size=${20} /></button>
            <div class="pgb-voice-title">
                <b>${t("Voice")}</b>
                <${Choice} value="current" options=${[{ value: "current", label: title, detail: t("Now") }, ...callOptions()]} label=${t("Talk to")} onChange=${retarget} />
            </div>
            <button
                class="assist-pill voice-mode-chip"
                aria-haspopup="true"
                aria-expanded=${modes}
                aria-label=${t("Voice mode: {mode}", { mode: modeName })}
                data-part="voice-mode"
                onClick=${() => setModes(!modes)}
            >
                <span class="assist-pill-name">${modeName}</span>
                <${Icon} name="down" size=${16} />
            </button>
            <button class="icon-button" type="button" aria-label=${t("Make it small")} data-part="board-voice-small" onClick=${small}><${Icon} name="minus" size=${16} /></button>
        </div>
        ${modes && html`<${ModeChoice} session=${call.session} mode=${mode} onDone=${() => setModes(false)} />`}
        ${store.state.conversationId === call.session && store.state.view.agent !== undefined ? html`<${Recent} />` : html`<div class="voice-recent"></div>`}
        <footer class="assist-foot voice-foot"><${CallControls} call=${call} onType=${onType} onShow=${toBoard} /></footer>
    </div>`;
}

/**
 * Voice made small (PP-290): a chip over other apps, the window fitted to it: pi's mark, Voice and its session, the state
 * and time, the live wave, the mic, End. A tap on it opens Voice again; on the board, the same as a bar back to Voice.
 */
function VoiceChip({ call, chip, open }) {
    const box = useRef(null);

    useSecond();

    // The chip's window as tall as the chip.
    useLayoutEffect(() => {
        if (!chip || box.current === null) {
            return undefined;
        }

        const fit = () => bubble()?.pill(Math.ceil(box.current.getBoundingClientRect().height) + 2);
        const watch = new ResizeObserver(fit);

        watch.observe(box.current);
        fit();

        return () => watch.disconnect();
    }, [chip]);

    const title = store.state.sessions.find((each) => each.id === call.session)?.title ?? t("New session");
    const tap = call.turns === "tap";

    return html`<div class=${`pgb-call ${chip ? "pill" : "bar"}`} ref=${box} data-part="board-call-pill" data-state=${call.status}>
        <div class="pgb-callline">
            <button type="button" class="pgb-calltext" aria-label=${t("Open Voice")} onClick=${open}>
                <${PiMark} size=${22} />
                <span><b>${t("Voice")} · ${title}</b><small>${voiceStatus(call)}</small></span>
            </button>
            <span class="pgb-chipwave"><${Wave} speaking=${call.status === "speaking"} quiet=${call.status === "connecting" || (call.muted && call.status !== "speaking")} /></span>
            ${
                !call.hold &&
                html`<button
                    type="button"
                    class=${`icon-button pgb-round ${call.muted ? "" : "on"}`}
                    aria-label=${tap ? (call.muted ? t("Tap to talk") : t("Mute")) : call.muted ? t("Unmute") : t("Mute")}
                    aria-pressed=${String(call.muted)}
                    data-part="board-call-mute"
                    onClick=${() => (tap ? toggleMic("tap") : setVoiceMuted(!call.muted))}
                >
                    <${Icon} name=${call.muted && !tap ? "micoff" : "mic"} size=${16} />
                </button>`
            }
            <button type="button" class="icon-button pgb-round" aria-label=${t("End the call")} data-part="board-call-end" onClick=${() => attempt(() => endVoice())}><${Icon} name="close" size=${16} /></button>
        </div>
    </div>`;
}

/** The board's filter chip picked last, on this phone: all, waiting, or working. */
const FILTER_KEY = "pocket.boardFilter";

/** This page is the floating board, not the app. */
export const BOARD = new URLSearchParams(location.search).has("board");
/** The bubble was double-tapped: the board opens in Voice and starts it (PP-290). */
const CALLING_NOW = BOARD && new URLSearchParams(location.search).has("call");

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

    // The panel as solid as the owner set it (PP-286): the whole of it, text included, its session and forms too.
    const opacity = board?.settings?.opacity ?? 100;

    useEffect(() => {
        document.body.style.opacity = opacity < 100 ? String(opacity / 100) : "";
    }, [opacity]);

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
    // pi-phone's Voice (PP-290): in the panel, made small as a chip over other apps, or a bar over the board. A double
    // tap on the bubble opens the board in Voice and starts it.
    const call = store.state.voiceCall;
    const [pill, setPill] = useState(false);
    const [boardWhileVoice, setBoardWhileVoice] = useState(false);
    const [problem, setProblem] = useState(null);
    const asPill = pill && call != null;
    // Voice in the panel: a taller window (PP-290).
    const voiceShown = call != null && !pill && !boardWhileVoice && !asking && viewing === null;

    useEffect(() => {
        if (!asPill) {
            if (voiceShown) {
                bubble()?.voice?.();
            } else {
                bubble()?.expand?.(asking || viewing !== null);
            }
        }
    }, [asking, viewing !== null, asPill, voiceShown]);

    // Folding the board with Voice on it (a tap outside, the dash, pi-phone in front) makes it the chip.
    useEffect(() => {
        globalThis.__piBoardFold = () => setPill(true);

        return () => delete globalThis.__piBoardFold;
    }, []);

    // A double tap's call: once the server says who it is (Menu › Assistant's choice, the sessions), it starts.
    const started = useRef(false);

    useEffect(() => {
        if (!CALLING_NOW || started.current || store.state.server == null || store.state.sessionsLoaded === false) {
            return;
        }

        started.current = true;
        callFrom(assistantSettings().opens).catch((error) => setProblem(error.message));
    }, [store.state.server, store.state.sessionsLoaded]);

    // Voice ended: as the chip, back to the bubble; in the panel, back to the board.
    const had = useRef(false);

    useEffect(() => {
        if (call != null) {
            had.current = true;
        } else if (had.current) {
            had.current = false;
            setBoardWhileVoice(false);

            if (pill) {
                setPill(false);
                bubble()?.fold();
            }
        }
    }, [call == null]);

    if (asPill) {
        return html`<${VoiceChip} call=${call} chip=${true} open=${() => setPill(false)} />`;
    }

    if (voiceShown) {
        return html`<${BoardVoice}
            call=${call}
            small=${() => setPill(true)}
            toBoard=${() => setBoardWhileVoice(true)}
            onType=${() => {
                setViewing({ session: call.session, title: store.state.sessions.find((each) => each.id === call.session)?.title ?? t("New session") });
                navigate(call.session, { route: false });
            }}
        />`;
    }

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
    // Sessions done in the last day under them (PP-287): a Done tab, and a section of All.
    const rows = board?.rows ?? [];
    const finished = board?.finished ?? [];
    const counts = {
        all: rows.length + finished.length,
        waiting: rows.filter((row) => row.state === "waiting").length,
        working: rows.filter((row) => row.state === "working").length,
        done: finished.length,
    };
    const shown = (state) => (filter === "all" || filter === state ? (state === "done" ? finished : rows.filter((row) => row.state === state)) : []);
    // A section's name, in All only: the tabs name it otherwise.
    const section = (state, label) => filter === "all" && shown(state).length > 0 && html`<div class="pgb-sec">${label}</div>`;
    // Finished since this phone last looked at it, as the session list marks it: a blue dot, gone once opened.
    const unseen = (row) => (row.state === "done" || row.state === "failed") && finishedUnseen({ id: row.session, busy: false, endedAt: row.since });
    const pick = (next) => {
        localStorage.setItem(FILTER_KEY, next);
        setFilter(next);
    };
    const toggle = (id) => setFolds((was) => (was.includes(id) ? was.filter((each) => each !== id) : [...was, id]));
    // Design A (the owner's pick): an inbox list. A square in the session folder's color with its initial, the title,
    // what it does under; a badge and the time on the right; what waits for you has its answer under it.
    const square = (row, fresh) => html`<span class="pgb-av" style=${`--av:${row.cwd ? folderColor(row.cwd) : "var(--accent)"}`}>${(row.title.trim()[0] ?? "P").toUpperCase()}${fresh && html`<i class="pgb-dot" data-part="pgb-unseen" aria-label=${t("Not read")}></i>`}</span>`;
    const badge = (row) =>
        row.approval?.interview
            ? html`<button type="button" class="pgb-badge wait" data-part="board-answer" onClick=${() => openSheet({ type: "interview", conversationId: row.conversationId, callId: row.approval.interview.callId })}>${t("Answer")}</button>`
            : row.state === "waiting"
            ? html`<span class="pgb-badge wait">${row.approval?.simple ? t("Approve?") : t("waiting")}</span>`
            : row.state === "done"
            ? html`<span class="pgb-badge done">${t("done")}</span>`
            : row.state === "failed"
            ? html`<span class="pgb-badge fail">${t("failed")}</span>`
            : html`<span class="pgb-badge work">${t("working")}</span>`;
    const rowOf = (row) => {
        const unfolded = folds.includes(row.conversationId);

        const fresh = unseen(row);

        return html`<div class=${`pgb-item ${row.state}${fresh ? " unseen" : ""}`} key=${row.conversationId}>
            <div class="pgb-row" data-part="pgb-row" data-state=${row.state}>
                ${square(row, fresh)}
                <button
                    type="button"
                    class="pgb-text"
                    onClick=${() => {
                        if (fresh) {
                            markSeen(row.session);
                        }

                        open(row);
                    }}
                >
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
                        ${row.subagentsText}<${Icon} name=${unfolded ? "up" : "down"} size=${16} />
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
            counts.all > 0 &&
            html`<div class="pgb-tabs" role="group" aria-label=${t("Show")}>
                ${[
                    ["all", t("All"), counts.all],
                    ["waiting", t("Waiting"), counts.waiting],
                    ["working", t("Working"), counts.working],
                    ["done", t("Done"), counts.done],
                ].map(([key, label, n]) => html`<button type="button" class=${`pgb-tab ${filter === key ? "on" : ""}`} data-part=${`pgb-chip-${key}`} aria-pressed=${String(filter === key)} onClick=${() => pick(key)}>${label} <em>${n}</em></button>`)}
            </div>`
        }
        ${call != null ? html`<${VoiceChip} call=${call} chip=${false} open=${() => setBoardWhileVoice(false)} />` : voiceAvailable() && html`<${VoiceRow} problem=${problem} setProblem=${setProblem} />`}
        <div class="pgb-list">
            ${board !== null && counts.all === 0 && html`<div class="pgb-idle"><${PiMark} size=${28} /><p class="muted small pgb-empty">${t("Nothing runs now.")}</p></div>`}
            ${board !== null && counts.all > 0 && filter === "done" && counts.done === 0 && html`<p class="muted small pgb-empty">${t("Nothing finished in the last 24 hours.")}</p>`}
            ${section("waiting", t("Waits for you"))}
            ${shown("waiting").map(rowOf)}
            ${section("working", t("Working"))}
            ${shown("working").map(rowOf)}
            ${section("done", t("Done in the last 24 hours"))}
            ${shown("done").map(rowOf)}
        </div>
        <div class="pgb-foot">
            <span>${board === null || board.done === 0 ? "" : t("{n} done in the last hour", { n: board.done })}</span>
            <button type="button" class="pgb-link" onClick=${() => (bubble() ? bubble().openApp() : location.assign("/"))}>${t("Open pi-phone")}</button>
        </div>
    </div>`;
}
