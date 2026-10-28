// The voice call's page and the Android app's window (PP-191, PP-192; web/voice-call.js with VoicePage.java,
// MainActivity.java, PiAssistantSession.java): the page tells the window when a call starts, is muted and ends
// (`PiPhoneApp.voiceCall`), so its notification and audio follow; the notification's Mute and End come back as
// `__piVoiceAction`; the assistant's sheet hands its call over (`__piVoiceHandOver`: ended here, the notification kept);
// the window starts or shows a call in a session (`voiceFromShell`). WebRTC, the microphone, the server and the store
// are stood in.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { test } from "node:test";

/** What voice-call.js imports, stood in for: the server's answers, the store, and the app's words as written. */
const STUBS: Record<string, string> = {
    "./i18n.js": `export const t = (text) => text;`,
    "./store.js": `
        const shared = globalThis.__stub;
        export const store = shared.store;
        export const api = (path, body) => shared.api(path, body);
        export const navigate = (id) => shared.navigated.push(id);
        export const notify = (level, message) => shared.notices.push(message);
        export const onVoiceEvents = (listener) => {
            shared.voiceListeners.add(listener);

            return () => shared.voiceListeners.delete(listener);
        };
    `,
};

registerHooks({
    resolve(specifier, context, next) {
        const stub = STUBS[specifier];

        return stub !== undefined && context.parentURL?.endsWith("/web/voice-call.js")
            ? { url: `data:text/javascript,${encodeURIComponent(stub)}`, shortCircuit: true }
            : next(specifier, context);
    },
});

type State = {
    voiceCall: { session: number; muted: boolean; status?: string; voice?: string } | null;
    voiceOpen?: boolean;
    sessions: { id: number; title: string; voiceMode?: string }[];
    server: { voice: { settings: Record<string, unknown> } };
    me: unknown;
    conversationId: number | null;
};

const told: Record<string, unknown>[] = [];
const asked: string[] = [];
/** What the page told the server of its mic (`voice/calls/:id/mic`). */
const micWords: Record<string, unknown>[] = [];
const track = { enabled: true, stop() {} };
const shared = {
    navigated: [] as number[],
    voiceListeners: new Set<(data: Record<string, unknown>) => void>(),
    notices: [] as string[],
    store: {
        state: {
            voiceCall: null,
            sessions: [{ id: 7, title: "AHA deploy" }, { id: 9, title: "Voice" }, { id: 11, title: "Think", voiceMode: "think" }],
            server: { voice: { settings: { turns: "hands-free", model: "gpt-realtime-2", mode: "work" } } },
            me: { role: "owner" },
            conversationId: 7,
        } as State,
        set(patch: Partial<State> | ((state: State) => Partial<State>)) {
            Object.assign(this.state, typeof patch === "function" ? patch(this.state) : patch);
        },
    },
    async api(path: string, body?: Record<string, unknown>) {
        asked.push(path);

        if (path.endsWith("/mic")) {
            micWords.push(body ?? {});
        }

        if (path.endsWith("/voice/call")) {
            return { call: `call-${asked.length}`, path: "key", url: "https://openai.test/v1/realtime/calls", key: "ek_test", model: "gpt-realtime-2" };
        }

        return {};
    },
};
const global = globalThis as Record<string, unknown>;

global.__stub = shared;
global.PiPhoneApp = { voiceCall: (json: string) => told.push(JSON.parse(json) as Record<string, unknown>) };
Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia: async () => ({ getTracks: () => [track], getAudioTracks: () => [track] }) },
    configurable: true,
});
global.RTCPeerConnection = class {
    localDescription: unknown = null;
    addTrack() {}
    createDataChannel() {
        const channel = { readyState: "open", sent: [] as string[], send(data: string) { channel.sent.push(data); }, close() {}, onmessage: null as unknown };

        global.__channel = channel;

        return channel;
    }
    async createOffer() {
        return { type: "offer", sdp: "v=0\r\n" };
    }
    async setLocalDescription(description: unknown) {
        this.localDescription = description;
    }
    async setRemoteDescription() {}
    close() {}
};
global.Audio = class {};
global.fetch = async () => new Response("v=0\r\nanswer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_test1" } });

const voice = (await import(new URL("../web/voice-call.js", import.meta.url).href)) as {
    startVoice(session: number): Promise<void>;
    endVoice(options?: { quiet?: boolean; handOver?: boolean }): Promise<void>;
    voiceFromShell(session: number, what: string): Promise<void>;
    setVoiceHold(hold: boolean): void;
    setVoiceTurns(turns: string): void;
    setVoiceMuted(muted: boolean): void;
};
const action = (word: string) => (globalThis as unknown as { __piVoiceAction(word: string): void }).__piVoiceAction(word);

