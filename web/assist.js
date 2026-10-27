// The phone's assistant sheet (PP-146): holding the side key with pi-phone as the phone's digital assistant shows this
// page over the app in front, in a see-through window (`PiAssistantSession.java`, `/?assist=1`). It listens at once;
// the words show as they are heard (settled ones bright, ones still changing faint), then wait in a box for Send, or go
// by themselves after 3 seconds (Menu › Assistant). They go to the last session the owner was in, a new session, or
// one session, as set, or as picked from the session pill for this time only. The app that was in front is noted on
// the message ("From Chrome"), as a chip the person can drop. Once sent, the session's transcript shows in the sheet,
// approvals and all, so a phone control card is answered without leaving the app.
//
// Voice (PP-192): the sheet can start a voice call with the session's Pi instead (its waveform button, or by itself when
// Menu › Assistant says "Start a voice call"); the call's controls take the sheet's foot. When the sheet goes, the
// call moves to the app's window (`PiAssistantSession.onHide`, `__piVoiceHandOver`), its notification staying.
import { useEffect, useRef, useState } from "preact/hooks";
import { dictationLanguage } from "./android-speech.js";
import { t } from "./i18n.js";
import { actions, attempt, navigate, store } from "./store.js";
import { Transcript } from "./transcript.js";
import { html, Icon, shortPath } from "./ui.js";
import { endVoice, startVoice, voiceAvailable } from "./voice-call.js";
import { CallControls } from "./voice-view.js";

/** This page is the assistant's sheet, not the app. */
export const ASSIST = new URLSearchParams(location.search).has("assist");

/** The session the owner was last in on this phone: the sheet's "last session". The app's window keeps it. */
export const LAST_SESSION_KEY = "pi-phone.last-session";

/** Seconds before the words go by themselves, with "Send by itself". */
const AUTO_SECONDS = 3;
/** Bars in the sound wave. */
const BARS = 28;
/** The assistant's settings until the server's state says (`src/server/assistant.ts`). */
const DEFAULTS = { opens: "last", folder: null, session: null, send: "tap", from: true, talk: "dictate" };

/**
 * Open a session behind the sheet, keeping the sheet's address: a reload (the server's, after an update) must load the
 * sheet again, not the app.
 */
function openBehind(id) {
    navigate(id, { route: false });
}

/** In the app's window: keep the session the owner is in, for the sheet's "last session". */
export function rememberLastSession() {
    let last = null;

    store.subscribe((state) => {
        const id = state.conversationId;

        if (id !== null && id !== last) {
            last = id;
            localStorage.setItem(LAST_SESSION_KEY, String(id));
        }
    });
}

/** The note a message starts with when it says the app in front; the server's prompt explains it to Pi. */
export const fromNote = (from) => `(From ${from.label} · ${from.package})`;

/**
 * Where the words go: `{ kind: "session", id, title }`, or `{ kind: "new", folder }`. `opens` is the setting (last, new,
 * session), or the person's pick for this time: one of those, or a session's number (from the picker's list).
 */
export function targetFor(opens, settings, state) {
    const sessions = state.sessions.filter((each) => !each.archived);
    const folder = settings.folder ?? state.server?.defaultCwd ?? null;
    const session = (id) => {
        const found = sessions.find((each) => each.id === id);

        return found ? { kind: "session", id: found.id, title: found.title ?? t("New session") } : null;
    };

    if (opens === "new") {
        return { kind: "new", folder };
    }

    if (typeof opens === "number") {
        const one = session(opens);

        if (one) {
            return one;
        }
    }

    if (opens === "session" && settings.session !== null) {
        const one = session(settings.session);

        if (one) {
            return one;
        }
    }

    const kept = Number(localStorage.getItem(LAST_SESSION_KEY));
    const newest = [...sessions].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];

    return session(kept) ?? (newest ? session(newest.id) : { kind: "new", folder });
}

