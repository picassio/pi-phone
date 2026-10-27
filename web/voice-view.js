// The voice view (PP-189): a call with the session's Pi, full screen on a phone and a panel at the right on wide
// screens, as Pi's browser and computer panels are. Built from the assistant sheet's parts (the words heard, the wave,
// one loud button) and the panels' bar. The call itself is `voice-call.js`'s.
import { useEffect, useRef, useState } from "preact/hooks";
import { useBack } from "./back.js";
import { t } from "./i18n.js";
import { api, attempt, navigate, panelsBeside, store } from "./store.js";
import { html, Icon } from "./ui.js";
import { endVoice, hideVoice, sessionVoiceMode, setVoiceHold, setVoiceMode, setVoiceMuted, startVoice, voiceAvailable, voiceLevel, voicePress } from "./voice-call.js";

const BARS = 26;

/** The voice modes, as people choose them. */
export const VOICE_MODES = () => [
    ["work", t("Pi works")],
    ["chat", t("Chat only")],
    ["think", t("Pi thinks")],
];

/** Set a session's voice mode: for its next calls, and the call going on there now. */
export async function chooseVoiceMode(session, mode) {
    await api(`c/${session}/voice`, { mode });

    if (store.state.voiceCall?.session === session) {
        setVoiceMode(mode);
    }
}

/**
 * Home's Voice (PP-192): a new session in the default folder, named Voice, opened talking (its mode and turn-taking are
 * Settings › Voice's for new sessions: Pi works, hands-free unless changed).
 */
export async function startVoiceSession() {
    const cwd = store.state.server?.defaultCwd;
    const { id } = await api("sessions", { ...(cwd ? { cwd } : {}), title: t("Voice") });

    navigate(id);
    await startVoice(id);
}

/** Voice beside New (the session list, the desktop's home): a new session with a call. */
export function VoiceNewButton({ className = "new-button voice-new", size = 14 }) {
    if (!voiceAvailable()) {
        return null;
    }

    return html`<button
        class=${className}
        data-part="voice-new"
        title=${t("Voice: a new session, talking")}
        aria-label=${t("Voice: a new session, talking")}
        onClick=${() => attempt(startVoiceSession)}
    >
        <${Icon} name="voice" size=${size} /><span class="voice-label">${t("Voice")}</span>
    </button>`;
}

/** The message box's voice button: starts a call in this session, or shows the call going on. */
export function VoiceButton({ session }) {
    if (!voiceAvailable() || session === null) {
        return null;
    }

    const call = store.state.voiceCall;
    const here = call?.session === session;

    return html`<button
        type="button"
        class=${`icon-button composer-voice ${here ? "in-call" : ""}`}
        data-part="composer-button voice-button"
        aria-label=${here ? t("Voice call: show it") : t("Voice call")}
        title=${here ? t("Voice call: show it") : t("Voice call with Pi")}
        onMouseDown=${(event) => event.preventDefault()}
        onClick=${() => attempt(() => startVoice(session))}
    >
        <${Icon} name="voice" size=${17} />
    </button>`;
}

/** The wave: the voice's loudness while it speaks, yours while you talk; still bars when muted or waiting. */
function Wave({ speaking, quiet }) {
    const box = useRef(null);

    useEffect(() => {
        let frame = 0;
        let last = 0;
        const draw = (now) => {
            frame = requestAnimationFrame(draw);

            if (now - last < 80 || box.current === null) {
                return;
            }

            last = now;

            const level = voiceLevel();
            const value = quiet ? 0 : speaking ? level.out : level.mic;

            [...box.current.children].forEach((bar, index) => {
                const shape = 0.35 + 0.65 * Math.abs(Math.sin(index * 1.7 + 0.4));

                bar.style.height = `${quiet ? 4 : 4 + Math.round(26 * value * shape)}px`;
            });
        };

        frame = requestAnimationFrame(draw);

        return () => cancelAnimationFrame(frame);
    }, [speaking, quiet]);

    return html`<div class=${`assist-wave ${quiet ? "quiet" : ""} ${speaking ? "voice-speaking" : ""}`} ref=${box} aria-hidden="true">
        ${Array.from({ length: BARS }, () => html`<i style="height:4px"></i>`)}
    </div>`;
}

const clock = (ms) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));

    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** The session's last turns, quietly: your messages, Pi's words, and what was said in the call. */