test("a call tells the window it started, was muted and ended; the notification's Mute and End reach the call", async () => {
    await voice.startVoice(7);

    assert.deepEqual(told, [{ state: "start", session: 7, title: "AHA deploy", muted: false, muteKey: "headset", proximity: false }]);
    assert.ok(asked.includes("voice/calls/call-1/joined"));

    // The notification's Mute: the mic's track goes silent, and the notification says muted.
    action("mute");
    assert.equal(track.enabled, false);
    assert.deepEqual(told.at(-1), { state: "update", session: 7, title: "AHA deploy", muted: true, muteKey: "headset", proximity: false });
    action("mute");
    assert.equal(track.enabled, true);

    // The notification's End: the call ends on the server, and the window's notification goes.
    action("end");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(told.at(-1), { state: "end", session: 7, title: "AHA deploy", muted: false });
    assert.ok(asked.includes("voice/calls/call-1/end"));
    assert.equal(shared.store.state.voiceCall, null);
});

test("the assistant's sheet hands its call over: ended here, the notification kept for the window's call", async () => {
    await voice.startVoice(7);
    told.length = 0;
    await (globalThis as unknown as { __piVoiceHandOver(): Promise<void> }).__piVoiceHandOver();

    assert.deepEqual(told, [{ state: "end", session: 7, title: "AHA deploy", muted: false, handOver: true }]);
    assert.equal(shared.store.state.voiceCall, null);
});

test("the window starts a call in a session (the sheet's, handed over), or shows the one going on", async () => {
    told.length = 0;
    await voice.voiceFromShell(9, "start");

    assert.deepEqual(shared.navigated, [9]);
    assert.deepEqual(told, [{ state: "start", session: 9, title: "Voice", muted: false, muteKey: "headset", proximity: false }]);
    shared.store.set({ voiceOpen: false, conversationId: 9 });
    await voice.voiceFromShell(9, "show");
    assert.equal(shared.store.state.voiceOpen, true);
    await voice.endVoice();
});

test("in a browser there is no window to tell", async () => {
    const shell = global.PiPhoneApp;

    delete global.PiPhoneApp;
    told.length = 0;
    await voice.startVoice(7);
    await voice.endVoice();
    assert.deepEqual(told, []);
    global.PiPhoneApp = shell;
});

/** The server's word for the call going on (`voice` events): Pi's words to read out. */
const say = (text: string) => {
    const call = (shared.store.state.voiceCall as { call?: string } | null)?.call;

    for (const listener of shared.voiceListeners) {
        listener({ call, say: text });
    }
};
const channelEvent = (event: Record<string, unknown>) => (global.__channel as { onmessage(event: { data: string }): void }).onmessage({ data: JSON.stringify(event) });
const settings = shared.store.state.server.voice.settings;

test("Pi thinks with the device's voice, in the app: Android reads Pi's words one after another; talking over it stops it", async () => {
    const spoken: unknown[][] = [];
    let stopped = 0;
    const shell = global.PiPhoneApp as Record<string, unknown>;

    Object.assign(shell, { speakAvailable: () => true, speak: (...args: unknown[]) => spoken.push(args), stopSpeaking: () => stopped++ });
    Object.assign(settings, { reader: "device", language: "vi" });
    await voice.startVoice(11);
    say("It is noon.");
    say("Anything else?");

    assert.deepEqual(spoken.map((each) => each.slice(1)), [["It is noon.", "vi"]], "one at a time, in the voice's language");
    assert.equal(shared.store.state.voiceCall?.status, "speaking");
    assert.equal(shared.store.state.voiceCall?.voice, "It is noon.");

    const spokenNow = (globalThis as unknown as { __piPhoneSpoken(event: unknown): void }).__piPhoneSpoken;

    spokenNow({ id: spoken[0]![0], state: "done" });
    assert.deepEqual(spoken.map((each) => each[1]), ["It is noon.", "Anything else?"]);

    // The owner talks over it: it stops, and what waited goes.
    say("And one more thing.");
    channelEvent({ type: "input_audio_buffer.speech_started" });
    assert.equal(stopped, 1);
    spokenNow({ id: spoken[1]![0], state: "done" });
    assert.equal(spoken.length, 2, "nothing more is read");
    assert.equal(shared.store.state.voiceCall?.status, "listening");
    await voice.endVoice();
    delete shell.speak;
    delete shell.speakAvailable;
    delete shell.stopSpeaking;
});

