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
 * `__piVoiceAction("mute" | "end")`. In a browser there is no window to tell.
 */
function tellShell(state, extra = {}) {
    const shell = globalThis.PiPhoneApp;
    const call = store.state.voiceCall;

    if (typeof shell?.voiceCall !== "function" || (call == null && state !== "end")) {
        return;
    }

    const session = call?.session ?? extra.session ?? -1;
    const title = store.state.sessions.find((each) => each.id === session)?.title ?? "";

    shell.voiceCall(JSON.stringify({ state, session, title, muted: call?.muted === true, ...extra }));
}

globalThis.__piVoiceAction = (action) => {
    if (action === "mute") {
        setVoiceMuted(!(store.state.voiceCall?.muted === true));
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
    const hold = settings?.turns === "hold";

    store.set({
        voiceOpen: true,
        voiceCall: { session, status: "connecting", muted: false, hold, pressing: false, you: "", voice: "", startedAt: Date.now(), model: settings?.model ?? "", mode: sessionVoiceMode(session) },
    });

    const mine = {};

    engine = mine;

    try {
        const start = await api(`c/${session}/voice/call`, {});

        mine.call = start.call;
        mine.path = start.path;
        mine.session = session;
        mine.mode = sessionVoiceMode(session);
        mine.micLevel = null;
        mine.outLevel = null;
        mine.muted = hold;
        mine.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

        if (engine !== mine) {
            mine.mic.getTracks().forEach((track) => track.stop());

            return;
        }

        mine.mic.getAudioTracks().forEach((track) => (track.enabled = !hold));
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

        if (mine.path === "codex") {
            mine.outbox = [];
            mine.stopRelay = onVoiceEvents((data) => {
                if (data.call === mine.call && mine.channel?.readyState === "open") {
                    for (const event of data.events ?? []) {
                        mine.channel.send(JSON.stringify(event));
                    }
                }
            });
        }

        await pc.setLocalDescription(await pc.createOffer());

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

            await pc.setRemoteDescription({ type: "answer", sdp: answer });
            await api(`voice/calls/${mine.call}/joined`, { rtc });
        } else {
            const { sdp } = await api(`voice/calls/${mine.call}/sdp`, { sdp: pc.localDescription.sdp });

            await pc.setRemoteDescription({ type: "answer", sdp });
        }

        if (engine === mine) {
            setCall({ call: mine.call, path: mine.path, model: start.model, status: hold ? "holding" : "listening", startedAt: Date.now() });
            tellShell("start");
        }
    } catch (error) {
        if (engine === mine) {
            await endVoice({ quiet: true });
            notify("error", t("The call did not start: {why}", { why: error?.message ?? String(error) }));
        }
    }
}

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
            setCall({ status: "listening", you: "", voice: "" });
            break;
        case "conversation.item.input_audio_transcription.delta":
            setCall((call) => ({ you: `${call.you}${event.delta ?? ""}` }));
            break;
        case "conversation.item.input_audio_transcription.completed":
        case "input_transcript.added":
            setCall({ you: String(event.transcript ?? event.item?.text ?? "") });
            break;
        case "response.created":
            setCall({ voice: "" });
            break;
        case "response.output_audio_transcript.delta":
            setCall((call) => ({ voice: `${call.voice}${event.delta ?? ""}`, status: "speaking" }));
            break;
        case "output_transcript.added":
            setCall({ voice: String(event.item?.text ?? ""), status: "speaking" });
            break;
        case "output_audio_buffer.started":
            setCall({ status: "speaking" });
            break;
        case "output_audio_buffer.stopped":
        case "response.done":
        case "turn.done":
            setCall((call) => ({ status: call.hold ? "holding" : "listening" }));
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
    mine.stopRelay?.();
    mine.channel?.close();
    mine.pc?.close();
    mine.mic?.getTracks().forEach((track) => track.stop());

    if (mine.audio) {
        mine.audio.srcObject = null;
    }

    void mine.audioContext?.close().catch(() => {});

    if (mine.call) {
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

/** Mute or unmute the microphone: the call stays up, sending silence. */
export function setVoiceMuted(muted) {
    if (engine?.mic) {
        engine.muted = muted;
        engine.mic.getAudioTracks().forEach((track) => (track.enabled = !muted));
    }

    setCall({ muted, ...(muted ? { status: "muted" } : { status: "listening" }) });
    tellShell("update");
}

/** Hands-free (the voice answers when you pause, and stops when you talk) or hold to talk, for this call. */
export function setVoiceHold(hold) {
    const mine = engine;

    if (mine?.channel?.readyState === "open" && mine.path !== "codex") {
        mine.channel.send(
            JSON.stringify({
                type: "session.update",
                session: {
                    type: "realtime",
                    audio: { input: { turn_detection: hold ? null : { type: "semantic_vad", interrupt_response: true, create_response: mine.mode !== "think" } } },
                },
            }),
        );
    }

    if (mine?.mic) {
        mine.muted = hold;
        mine.mic.getAudioTracks().forEach((track) => (track.enabled = !hold));
    }

    setCall({ hold, muted: false, status: hold ? "holding" : "listening" });
}

/** Hold to talk: pressing starts what you say; letting go sends it, and the voice answers (Pi does, in "Pi thinks"). */
export function voicePress(down) {
    const mine = engine;

    if (!mine?.mic || mine.channel?.readyState !== "open") {
        return;
    }

    mine.mic.getAudioTracks().forEach((track) => (track.enabled = down));
    mine.muted = !down;

    if (down) {
        mine.channel.send(JSON.stringify({ type: "response.cancel" }));
        mine.channel.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
        setCall({ pressing: true, status: "listening", you: "" });

        return;
    }

    mine.channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));

    if (mine.mode !== "think") {
        mine.channel.send(JSON.stringify({ type: "response.create" }));
    }

    setCall({ pressing: false, status: "holding" });
}

/** The voice view of the call shows now: asked for, and the call is this session's. */
export function voiceShown(state = store.state) {
    return state.voiceOpen === true && state.voiceCall != null && state.voiceCall.session === state.conversationId;
}

/** Hide the view; the call goes on (the message box's voice button shows it again). */
export function hideVoice() {
    store.set({ voiceOpen: false });
}