/** A recognizer's error (a Web Speech error name, or a message), as the sheet says it; `mic`: allowing it is the way. */
function problemOf(kind) {
    switch (kind) {
        case "no-speech":
            return { title: t("Didn't catch that"), text: t("Nothing came through. Speak a little closer, or type it.") };
        case "not-allowed":
            return { title: t("pi can't use the microphone yet"), text: t("Allow it once in pi-phone: Android asks there, not over other apps."), mic: true };
        case "unavailable":
        case "service-not-allowed":
            return { title: t("No speech recognizer"), text: t("This phone has none pi can use. Type instead.") };
        case "network":
            return { title: t("No network"), text: t("Speech recognition needs the network. Type instead, or try again.") };
        case "language-not-supported":
            return { title: t("Language not supported"), text: t("The recognizer can't hear your language. Pick another in Menu › Dictation.") };
        default:
            return { title: t("Dictation stopped"), text: kind };
    }
}

/** The sound wave: the voice's loudness (0 to 1) from Android while it listens; still bars where none comes. */
function Wave({ level, quiet }) {
    return html`<div class=${`assist-wave ${quiet ? "quiet" : ""}`} aria-hidden="true">
        ${Array.from({ length: BARS }, (_, index) => {
            // A fixed shape, so bars differ, scaled by the loudness.
            const shape = 0.35 + 0.65 * Math.abs(Math.sin(index * 1.7 + 0.4));
            const height = quiet ? 4 : 4 + Math.round(26 * level * shape);

            return html`<i style=${`height:${height}px`}></i>`;
        })}
    </div>`;
}