test("Pi thinks with the device's voice, in a browser: its speech synthesis reads; a device with no voice does not start the call", async () => {
    const utterances: { text: string; lang: string; onend: () => void }[] = [];

    global.SpeechSynthesisUtterance = class {
        text: string;
        lang = "";
        onend = () => {};
        onerror = () => {};
        constructor(text: string) {
            this.text = text;
        }
    };
    global.speechSynthesis = { speak: (utterance: { text: string; lang: string; onend: () => void }) => utterances.push(utterance), cancel() {} };
    Object.assign(settings, { reader: "device", language: "auto" });
    await voice.startVoice(11);
    say("It is noon.");
    assert.deepEqual(utterances.map((each) => [each.text, each.lang]), [["It is noon.", ""]], "the device's own language for auto");
    utterances[0]!.onend();
    assert.equal(shared.store.state.voiceCall?.status, "listening");
    await voice.endVoice();

    // No voice here: the call does not start, and the notice says where to change the reader.
    delete global.speechSynthesis;
    delete global.SpeechSynthesisUtterance;
    asked.length = 0;
    await voice.startVoice(11);
    assert.equal(shared.store.state.voiceCall, null);
    assert.deepEqual(asked, [], "nothing asked of the server");
    assert.match(String(shared.notices.at(-1)), /no voice to read Pi's answers/);

    // With the live model reading, no device voice is needed.
    Object.assign(settings, { reader: "live" });
    await voice.startVoice(11);
    assert.notEqual(shared.store.state.voiceCall, null);
    await voice.endVoice();
});

test("switching hands-free and hold to talk in a call keeps the mic's noise reduction, and hands-free its eagerness (PP-195)", async () => {
    Object.assign(settings, { noise: "far_field", eagerness: "low" });
    await voice.startVoice(7);

    const updates = () =>
        (global.__channel as { sent: string[] }).sent
            .map((data) => JSON.parse(data) as { type: string; session?: { audio: { input: Record<string, unknown> } } })
            .filter((event) => event.type === "session.update")
            .map((event) => event.session!.audio.input);

    voice.setVoiceHold(true);
    assert.deepEqual(updates().at(-1), { noise_reduction: { type: "far_field" }, turn_detection: null });
    voice.setVoiceHold(false);
    assert.deepEqual(updates().at(-1), {
        noise_reduction: { type: "far_field" },
        turn_detection: { type: "semantic_vad", eagerness: "low", interrupt_response: true, create_response: true },
    });

    Object.assign(settings, { noise: "off" });
    voice.setVoiceHold(true);
    assert.deepEqual(updates().at(-1), { noise_reduction: null, turn_detection: null });

    // By loudness (PP-201): the page's update carries the threshold and the silence, as the server's does.
    Object.assign(settings, { noise: "near_field", vad: "server", vadThreshold: 0.8, vadSilenceMs: 700 });
    voice.setVoiceTurns("tap");
    assert.deepEqual(updates().at(-1), {
        noise_reduction: { type: "near_field" },
        turn_detection: { type: "server_vad", threshold: 0.8, silence_duration_ms: 700, interrupt_response: true, create_response: true },
    });
    await voice.endVoice();
    Object.assign(settings, { noise: "near_field", eagerness: "auto", vad: "semantic" });
});

/** The mic's word to the server, once what is queued went. */
const lastMicWord = async () => {
    await new Promise((resolve) => setImmediate(resolve));

    return micWords.at(-1);
};
const sentTypes = () => (global.__channel as { sent: string[] }).sent.map((data) => (JSON.parse(data) as { type: string }).type);

test("tap to talk (PP-201): the mic is open for one turn and closes when the model hears your speech end; a tap opens it again; the view, the notification and the server know", async () => {
    Object.assign(settings, { turns: "tap" });
    micWords.length = 0;
    await voice.startVoice(7);

    assert.equal(track.enabled, true, "open for the first turn: starting the call was the tap");
    assert.deepEqual(await lastMicWord(), { muted: false, by: "tap", turns: "tap" });
    channelEvent({ type: "input_audio_buffer.speech_started" });
    assert.equal(track.enabled, true);
    channelEvent({ type: "input_audio_buffer.speech_stopped" });
    assert.equal(track.enabled, false, "nothing more is sent: who talks near you is not heard");
    assert.equal(shared.store.state.voiceCall?.muted, true);
    assert.equal((shared.store.state.voiceCall as { mutedBy?: string }).mutedBy, "tap");
    assert.equal(told.at(-1)?.muted, true, "the notification says Unmute");
    assert.deepEqual(await lastMicWord(), { muted: true, by: "tap", turns: "tap" });

    // The headset's button (or the notification's Unmute) is a tap: the next turn.
    action("mic");
    assert.equal(track.enabled, true);
    assert.deepEqual(await lastMicWord(), { muted: false, by: "key", turns: "tap" });
    channelEvent({ type: "input_audio_buffer.committed" });
    assert.equal(track.enabled, false, "a committed turn closes it too");

    // The model's turn detection stays on in tap to talk: it is what ends the turn.
    voice.setVoiceTurns("hands-free");
    voice.setVoiceTurns("tap");

    const update = (global.__channel as { sent: string[] }).sent.map((data) => JSON.parse(data) as { type: string; session?: { audio: { input: Record<string, unknown> } } }).filter((event) => event.type === "session.update").at(-1);

    assert.deepEqual(update?.session?.audio.input, {
        noise_reduction: { type: "near_field" },
        turn_detection: { type: "semantic_vad", eagerness: "auto", interrupt_response: true, create_response: true },
    });
    assert.equal(track.enabled, false, "switched to tap to talk mid-call: closed until the tap");
    await voice.endVoice();
    Object.assign(settings, { turns: "hands-free" });
});

test("hands-free's quiet (PP-201): once the voice has answered, autoMuteSeconds with nothing said mute the mic; talking stops the count; 0 never mutes", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    Object.assign(settings, { autoMuteSeconds: 10 });
    await voice.startVoice(7);
    micWords.length = 0;

    channelEvent({ type: "response.done" });
    t.mock.timers.tick(9_000);
    channelEvent({ type: "input_audio_buffer.speech_started" });
    t.mock.timers.tick(30_000);
    assert.equal(track.enabled, true, "you talked: no count");

    // The voice answers; its audio ends after its response: the count starts from the end of what it said.
    channelEvent({ type: "response.created" });
    channelEvent({ type: "output_audio_buffer.started" });
    channelEvent({ type: "response.done" });
    t.mock.timers.tick(5_000);
    channelEvent({ type: "output_audio_buffer.stopped" });
    t.mock.timers.tick(9_000);
    assert.equal(track.enabled, true);
    t.mock.timers.tick(1_000);
    assert.equal(track.enabled, false, "10 quiet seconds after the voice stopped");
    assert.equal((shared.store.state.voiceCall as { mutedBy?: string }).mutedBy, "auto");
    assert.equal(told.at(-1)?.muted, true);
    t.mock.timers.reset();
    assert.deepEqual(await lastMicWord(), { muted: true, by: "auto", turns: "hands-free" });

    // Mute (or a key) turns it on again.
    voice.setVoiceMuted(false);
    assert.equal(track.enabled, true);
    await voice.endVoice();

    // 0: never.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    Object.assign(settings, { autoMuteSeconds: 0 });
    await voice.startVoice(7);
    channelEvent({ type: "response.done" });
    t.mock.timers.tick(3_600_000);
    assert.equal(track.enabled, true);
    await voice.endVoice();
});

