// A voice call with the session's Pi (PP-185, PP-189): the page's side, which holds only the media. The server sets the
// call up (`POST /api/c/:id/voice/call`): with a short-lived key the page posts its own SDP offer to OpenAI and names
// the call to the server, which joins it and does the rest (`src/server/voice-bridge.ts`); otherwise the server posts
// the offer. The page never has the sign-in's token. One call at a time, in the whole app; it goes on while the page
// shows another session, and ends with End, OpenAI ending it, or the page going.
//
// What the view shows comes from the call's data channel (`oai-events`): the words heard and spoken, and whether the
// voice speaks. Codex's own voice has no server connection to the call: its events go to the server and the server's
// come back as `voice` events, onto the channel.
import { t } from "./i18n.js";
import { api, navigate, notify, onVoiceEvents, store } from "./store.js";

/** The call now: its peer, microphone, data channel and player. Null when there is none. */
let engine = null;

/**
 * The Android app (PP-191): the page tells its window (`PiPhoneApp.voiceCall`) when a call starts, changes and ends, so
 * the call's notification (Mute, End) and the phone's audio follow; the notification's buttons come back as
 * `__piVoiceAction("mute" | "end")`. With the call go Settings › Voice's mute key and proximity (PP-201): the window
 * listens for a headset's button or the volume keys (`"mic"`) and the proximity sensor (`"ear"`, `"away"`) while the
 * call runs. In a browser there is no window to tell.
 */
function tellShell(state, extra = {}) {
    const shell = globalThis.PiPhoneApp;
    const call = store.state.voiceCall;

    if (typeof shell?.voiceCall !== "function" || (call == null && state !== "end")) {
        return;
    }

    const session = call?.session ?? extra.session ?? -1;
    const title = store.state.sessions.find((each) => each.id === session)?.title ?? "";
    const settings = store.state.server?.voice?.settings;
    const keys = state === "end" ? {} : { muteKey: settings?.muteKey ?? "headset", proximity: settings?.proximityMute === true };

    shell.voiceCall(JSON.stringify({ state, session, title, muted: call?.muted === true, ...keys, ...extra }));
}

globalThis.__piVoiceAction = (action) => {
    if (action === "mute") {
        toggleMic("notification");
    } else if (action === "mic") {
        toggleMic("key");
    } else if (action === "ear" || action === "away") {
        nearEar(action === "ear");
    } else if (action === "no-proximity") {
        notify("error", t("This phone has no proximity sensor: turn off Mute unless the phone is at your ear in Settings › Voice."));
    } else if (action === "end") {
        void endVoice();
    }
};

/** The assistant's sheet goes (PP-192): its call ends here, and the app's window starts it again in the same session. */
globalThis.__piVoiceHandOver = () => endVoice({ quiet: true, handOver: true });

/** From the app's window (`VoicePage.fromShell`): start a call in a session, or show the one going on. */
export async function voiceFromShell(session, what) {
    if (store.state.conversationId !== session) {
        navigate(session);
    }

    if (what === "start") {
        await startVoice(session);
    } else if (store.state.voiceCall?.session === session) {
        store.set({ voiceOpen: true });
    }
}

/** The browser can make a call: WebRTC and a microphone (a page browsers give one to: https, or this machine). */
export const voiceSupported = () =>
    typeof globalThis.RTCPeerConnection === "function" && typeof navigator.mediaDevices?.getUserMedia === "function" && globalThis.isSecureContext !== false;

/** Voice is offered here: the owner's (it runs on the owner's ChatGPT sign-in), on a server that has it, in a browser that can. */
export const voiceAvailable = (state = store.state) => state.me?.role === "owner" && state.server?.voice != null && voiceSupported();

/** The call's mode as it started: the session's own, or Settings › Voice's. */
export function sessionVoiceMode(id, state = store.state) {
    return state.sessions.find((each) => each.id === id)?.voiceMode ?? state.server?.voice?.settings.mode ?? "work";
}

