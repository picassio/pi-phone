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
    async api(path: string) {
        asked.push(path);

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
};
const action = (word: string) => (globalThis as unknown as { __piVoiceAction(word: string): void }).__piVoiceAction(word);

test("a call tells the window it started, was muted and ended; the notification's Mute and End reach the call", async () => {
    await voice.startVoice(7);

    assert.deepEqual(told, [{ state: "start", session: 7, title: "AHA deploy", muted: false }]);
    assert.ok(asked.includes("voice/calls/call-1/joined"));

    // The notification's Mute: the mic's track goes silent, and the notification says muted.
    action("mute");
    assert.equal(track.enabled, false);
    assert.deepEqual(told.at(-1), { state: "update", session: 7, title: "AHA deploy", muted: true });
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
    assert.deepEqual(told, [{ state: "start", session: 9, title: "Voice", muted: false }]);
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
    await voice.endVoice();
    Object.assign(settings, { noise: "near_field", eagerness: "auto" });
});