export function AssistView() {
    const state = store.state;
    const app = globalThis.PiPhoneApp;
    const settings = state.server?.assistant ?? DEFAULTS;
    /** "listen", "heard", "problem", or "idle" (closed, or between shows). */
    const [phase, setPhase] = useState("idle");
    const [words, setWords] = useState({ settled: "", coming: "" });
    const [text, setText] = useState("");
    const [problem, setProblem] = useState(null);
    const [level, setLevel] = useState(0);
    const [countdown, setCountdown] = useState(null);
    const [from, setFrom] = useState(null);
    const [fromOn, setFromOn] = useState(true);
    /** The person's pick for this time, from the session pill; null: the setting. */
    const [pick, setPick] = useState(null);
    /** The session picker is open (the pill), and what is typed in its search. */
    const [menu, setMenu] = useState(false);
    const [query, setQuery] = useState("");
    /** The session a message went to from this showing: its transcript takes the body, and more goes there too. */
    const [sentTo, setSentTo] = useState(null);
    const sent = sentTo !== null;
    const [sending, setSending] = useState(false);
    const recognition = useRef(null);
    const box = useRef(null);
    const pill = useRef(null);
    const timer = useRef(null);
    /** Words just heard wait for the countdown ("Send by itself") to start. */
    const armed = useRef(false);
    /** The sheet opened to start a voice call: it does once the session to call is known. */
    const wantCall = useRef(false);
    const target = sent
        ? { kind: "session", id: sentTo, title: state.sessions.find((each) => each.id === sentTo)?.title ?? t("New session") }
        : state.sessionsLoaded
          ? targetFor(pick ?? settings.opens, settings, state)
          : null;
    const targetId = target?.kind === "session" ? target.id : null;

    const stopCountdown = () => {
        clearInterval(timer.current);
        timer.current = null;
        setCountdown(null);
    };

    /** `how`: "auto" when the sheet opens (with "Start a voice call", a call instead), else a button's tap. */
    const listen = (how) => {
        armed.current = false;
        recognition.current?.abort();
        stopCountdown();
        setProblem(null);
        setWords({ settled: "", coming: "" });
        setLevel(0);

        if (how === "auto" && store.state.server?.assistant?.talk === "call" && voiceAvailable()) {
            recognition.current = null;
            wantCall.current = true;
            setPhase("idle");

            return;
        }

        // The settings not here yet: it listens, and calls instead once they say so (the effect below).
        if (how === "auto" && store.state.server == null) {
            wantCall.current = "maybe";
        }

        const Recognition = globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition;

        if (typeof Recognition !== "function") {
            setProblem("unavailable");
            setPhase("problem");

            return;
        }

        if (typeof app?.micAllowed === "function" && !app.micAllowed()) {
            setProblem("not-allowed");
            setPhase("problem");

            return;
        }

        const heard = new Recognition();
        let settled = "";
        let coming = "";
        let failure = null;

        heard.lang = dictationLanguage();
        heard.continuous = false;
        heard.interimResults = true;
        heard.onresult = (event) => {
            const results = [...event.results];

            settled = results.filter((each) => each.isFinal).map((each) => each[0].transcript.trim()).filter(Boolean).join(" ");
            coming = results.filter((each) => !each.isFinal).map((each) => each[0].transcript.trim()).filter(Boolean).join(" ");
            setWords({ settled, coming });
        };
        heard.onerror = (event) => {
            if (event.error !== "aborted") {
                failure = event.error;
            }
        };
        heard.onend = () => {
            if (recognition.current !== heard) {
                return;
            }

            recognition.current = null;
            setLevel(0);

            const said = [settled, coming].filter(Boolean).join(" ").trim();

            if (said === "") {
                setProblem(failure ?? "no-speech");
                setPhase("problem");

                return;
            }

            const capital = said[0].toUpperCase() + said.slice(1);

            setText(capital);
            setPhase("heard");
            // "Send by itself" counts down once the settings and the session are known (below).
            armed.current = true;
        };
        recognition.current = heard;
        setPhase("listen");

        try {
            heard.start();
        } catch (error) {
            recognition.current = null;
            setProblem(String(error.message ?? error));
            setPhase("problem");
        }
    };

    const send = async (said) => {
        const words = said.trim();

        stopCountdown();

        if (words === "" || sending || target === null) {
            return;
        }

        setSending(true);

        let to = target.kind === "session" ? target.id : null;
        const ok = await attempt(async () => {
            if (to === null) {
                to = (await actions.createSession(target.folder)).id;
                localStorage.setItem(LAST_SESSION_KEY, String(to));
            }

            if (store.state.conversationId !== to) {
                openBehind(to);
            }

            // The app in front is said once, with the first message of this showing.
            const message = from && fromOn && settings.from !== false && !sent ? `${fromNote(from)}\n${words}` : words;

            await actions.submit(message, [], store.state.view.live?.busy ? "steer" : "followUp");

            return true;
        });

        setSending(false);

        if (ok) {
            setSentTo(to);
            setText("");
            setPhase("idle");
        }
    };

    /**
     * A voice call with the target session's Pi (PP-192): a new session is made first; the session opens behind the
     * sheet, so its transcript shows above the call's controls. The sheet cannot ask for the microphone: without it, the
     * sheet sends the person to pi-phone to allow it, as dictation does.
     */
    const startCall = () =>
        attempt(async () => {
            if (typeof app?.micAllowed === "function" && !app.micAllowed()) {
                setProblem("not-allowed");
                setPhase("problem");

                return;
            }

            // The session to call is not known yet (the list is on its way): the call starts once it is.
            if (target === null) {
                wantCall.current = true;

                return;
            }

            recognition.current?.abort();
            recognition.current = null;
            stopCountdown();

            let to = target.kind === "session" ? target.id : null;

            if (to === null) {
                to = (await actions.createSession(target.folder)).id;
                localStorage.setItem(LAST_SESSION_KEY, String(to));
            }

            if (store.state.conversationId !== to) {
                openBehind(to);
            }

            setSentTo(to);
            setPhase("idle");
            await startVoice(to);
        });

    const startCountdown = (said) => {
        let left = AUTO_SECONDS;

        clearInterval(timer.current);
        setCountdown(left);
        timer.current = setInterval(() => {
            left -= 1;

            if (left > 0) {
                setCountdown(left);

                return;
            }

            stopCountdown();
            sendRef.current(said);
        }, 1000);
    };

    // The send in the countdown sees the newest target and text.
    const sendRef = useRef(send);

    sendRef.current = send;

    // A call the sheet opened for starts once the session to call is known (and the settings, when they came late).
    useEffect(() => {
        if (wantCall.current === false || target === null || state.server == null) {
            return;
        }

        const call = wantCall.current === true || (settings.talk === "call" && voiceAvailable());

        wantCall.current = false;

        if (call) {
            startCall();
        }
    });

    // Words just heard, with "Send by itself": the countdown starts once the server's settings and the session are here
    // (words can end before the page has them), once; editing first, or listening again, disarms it.
    useEffect(() => {
        if (phase === "heard" && armed.current && state.server !== null && target !== null) {
            armed.current = false;

            if (settings.send === "auto") {
                startCountdown(text);
            }
        }
    });

    const close = () => {
        recognition.current?.abort();
        stopCountdown();

        if (typeof app?.close === "function") {
            app.close();
        }
    };

    const open = () => {
        const id = store.state.conversationId ?? targetId;

        if (id === null) {
            return;
        }

        if (typeof app?.open === "function") {
            app.open(id);
        } else {
            location.href = `/s/${id}`;
        }
    };

    // The shell tells the page: the app in front (from the assist data), shown again, hidden.
    useEffect(() => {
        const told = typeof app?.from === "function" ? app.from() : "";

        if (told) {
            setFrom(JSON.parse(told));
        }

        globalThis.__piAssistFrom = (each) => setFrom(each);
        globalThis.__piAssistShown = () => {
            setSentTo(null);
            setPick(null);
            setMenu(false);
            setQuery("");
            setFromOn(true);
            setText("");
            listen("auto");
        };
        globalThis.__piAssistHidden = () => {
            recognition.current?.abort();
            recognition.current = null;
            stopCountdown();
            setFrom(null);
            setPhase("idle");
        };
        globalThis.__piPhoneSpeechLevel = (value) => setLevel(Number(value) || 0);
        listen("auto");

        return () => {
            recognition.current?.abort();
            stopCountdown();
            delete globalThis.__piAssistFrom;
            delete globalThis.__piAssistShown;
            delete globalThis.__piAssistHidden;
            delete globalThis.__piPhoneSpeechLevel;
        };
    }, []);

    // The target session opens behind the words, so its transcript is there once they are sent.
    useEffect(() => {
        if (targetId !== null && store.state.conversationId !== targetId) {
            openBehind(targetId);
        }
    }, [targetId]);

    // Escape closes the menu, then the sheet.
    useEffect(() => {
        const key = (event) => {
            if (event.key !== "Escape") {
                return;
            }

            if (menu) {
                setMenu(false);
                pill.current?.focus();
            } else {
                close();
            }
        };

        addEventListener("keydown", key);

        return () => removeEventListener("keydown", key);
    }, [menu]);

    if (state.me === null) {
        return html`<div class="assist" data-part="assist">
            <div class="assist-backdrop" onClick=${close}></div>
            <section class="assist-sheet" role="dialog" aria-label=${t("pi assistant")}>
                <div class="assist-notice"><b>${t("Sign in to pi-phone first")}</b></div>
                <div class="assist-foot"><button class="button primary" onClick=${open}>${t("Open pi-phone")}</button></div>
            </section>
        </div>`;
    }

    const home = state.server?.home;
    const choices = state.sessionsLoaded
        ? [
              { opens: "last", ...targetFor("last", { ...settings, opens: "last" }, state), hint: t("The last session") },
              { opens: "new", kind: "new", folder: settings.folder ?? state.server?.defaultCwd ?? null, hint: t("A new session") },
              ...(settings.session !== null ? [{ opens: "session", ...targetFor("session", settings, state), hint: t("Picked in Menu › Assistant") }] : []),
          ]
        : [];
    // Every session, newest first, for the picker; its search finds them by title or folder.
    const needle = query.trim().toLowerCase();
    const everyone = state.sessions
        .filter((each) => !each.archived)
        .filter((each) => needle === "" || `${each.title ?? ""} ${each.cwd ?? ""} #${each.id}`.toLowerCase().includes(needle))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const named = (each) => (each.kind === "new" ? t("New session") : each.title);
    const chosen = pick ?? settings.opens;
    const choose = (opens) => {
        setPick(opens);
        setMenu(false);
        setQuery("");
        pill.current?.focus();
    };
    // The target session's conversation, once it is open behind the sheet: its history shows above what is heard.
    const history = targetId !== null && targetId === state.conversationId && Boolean(state.view.conversation);
    const chip =
        from &&
        settings.from !== false &&
        html`<div class="assist-chips">
            <span class=${`chip assist-from ${fromOn ? "" : "off"}`} data-part="assist-from">
                <${Icon} name="phone" size=${13} />
                ${t("From {app}", { app: from.label })}
                <button
                    aria-label=${fromOn ? t("Don't say you're in {app}", { app: from.label }) : t("Say you're in {app}", { app: from.label })}
                    onClick=${() => setFromOn(!fromOn)}
                >
                    <${Icon} name=${fromOn ? "close" : "undo"} size=${12} />
                </button>
            </span>
        </div>`;
    const heardSoFar =
        words.settled === "" && words.coming === ""
            ? html`<span class="assist-hint">${t("Listening…")}</span>`
            : html`${words.settled} <span class="assist-coming">${words.coming}</span>`;
    const listening = phase === "listen";
    const said = problem === null ? null : problemOf(problem);
    // A voice call in this sheet (PP-192), and the button that starts one.
    const call = state.voiceCall;
    const callButton = voiceAvailable()
        ? html`<button class="icon-button" aria-label=${t("Voice call")} title=${t("Voice call with Pi")} data-part="assist-call" onClick=${startCall}>
              <${Icon} name="voice" size=${20} />
          </button>`
        : html`<span></span>`;

    return html`<div class="assist" data-part="assist">
        <div class="assist-backdrop" onClick=${close}></div>
        <section class=${`assist-sheet ${history || menu ? "talking" : ""}`} role="dialog" aria-label=${t("pi assistant")} data-part="assist-sheet">
            <div class="assist-grab" aria-hidden="true"></div>
            <header class="assist-head">
                <span class="assist-mark" aria-hidden="true">π</span>
                <button
                    class="assist-pill"
                    ref=${pill}
                    aria-haspopup="menu"
                    aria-expanded=${menu}
                    data-part="assist-target"
                    onClick=${() => setMenu(!menu)}
                    disabled=${target === null}
                >
                    <span class="assist-pill-name">${target === null ? t("Loading…") : named(target)}</span>
                    <small>${target?.kind === "new" ? shortPath(target.folder ?? "", home) : chosen === "last" ? t("last") : `#${target?.id ?? ""}`}</small>
                    <${Icon} name="down" size=${14} />
                </button>
                <span class="assist-space"></span>
                ${
                    (targetId !== null || sent) &&
                    html`<button class="icon-button" title=${t("Open in pi-phone")} aria-label=${t("Open in pi-phone")} onClick=${open}>
                        <${Icon} name="external" size=${18} />
                    </button>`
                }
                <button class="icon-button" title=${t("Close")} aria-label=${t("Close")} onClick=${close}>
                    <${Icon} name="close" size=${18} />
                </button>
            </header>
            <div class="assist-body" aria-live="polite">
                ${
                    menu
                        ? html`<div class="assist-picker" data-part="assist-menu">
                              <input
                                  type="search"
                                  class="assist-search"
                                  placeholder=${t("Find a session")}
                                  aria-label=${t("Find a session")}
                                  value=${query}
                                  onInput=${(event) => setQuery(event.currentTarget.value)}
                              />
                              <div class="assist-menu" role="listbox" aria-label=${t("Send to")}>
                                  ${
                                      needle === "" &&
                                      choices.map(
                                          (each) => html`<button role="option" aria-selected=${chosen === each.opens} onClick=${() => choose(each.opens)}>
                                              <b>${named(each)}</b>
                                              <small>${each.kind === "new" ? `${each.hint} · ${shortPath(each.folder ?? "", home)}` : each.hint}</small>
                                              ${chosen === each.opens && html`<${Icon} name="check" size=${14} />`}
                                          </button>`,
                                      )
                                  }
                                  <div class="assist-menu-title">${t("All sessions")}</div>
                                  ${everyone.length === 0 && html`<p>${t("No session matches.")}</p>`}
                                  ${everyone.map(
                                      (each) => html`<button role="option" aria-selected=${chosen === each.id} data-part="assist-session" onClick=${() => choose(each.id)}>
                                          <b>${each.title ?? t("New session")}</b>
                                          <small>#${each.id} · ${shortPath(each.cwd ?? "", home)}</small>
                                          ${chosen === each.id && html`<${Icon} name="check" size=${14} />`}
                                      </button>`,
                                  )}
                              </div>
                              <p class="assist-menu-note">${t("For this time only. The default is in Menu › Assistant.")}</p>
                          </div>`
                        : history
                          ? html`<${Transcript} key=${state.conversationId} />`
                          : listening &&
                            html`<div class="assist-words" data-part="assist-words">${heardSoFar}<span class="assist-caret"></span></div>`
                }
            </div>
            <footer class=${`assist-foot ${menu ? "hidden" : ""}`}>
                ${
                    phase === "problem" &&
                    html`<div class="assist-notice ${said.mic ? "error" : ""}" data-part="assist-problem">
                        <${Icon} name="mic" size=${18} />
                        <div><b>${said.title}</b><p>${said.text}</p></div>
                    </div>`
                }
                ${phase !== "idle" && chip}
                ${
                    listening &&
                    html`${history && html`<div class="assist-words small" data-part="assist-words">${heardSoFar}<span class="assist-caret"></span></div>`}
                        <${Wave} level=${level} quiet=${false} />
                        <div class="assist-controls">
                            <button class="icon-button" aria-label=${t("Type instead")} title=${t("Type instead")} onClick=${() => {
                                recognition.current?.abort();
                                recognition.current = null;
                                setText([words.settled, words.coming].filter(Boolean).join(" "));
                                setPhase("heard");
                                setTimeout(() => box.current?.focus());
                            }}>
                                <${Icon} name="keyboard" size=${20} />
                            </button>
                            <button class="assist-big listening" aria-label=${t("Stop listening")} data-part="assist-stop" onClick=${() => recognition.current?.stop()}>
                                <${Icon} name="stop" size=${24} />
                            </button>
                            ${callButton}
                        </div>
                        <div class="assist-sub">${t("Listening · speak, then pause")}</div>`
                }
                ${
                    phase === "heard" &&
                    html`<div class=${`assist-box ${countdown !== null ? "counting" : ""}`}>
                            <textarea
                                ref=${box}
                                rows="2"
                                aria-label=${t("Message")}
                                data-part="assist-text"
                                value=${text}
                                onInput=${(event) => {
                                    armed.current = false;
                                    stopCountdown();
                                    setText(event.currentTarget.value);
                                }}
                                onFocus=${() => {
                                    armed.current = false;
                                    stopCountdown();
                                }}
                            ></textarea>
                            <button
                                class="assist-send"
                                aria-label=${t("Send")}
                                data-part="assist-send"
                                disabled=${sending || text.trim() === "" || target === null}
                                onClick=${() => send(text)}
                            >
                                ${countdown !== null && html`<svg class="assist-ring" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="22" /></svg>`}
                                <${Icon} name="send" size=${18} />
                            </button>
                        </div>
                        ${
                            countdown !== null &&
                            html`<div class="assist-countdown" data-part="assist-countdown">
                                <span>${t("Sending in {n} s · tap the words to edit", { n: countdown })}</span>
                                <button class="button ghost small" onClick=${stopCountdown}>${t("Cancel")}</button>
                            </div>`
                        }
                        <div class="assist-row">
                            <button class="button ghost small" onClick=${listen}><${Icon} name="mic" size=${16} /> ${t("Say it again")}</button>
                        </div>`
                }
                ${
                    phase === "problem" &&
                    html`<div class="assist-controls">
                        <button class="icon-button" aria-label=${t("Type instead")} title=${t("Type instead")} onClick=${() => {
                            setPhase("heard");
                            setTimeout(() => box.current?.focus());
                        }}>
                            <${Icon} name="keyboard" size=${20} />
                        </button>
                        ${
                            said.mic && typeof app?.allowMic === "function"
                                ? html`<button class="button primary" onClick=${() => app.allowMic()}>${t("Allow in pi-phone")}</button>`
                                : html`<button class="assist-big" aria-label=${t("Listen again")} data-part="assist-again" onClick=${listen}><${Icon} name="mic" size=${24} /></button>`
                        }
                        ${said.mic ? html`<span></span>` : callButton}
                    </div>`
                }
                ${
                    call &&
                    html`<${CallControls}
                        call=${call}
                        onType=${() =>
                            attempt(async () => {
                                await endVoice();
                                setPhase("heard");
                                setTimeout(() => box.current?.focus());
                            })}
                    />`
                }
                ${
                    phase === "idle" &&
                    sent &&
                    !call &&
                    html`<div class="assist-row">
                        <button class="icon-button" aria-label=${t("Type instead")} title=${t("Type instead")} onClick=${() => {
                            setPhase("heard");
                            setTimeout(() => box.current?.focus());
                        }}>
                            <${Icon} name="keyboard" size=${20} />
                        </button>
                        <button class="button primary assist-more" data-part="assist-more" onClick=${listen}><${Icon} name="mic" size=${16} /> ${t("Ask more")}</button>
                        ${callButton}
                    </div>`
                }
            </footer>
        </section>
    </div>`;
}
