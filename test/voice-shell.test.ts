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
        export const onVoiceEvents = () => () => {};
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

type State = { voiceCall: { session: number; muted: boolean } | null; voiceOpen?: boolean; sessions: { id: number; title: string }[]; server: unknown; me: unknown; conversationId: number | null };

const told: Record<string, unknown>[] = [];
const asked: string[] = [];
const track = { enabled: true, stop() {} };
const shared = {
    navigated: [] as number[],
    notices: [] as string[],
    store: {
        state: {
            voiceCall: null,
            sessions: [{ id: 7, title: "AHA deploy" }, { id: 9, title: "Voice" }],
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
        return { readyState: "open", send() {}, close() {} };
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