function Recent() {
    const { view } = store.state;
    const rows = [];

    for (const id of view.order.slice(-12)) {
        const entry = view.entries.get(id);

        if (entry?.kind === "user") {
            rows.push({ key: id, who: t("You"), icon: "mic", text: entry.text.replace(/^\[voice\] /, "") });
        } else if (entry?.kind === "assistant") {
            const text = entry.blocks
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join(" ")
                .trim();

            if (text !== "") {
                rows.push({ key: id, who: "Pi", icon: "sparkle", text });
            }
        } else if (entry?.kind === "voice") {
            entry.turns.forEach((turn, index) =>
                rows.push({ key: `${id}:${index}`, who: turn.speaker === "you" ? t("You") : t("Voice"), icon: turn.speaker === "you" ? "mic" : "speaker", text: turn.text }),
            );
        }
    }

    const list = useRef(null);

    useEffect(() => {
        if (list.current) {
            list.current.scrollTop = list.current.scrollHeight;
        }
    });

    return html`<div class="voice-recent" ref=${list} data-part="voice-recent">
        ${rows.slice(-8).map(
            (row) => html`<div class="voice-line" key=${row.key}>
                <${Icon} name=${row.icon} size=${13} />
                <span><b>${row.who}</b> · ${row.text.length > 400 ? `${row.text.slice(0, 400)}…` : row.text}</span>
            </div>`,
        )}
        ${view.live.busy && html`<div class="voice-line voice-working"><span class="pb-spin" aria-hidden="true"></span><span>${t("Pi is working…")}</span></div>`}
    </div>`;
}

/** The voice view: full screen on a phone, a panel at the right on wide screens. */
export function VoicePanel({ leaving = false }) {
    const call = store.state.voiceCall;
    const beside = panelsBeside();
    const [modes, setModes] = useState(false);

    useBack(!beside && !leaving, hideVoice);

    if (call == null) {
        return null;
    }

    const { view } = store.state;
    const title = view.conversation?.title ?? t("New session");
    const mode = sessionVoiceMode(call.session);
    const modeName = VOICE_MODES().find(([value]) => value === mode)?.[1] ?? mode;

    return html`<section
        class=${`files-tile window pb-panel voice-panel ${leaving ? "leaving" : ""}`}
        data-part="voice-panel"
        data-state=${leaving ? "closing" : call.status}
        role=${beside ? undefined : "dialog"}
        aria-modal=${beside ? undefined : "true"}
        aria-label=${t("Voice call")}
        tabindex="-1"
        inert=${leaving}
    >
        <header class="files-bar pb-bar">
            ${
                !beside &&
                html`<button class="icon-button files-back" type="button" aria-label=${t("Back to the chat (the call goes on)")} onClick=${hideVoice}>
                    <${Icon} name="back" size=${22} />
                </button>`
            }
            <div class="pb-title">
                <b>${t("Voice")}</b>
                <span class="pb-url" title=${title}>${title}</span>
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
                <${Icon} name="down" size=${14} />
            </button>
            ${
                beside &&
                html`<button class="icon-button" type="button" aria-label=${t("Close the panel (the call goes on)")} title=${t("Close")} onClick=${hideVoice}>
                    <${Icon} name="close" size=${17} />
                </button>`
            }
        </header>
        ${modes && html`<${ModeChoice} session=${call.session} mode=${mode} onDone=${() => setModes(false)} />`}
        <${Recent} />
        <footer class="assist-foot voice-foot">
            <${CallControls}
                call=${call}
                onShow=${beside ? null : hideVoice}
                onType=${() => {
                    hideVoice();
                    setTimeout(() => document.querySelector(".composer textarea, [data-part=composer] textarea")?.focus());
                }}
            />
        </footer>
    </section>`;
}

/** The session's voice modes to pick from, with what the one chosen does. */
function ModeChoice({ session, mode, onDone }) {
    return html`<div class="assistant-choice voice-modes" data-part="voice-modes">
        <div class="segmented" role="group" aria-label=${t("Voice mode")}>
            ${VOICE_MODES().map(
                ([value, label]) => html`<button
                    class=${mode === value ? "on" : ""}
                    aria-pressed=${mode === value}
                    onClick=${() =>
                        attempt(async () => {
                            await chooseVoiceMode(session, value);
                            onDone();
                        })}
                >
                    ${label}
                </button>`,
            )}
        </div>
        <p class="muted small">
            ${mode === "work" ? t("The voice talks and hands real work to Pi, then speaks Pi's answer.") : mode === "chat" ? t("The voice only chats; Pi reads it with your next message.") : t("Pi thinks: what you say goes to Pi, and Pi's words are read out.")}
        </p>
    </div>`;
}

/**
 * A call's controls (the voice view's foot, and the assistant sheet's during a call, PP-192): what you say and what the
 * voice says, the wave, Mute (or End while holding to talk), End (or Hold to talk), Type instead, the status with the
 * time, and Hands-free / Hold to talk. `onShow`: where a pending approval is seen (null: here).
 */