function setCall(patch) {
    store.set((state) => (state.voiceCall === null || state.voiceCall === undefined ? {} : { voiceCall: { ...state.voiceCall, ...(typeof patch === "function" ? patch(state.voiceCall) : patch) } }));
}

/** The loudness of the microphone and of the voice, 0 to 1, for the wave. */
export function voiceLevel() {
    if (engine === null) {
        return { mic: 0, out: 0 };
    }

    const level = (analyser) => {
        if (!analyser) {
            return 0;
        }

        const data = new Uint8Array(analyser.fftSize);

        analyser.getByteTimeDomainData(data);

        let peak = 0;

        for (const value of data) {
            peak = Math.max(peak, Math.abs(value - 128));
        }

        return Math.min(1, peak / 64);
    };

    return { mic: engine.muted ? 0 : level(engine.micLevel), out: level(engine.outLevel) };
}

function analyser(stream) {
    try {
        engine.audioContext ??= new AudioContext();

        const node = engine.audioContext.createAnalyser();

        node.fftSize = 512;
        engine.audioContext.createMediaStreamSource(stream).connect(node);

        return node;
    } catch {
        return null;
    }
}

/** Start a call in a session and show the voice view. A call in another session ends first. */
export async function startVoice(session) {
    if (store.state.voiceCall?.session === session) {
        store.set({ voiceOpen: true });

        return;
    }

    if (store.state.voiceCall) {
        await endVoice();
    }

    const settings = store.state.server?.voice?.settings;
    const turns = settings?.turns ?? "hands-free";
    const hold = turns === "hold";

    // "Pi thinks" read out by the device's own voice (PP-193): a device without one does not start the call.
    if (sessionVoiceMode(session) === "think" && settings?.reader === "device" && deviceVoice() === null) {
        notify("error", t("This device has no voice to read Pi's answers: pick the live model as the reader in Settings › Voice."));

        return;
    }

    store.set({
        voiceOpen: true,
        // Tap to talk begins with the mic open for the first turn: starting the call was the tap.
        voiceCall: {
            session,
            status: "connecting",
            muted: hold,
            mutedBy: firstBy(turns),
            turns,
            hold,
            pressing: false,
            you: "",
            voice: "",
            startedAt: Date.now(),
            model: settings?.model ?? "",
            mode: sessionVoiceMode(session),
        },
    });

    // The mic's state is there from the first moment: a key or the sensor may change it while the call is set up.
    const mine = { turns, muted: hold, mutedBy: firstBy(turns), pressing: false };
    // Ended (or another call started) while this one was being set up: what it made so far goes.
    const stale = () => {
        if (engine !== mine) {
            throw STALE;
        }
    };

    engine = mine;

    try {
        const start = await api(`c/${session}/voice/call`, {});

        mine.call = start.call;
        stale();
        mine.path = start.path;
        mine.session = session;
        mine.mode = sessionVoiceMode(session);
        mine.micLevel = null;
        mine.outLevel = null;
        mine.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        stale();

        // What the mic is now (muted during the set-up, by the sensor, stays so).
        mine.mic.getAudioTracks().forEach((track) => (track.enabled = !mine.muted));
        mine.micLevel = analyser(mine.mic);

        const pc = new RTCPeerConnection();

        mine.pc = pc;
        mine.audio = new Audio();
        mine.audio.autoplay = true;
        pc.ontrack = (event) => {
            mine.audio.srcObject = event.streams[0];
            mine.outLevel = analyser(event.streams[0]);
        };
        mine.mic.getTracks().forEach((track) => pc.addTrack(track, mine.mic));
        mine.channel = pc.createDataChannel("oai-events");
        mine.channel.onmessage = (event) => {
            try {
                receive(mine, JSON.parse(event.data));
            } catch {
                // Not JSON: nothing for the view.
            }
        };
        pc.onconnectionstatechange = () => {
            if (engine === mine && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
                void dropped(mine);
            }
        };

        // The server's word for this call: Pi's words to read out (`say`, "Pi thinks" with the device's voice), and for
        // Codex's voice its data channel events.
        mine.outbox = [];
        mine.reading = [];
        mine.stopRelay = onVoiceEvents((data) => {
            if (data.call !== mine.call || engine !== mine) {
                return;
            }

            if (typeof data.say === "string") {
                readOut(mine, data.say);
            }

            if (mine.path === "codex" && mine.channel?.readyState === "open") {
                for (const event of data.events ?? []) {
                    mine.channel.send(JSON.stringify(event));
                }
            }
        });

        await pc.setLocalDescription(await pc.createOffer());
        stale();

        if (mine.path === "key") {
            // The key is for this offer only, and goes with it: it is not kept.
            const posted = await fetch(start.url, {
                method: "POST",
                headers: { authorization: `Bearer ${start.key}`, "content-type": "application/sdp" },
                body: pc.localDescription.sdp,
            });

            if (!posted.ok) {
                throw new Error(t("OpenAI did not take the call ({status}).", { status: posted.status }));
            }

            const answer = await posted.text();
            const rtc = (posted.headers.get("location") ?? "").split("/").pop();

            stale();
            await pc.setRemoteDescription({ type: "answer", sdp: answer });
            await api(`voice/calls/${mine.call}/joined`, { rtc });
        } else {
            const { sdp } = await api(`voice/calls/${mine.call}/sdp`, { sdp: pc.localDescription.sdp });

            stale();
            await pc.setRemoteDescription({ type: "answer", sdp });
        }

        if (engine === mine) {
            mine.joined = true;
            setCall({ call: mine.call, path: mine.path, model: start.model, status: micStatus(mine), startedAt: Date.now() });
            tellShell("start");
            // The server knows the mic from the start (it may have been muted while the call was set up).
            tellServer(mine);
        }
    } catch (error) {
        if (error === STALE) {
            mine.pc?.close();
            mine.mic?.getTracks().forEach((track) => track.stop());

            if (mine.call && !mine.endSent) {
                mine.endSent = true;
                await api(`voice/calls/${mine.call}/end`, {}).catch(() => {});
            }

            return;
        }

        if (engine === mine) {
            await endVoice({ quiet: true });
            notify("error", t("The call did not start: {why}", { why: error?.message ?? String(error) }));
        }
    }
}