test("keys and the proximity sensor (PP-201): the window gets Settings › Voice's mute key and proximity; a key toggles the mic, hold to talk's presses and sends; away mutes, the ear unmutes only what it muted", async () => {
    Object.assign(settings, { muteKey: "both", proximityMute: true });
    told.length = 0;
    await voice.startVoice(7);
    assert.deepEqual(told[0], { state: "start", session: 7, title: "AHA deploy", muted: false, muteKey: "both", proximity: true });

    action("mic");
    assert.equal(track.enabled, false);
    assert.equal(told.at(-1)?.muted, true);
    action("mic");
    assert.equal(track.enabled, true);

    // The phone leaves the ear: muted; back at the ear: on again.
    action("away");
    assert.equal(track.enabled, false);
    assert.equal((shared.store.state.voiceCall as { mutedBy?: string }).mutedBy, "proximity");
    assert.deepEqual(await lastMicWord(), { muted: true, by: "proximity", turns: "hands-free" });
    action("ear");
    assert.equal(track.enabled, true);

    // Muted by you: the ear leaves it muted.
    voice.setVoiceMuted(true);
    action("away");
    action("ear");
    assert.equal(track.enabled, false, "your Mute stays");
    voice.setVoiceMuted(false);

    // Hold to talk: a key press opens the mic as holding does, the next sends; the sensor leaves it.
    voice.setVoiceTurns("hold");
    assert.equal(track.enabled, false);
    action("away");
    action("ear");
    assert.equal(track.enabled, false);
    action("mic");
    assert.equal(track.enabled, true);
    assert.deepEqual(sentTypes().slice(-2), ["response.cancel", "input_audio_buffer.clear"]);
    action("mic");
    assert.equal(track.enabled, false);
    assert.deepEqual(sentTypes().slice(-2), ["input_audio_buffer.commit", "response.create"]);
    assert.deepEqual(await lastMicWord(), { muted: true, by: "key", turns: "hold" });

    // No sensor on this phone: said, with where to turn it off.
    action("no-proximity");
    assert.match(String(shared.notices.at(-1)), /no proximity sensor/);
    await voice.endVoice();
    Object.assign(settings, { muteKey: "headset", proximityMute: false });
});