export function CallControls({ call, onType, onShow = null }) {
    const [, tick] = useState(0);

    useEffect(() => {
        const timer = setInterval(() => tick((n) => n + 1), 1000);

        return () => clearInterval(timer);
    }, []);

    const { view } = store.state;
    const speaking = call.status === "speaking";
    const busy = view.live.busy;
    const quiet = call.muted || call.status === "connecting" || (call.hold && !call.pressing && !speaking);
    const status =
        call.status === "connecting"
            ? t("Connecting…")
            : call.muted
              ? t("Muted")
              : speaking
                ? t("Speaking · talk to interrupt")
                : call.hold
                  ? call.pressing
                      ? t("Listening · let go to send")
                      : t("Hold to talk")
                  : busy
                    ? t("Pi working · you can keep talking")
                    : t("Listening · speak any time");
    const words = speaking || (call.voice !== "" && call.you === "") ? call.voice : call.you;
    const who = speaking || (call.voice !== "" && call.you === "") ? `${t("Voice")} · ${call.model}` : t("You");
    const approvals = view.approvals?.length ?? 0;

    return html`
            ${
                approvals > 0 &&
                html`<div class="assist-notice" data-part="voice-approval">
                    <${Icon} name="shield" size=${18} />
                    <div><b>${t("Pi needs your OK")}</b><p>${t("Approvals need a tap: see the card in the chat.")}</p></div>
                    ${onShow && html`<button class="button small" onClick=${onShow}>${t("Show")}</button>`}
                </div>`
            }
            <div class="assist-words small" data-part="voice-words">
                <span class="assist-sub voice-who">${who}</span>
                ${words === "" ? html`<span class="assist-hint">${call.status === "connecting" ? t("Connecting…") : t("Listening…")}</span>` : words}
            </div>
            <${Wave} speaking=${speaking} quiet=${quiet} />
            <div class="assist-controls">
                ${
                    call.hold
                        ? html`<button class="icon-button voice-end-small" aria-label=${t("End the call")} title=${t("End the call")} data-part="voice-end" onClick=${() => attempt(() => endVoice())}>
                              <${Icon} name="close" size=${20} />
                          </button>`
                        : html`<button
                              class=${`icon-button voice-ctl ${call.muted ? "on" : ""}`}
                              aria-pressed=${call.muted}
                              aria-label=${call.muted ? t("Unmute") : t("Mute")}
                              title=${call.muted ? t("Unmute") : t("Mute")}
                              data-part="voice-mute"
                              onClick=${() => setVoiceMuted(!call.muted)}
                          >
                              <${Icon} name=${call.muted ? "micoff" : "mic"} size=${20} />
                          </button>`
                }
                ${
                    call.hold
                        ? html`<button
                              class=${`assist-big ${call.pressing ? "listening" : ""}`}
                              aria-label=${t("Hold to talk")}
                              data-part="voice-hold"
                              onPointerDown=${(event) => {
                                  try {
                                      event.currentTarget.setPointerCapture(event.pointerId);
                                  } catch {
                                      // A pointer the browser does not track (a synthetic one): nothing to capture.
                                  }

                                  voicePress(true);
                              }}
                              onPointerUp=${() => voicePress(false)}
                              onPointerCancel=${() => voicePress(false)}
                              onContextMenu=${(event) => event.preventDefault()}
                          >
                              <${Icon} name="mic" size=${24} />
                          </button>`
                        : html`<button class="assist-big voice-end" aria-label=${t("End the call")} data-part="voice-end" onClick=${() => attempt(() => endVoice())}>
                              <${Icon} name="close" size=${24} />
                          </button>`
                }
                <button class="icon-button" aria-label=${t("Type instead")} title=${t("Type instead")} data-part="voice-type" onClick=${onType}>
                    <${Icon} name="keyboard" size=${20} />
                </button>
            </div>
            <div class="assist-sub" data-part="voice-status">${status} · ${clock(Date.now() - call.startedAt)}</div>
            <div class="assistant-choice voice-turns">
                <div class="segmented" role="group" aria-label=${t("Turn-taking")}>
                    <button class=${call.hold ? "" : "on"} aria-pressed=${!call.hold} onClick=${() => setVoiceHold(false)}>${t("Hands-free")}</button>
                    <button class=${call.hold ? "on" : ""} aria-pressed=${call.hold} onClick=${() => setVoiceHold(true)}>${t("Hold to talk")}</button>
                </div>
            </div>`;
}

/** The session's voice mode in the model chip's menu (PP-189): Pi works, Chat only, Pi thinks. */
export function VoiceModeRow({ session }) {
    if (!voiceAvailable() || session === null) {
        return null;
    }

    const mode = sessionVoiceMode(session);

    return html`<div class="pop-menu-foot" data-part="voice-mode-row">
        <div class="label">${t("Voice")}</div>
        <div class="segmented model-levels" role="radiogroup" aria-label=${t("Voice mode")}>
            ${VOICE_MODES().map(
                ([value, label]) => html`<button
                    role="radio"
                    aria-checked=${mode === value ? "true" : "false"}
                    class=${mode === value ? "on" : ""}
                    onClick=${() => attempt(() => chooseVoiceMode(session, value))}
                >
                    ${label}
                </button>`,
            )}
        </div>
    </div>`;
}