/** Who set the mic as a call begins: hold to talk (closed), tap to talk (open for the first turn), or you (hands-free, open). */
const firstBy = (turns) => (turns === "hold" ? "hold" : turns === "tap" ? "tap" : "you");

/** A call set up no further: it ended, or another started. */
const STALE = new Error("stale call");

/**
 * The device's own voice (PP-193): "app" (Android's text-to-speech, through the app's window or sheet), "browser" (the
 * browser's speech synthesis), or null where there is none.
 */
export function deviceVoice() {
    const shell = globalThis.PiPhoneApp;

    if (typeof shell?.speak === "function" && typeof shell.speakAvailable === "function") {
        return shell.speakAvailable() ? "app" : null;
    }

    return typeof globalThis.speechSynthesis?.speak === "function" && typeof globalThis.SpeechSynthesisUtterance === "function" ? "browser" : null;
}

/** The language the device reads in: Settings › Voice's, or the device's own for auto. */
function readingLanguage() {
    const language = store.state.server?.voice?.settings?.language;

    return language && language !== "auto" ? language : "";
}

let readings = 0;

/** Pi's words to read out with the device's voice, after what is being read. */
function readOut(mine, text) {
    mine.reading.push(text);

    if (mine.reading.length === 1) {
        readNext(mine);
    }
}

/** Read the first of what waits; when it is done, the next; when nothing waits, the call listens again. */
function readNext(mine) {
    const text = mine.reading[0];

    if (text === undefined || engine !== mine) {
        setCall((call) => (call.status === "speaking" ? { status: micStatus(mine) } : {}));

        if (engine === mine) {
            armQuiet(mine);
        }

        return;
    }

    const done = () => {
        if (mine.reading[0] === text) {
            mine.reading.shift();
            readNext(mine);
        }
    };

    setCall({ status: "speaking", voice: text, you: "" });

    if (deviceVoice() === "app") {
        const id = `pi-${++readings}`;

        mine.spoken = (event) => {
            if (event?.id === id && (event.state === "done" || event.state === "error")) {
                done();
            }
        };
        globalThis.PiPhoneApp.speak(id, text, readingLanguage());

        return;
    }

    const utterance = new globalThis.SpeechSynthesisUtterance(text);

    utterance.lang = readingLanguage();
    utterance.onend = done;
    utterance.onerror = done;
    globalThis.speechSynthesis.speak(utterance);
}

/** Stop reading, and drop what waits (the owner talks, holds to talk, or the call ends). */
function stopReading(mine) {
    if (!mine?.reading?.length) {
        return;
    }

    mine.reading.length = 0;
    mine.spoken = undefined;

    if (deviceVoice() === "app") {
        globalThis.PiPhoneApp.stopSpeaking?.();
    } else {
        globalThis.speechSynthesis?.cancel();
    }
}

/** The app's text-to-speech says how a reading went: `{ id, state: "start" | "done" | "error" }`. */
globalThis.__piPhoneSpoken = (event) => engine?.spoken?.(event);

/** An event from the call: what the view shows; for Codex's voice, passed on to the server too. */
function receive(mine, event) {
    if (engine !== mine) {
        return;
    }

    if (mine.path === "codex") {
        mine.outbox.push(event);
        mine.flush ??= setTimeout(() => {
            const events = mine.outbox.splice(0);

            mine.flush = undefined;
            void api(`voice/calls/${mine.call}/events`, { events }).catch(() => {});
        }, 150);
    }

    switch (event.type) {
        case "input_audio_buffer.speech_started":
            // Talking over the device's voice stops it, as talking over the live model's does.
            stopReading(mine);
            disarmQuiet(mine);
            setCall({ status: "listening", you: "", voice: "" });
            break;
        case "input_audio_buffer.speech_stopped":
        case "input_audio_buffer.committed":
            // Tap to talk: the model heard your turn end; the mic closes until the next tap, so who talks near you
            // after it is not heard.
            if (mine.turns === "tap" && !mine.muted) {
                setMic(mine, true, "tap");
            }

            break;
        case "conversation.item.input_audio_transcription.delta":
            setCall((call) => ({ you: `${call.you}${event.delta ?? ""}` }));
            break;
        case "conversation.item.input_audio_transcription.completed":
        case "input_transcript.added":
            setCall({ you: String(event.transcript ?? event.item?.text ?? "") });
            break;
        case "response.created":
            disarmQuiet(mine);
            setCall({ voice: "" });
            break;
        case "response.output_audio_transcript.delta":
            setCall((call) => ({ voice: `${call.voice}${event.delta ?? ""}`, status: "speaking" }));
            break;
        case "output_transcript.added":
            setCall({ voice: String(event.item?.text ?? ""), status: "speaking" });
            break;
        case "output_audio_buffer.started":
            disarmQuiet(mine);
            setCall({ status: "speaking" });
            break;
        case "output_audio_buffer.stopped":
        case "response.done":
        case "turn.done":
            // The voice finished answering: hands-free's quiet starts counting (again, when its audio ends later).
            setCall({ status: micStatus(mine) });
            armQuiet(mine);
            break;
        case "error":
            notify("error", t("Voice: {why}", { why: event.error?.message ?? event.message ?? t("an error") }));
            break;
        default:
            break;
    }
}

/** The call went without End: a long one (OpenAI ends a call after about an hour) starts again, with the session's context. */
async function dropped(mine) {
    const long = Date.now() - (store.state.voiceCall?.startedAt ?? Date.now()) > 50 * 60_000;
    const session = mine.session;

    await endVoice({ quiet: true });

    if (long) {
        notify("info", t("The call reached its time limit: starting it again."));
        await startVoice(session);
    } else {
        notify("info", t("The call ended."));
    }
}

/**
 * End the call: the server counts its minutes; the view closes. `handOver`: the app's window takes the call on (the
 * assistant's sheet went), so its notification stays.
 */
export async function endVoice({ quiet = false, handOver = false } = {}) {
    const mine = engine;
    const session = store.state.voiceCall?.session;

    engine = null;

    if (mine !== null && mine.call) {
        tellShell("end", { session, ...(handOver ? { handOver: true } : {}) });
    }

    store.set({ voiceCall: null, voiceOpen: false });

    if (mine === null) {
        return;
    }

    clearTimeout(mine.flush);
    disarmQuiet(mine);
    stopReading(mine);
    mine.stopRelay?.();
    mine.channel?.close();
    mine.pc?.close();
    mine.mic?.getTracks().forEach((track) => track.stop());

    if (mine.audio) {
        mine.audio.srcObject = null;
    }

    void mine.audioContext?.close().catch(() => {});

    if (mine.call && !mine.endSent) {
        mine.endSent = true;
        await api(`voice/calls/${mine.call}/end`, {}).catch((error) => quiet || notify("error", error.message));
    }
}

/** The session's voice mode changed during the call: the server changes the call's (`voice-bridge.ts`); hold to talk follows. */
export function setVoiceMode(mode) {
    if (engine !== null) {
        engine.mode = mode;
    }

    setCall({ mode });
}

/** The call's status for its mic: hold to talk waits for a press; a muted mic says so; else it listens. */
function micStatus(mine) {
    return mine.turns === "hold" ? (mine.pressing ? "listening" : "holding") : mine.muted ? "muted" : "listening";
}

/** The server's copy of the mic (PP-201): one word after another, in order, once the call is up. */
function tellServer(mine) {
    if (!mine.joined || !mine.call || mine.endSent) {
        return;
    }

    const word = { muted: mine.muted, by: mine.mutedBy ?? "you", turns: mine.turns };

    mine.micSent = (mine.micSent ?? Promise.resolve()).then(() => api(`voice/calls/${mine.call}/mic`, word).catch(() => {}));
}

/**
 * Turn the call's mic off or on (PP-201), and say so everywhere: the track (off: nothing is sent), the view, the
 * notification, and the server. `by`: who did it (you, tap, auto, proximity, key, notification, hold).
 */
function setMic(mine, muted, by) {
    if (mine === null) {
        return;
    }

    mine.muted = muted;
    mine.mutedBy = by;
    mine.mic?.getAudioTracks().forEach((track) => (track.enabled = !muted));

    if (muted) {
        disarmQuiet(mine);
    } else {
        armQuiet(mine);
    }

    setCall((call) => ({ muted, mutedBy: by, status: call.status === "speaking" || call.status === "connecting" ? call.status : micStatus(mine) }));
    tellShell("update");
    tellServer(mine);
}

/**
 * Hands-free's quiet (Settings › Voice's `autoMuteSeconds`, PP-201): once the voice has answered (or the mic was turned
 * on), so many seconds with nothing said mute the mic. Talking, or the voice speaking again, stops the count.
 */
function armQuiet(mine) {
    disarmQuiet(mine);

    const seconds = Number(store.state.server?.voice?.settings?.autoMuteSeconds ?? 0);

    if (engine !== mine || mine.turns !== "hands-free" || mine.muted || !(seconds > 0)) {
        return;
    }

    mine.quiet = setTimeout(() => {
        mine.quiet = undefined;

        if (engine !== mine || mine.muted) {
            return;
        }

        // The voice still plays what it said: count again from its end.
        if (store.state.voiceCall?.status === "speaking") {
            armQuiet(mine);

            return;
        }

        setMic(mine, true, "auto");
    }, seconds * 1000);
}

function disarmQuiet(mine) {
    clearTimeout(mine?.quiet);

    if (mine) {
        mine.quiet = undefined;
    }
}

/** Mute or unmute the microphone (the Mute button): the call stays up, sending nothing. */
export function setVoiceMuted(muted, by = "you") {
    if (engine === null) {
        setCall({ muted, mutedBy: by, status: muted ? "muted" : "listening" });

        return;
    }

    setMic(engine, muted, by);
}

/**
 * A key or the notification's Mute (PP-201): the mic off if it is on, on if it is off. Tap to talk: a tap. Hold to
 * talk: the first press opens the mic as holding the button does, the next sends what you said.
 */
export function toggleMic(by) {
    const mine = engine;

    if (mine === null) {
        return;
    }

    if (mine.turns === "hold") {
        voicePress(!mine.pressing, by);

        return;
    }

    if (mine.muted) {
        stopReading(mine);
    }

    setMic(mine, !mine.muted, by);
}

/**
 * The phone's proximity sensor (Settings › Voice's `proximityMute`, PP-201; the rule is the Android window's: at the ear
 * is the sensor near and the phone not face down). Away mutes the mic; back at the ear turns it on again only when the
 * sensor muted it, never a mic you or tap to talk muted. Hold to talk opens the mic only while held: the sensor leaves it.
 */
function nearEar(near) {
    const mine = engine;

    if (mine === null || mine.turns === "hold") {
        return;
    }

    if (!near && !mine.muted) {
        setMic(mine, true, "proximity");
    } else if (near && mine.muted && mine.mutedBy === "proximity") {
        setMic(mine, false, "proximity");
    }
}

/**
 * How the call hears, as the server set it (`callSession`, `src/server/voice.ts`, PP-195): Settings › Voice's noise
 * reduction, and hands-free's eagerness, or no turn detection to hold to talk. A page's update carries both, so it never
 * drops the noise reduction.
 */
export function callInput(hold, mode, settings = store.state.server?.voice?.settings) {
    const noise = settings?.noise ?? "near_field";

    return {
        noise_reduction: noise === "off" ? null : { type: noise },
        turn_detection: hold
            ? null
            : { type: "semantic_vad", eagerness: settings?.eagerness ?? "auto", interrupt_response: true, create_response: mode !== "think" },
    };
}

/**
 * How you take turns in this call (PP-201): hands-free (the mic stays open; the voice answers when you pause, and stops
 * when you talk), tap (the mic opens with a tap and closes when your turn ends: it starts closed, waiting for the tap),
 * or hold to talk. The model's turn detection follows (none to hold), always with the mic's noise reduction.
 */
export function setVoiceTurns(turns) {
    const mine = engine;
    const hold = turns === "hold";

    if (mine?.channel?.readyState === "open" && mine.path !== "codex") {
        mine.channel.send(JSON.stringify({ type: "session.update", session: { type: "realtime", audio: { input: callInput(hold, mine.mode) } } }));
    }

    setCall({ turns, hold, pressing: false });

    if (mine === null) {
        return;
    }

    mine.turns = turns;
    mine.pressing = false;
    setMic(mine, turns !== "hands-free", turns === "hold" ? "hold" : turns === "tap" ? "tap" : "you");
}

/** Hold to talk or hands-free, as the call's first turn-taking choice was (`setVoiceTurns`). */
export const setVoiceHold = (hold) => setVoiceTurns(hold ? "hold" : "hands-free");

/**
 * Hold to talk: pressing starts what you say; letting go sends it, and the voice answers (Pi does, in "Pi thinks").
 * `by`: hold (the button), key or notification (a press opens, the next sends).
 */
export function voicePress(down, by = "hold") {
    const mine = engine;

    if (!mine?.mic || mine.channel?.readyState !== "open" || mine.pressing === down) {
        return;
    }

    mine.pressing = down;

    if (down) {
        stopReading(mine);
        mine.channel.send(JSON.stringify({ type: "response.cancel" }));
        mine.channel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        setCall({ pressing: true, status: "listening", you: "" });
        setMic(mine, false, by);

        return;
    }

    mine.channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

    if (mine.mode !== "think") {
        mine.channel.send(JSON.stringify({ type: "response.create" }));
    }

    setCall({ pressing: false, status: "holding" });
    setMic(mine, true, by);
}

/** The voice view of the call shows now: asked for, and the call is this session's. */
export function voiceShown(state = store.state) {
    return state.voiceOpen === true && state.voiceCall != null && state.voiceCall.session === state.conversationId;
}

/** Hide the view; the call goes on (the message box's voice button shows it again). */
export function hideVoice() {
    store.set({ voiceOpen: false });
}
