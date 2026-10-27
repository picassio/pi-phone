/**
 * Voice with the owner's ChatGPT (Codex) sign-in (PP-185): a call with the session's Pi, and Codex dictation. This is the
 * server's side of setting a call up; the page holds only the media (`web/voice-call.js`), and the token never leaves
 * the server.
 *
 * How a call is set up depends on the live model, as the model check found it for this sign-in (Settings › Voice says
 * which way each model goes):
 * - `key`: the server mints a short-lived key (`POST /v1/realtime/client_secrets`, 60 s, one call) with the call's
 *   whole configuration, and the page posts its own SDP offer to `/v1/realtime/calls` with it. The page then names the
 *   call (`rtc_…`) and the server joins it by that id with the sign-in (`voice-bridge.ts`).
 * - `server`: minting is refused for this model but a call is not: the page gives the server its SDP offer and the
 *   server posts it with the sign-in, then joins as above.
 * - `codex`: Codex's own voice (`gpt-live-*`) on ChatGPT's private endpoint, which hands work to Pi by itself; the
 *   server posts the SDP there. Never used unless picked as the live model.
 *
 * Minting also checks a model, voice or language for nothing: an unknown one is refused (404/400) before any audio, so
 * the settings are validated live that way.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { HttpError } from "./errors.ts";

export type VoiceMode = "work" | "chat" | "think";
export type VoiceTurns = "hands-free" | "hold";
export type VoiceProgress = "text" | "answer";
/**
 * Who reads Pi's answers in "Pi thinks" (PP-193): the live model, or the device's own voice (Android's text-to-speech
 * in the app, the browser's speech synthesis elsewhere). OpenAI's text-to-speech is not a reader: the ChatGPT sign-in is
 * refused there (`/v1/audio/speech` answers 429 billing_not_active, checked 2026-10-27).
 */
export type VoiceReader = "live" | "device";
export type DictationEngine = "android" | "codex";
export type VoicePath = "key" | "server" | "codex";

export interface VoiceSettings {
    /** The live model of calls. */
    readonly model: string;
    /** The model that writes down what is said: in calls, and for the Codex dictation engine. */
    readonly dictationModel: string;
    /** Who listens to the message box's mic: Android's recognizer, or Codex (`dictationModel`). */
    readonly engine: DictationEngine;
    readonly voice: string;
    /** "auto", or a language the model hears (ISO 639-1, "vi"). */
    readonly language: string;
    /** The voice mode of new sessions; each session may have its own (`SessionMeta.voiceMode`). */
    readonly mode: VoiceMode;
    readonly turns: VoiceTurns;
    /** While Pi works: its words as they come, or only its answer. */
    readonly progress: VoiceProgress;
    /** A tool cue ("still running the tests") at most this often, in seconds; 0: none. */
    readonly cueSeconds: number;
    /** Who reads Pi's answers in "Pi thinks": the live model, or the device's own voice. */
    readonly reader: VoiceReader;
    /** Minutes of voice a day (calls and Codex dictation together); null: no limit. */
    readonly dailyLimit: number | null;
}

export const DEFAULT_VOICE: VoiceSettings = {
    model: "gpt-realtime-2",
    dictationModel: "gpt-4o-transcribe",
    engine: "android",
    voice: "marin",
    language: "auto",
    mode: "work",
    turns: "hands-free",
    progress: "text",
    cueSeconds: 20,
    reader: "live",
    dailyLimit: null,
};

/** The models the check asks about. Others may be set by id; setting one checks it the same way. */
export const LIVE_MODELS = ["gpt-realtime-2", "gpt-realtime-1.5", "gpt-realtime", "gpt-realtime-mini"] as const;
export const CODEX_MODELS = ["gpt-live-1.1-codex"] as const;
export const DICTATION_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;
/** The voices of OpenAI's realtime models; which one a model has is checked when it is set. */
export const VOICES = ["marin", "cedar", "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse"] as const;

const MODES: readonly VoiceMode[] = ["work", "chat", "think"];
const TURNS: readonly VoiceTurns[] = ["hands-free", "hold"];
const PROGRESS: readonly VoiceProgress[] = ["text", "answer"];
const READERS: readonly VoiceReader[] = ["live", "device"];
/** The reader as first named (PP-190): the device's voice. */
const reader = (value: unknown): unknown => (value === "android" ? "device" : value);
const ENGINES: readonly DictationEngine[] = ["android", "codex"];
const KEYS = ["model", "dictationModel", "engine", "voice", "language", "mode", "turns", "progress", "cueSeconds", "reader", "dailyLimit"] as const;
const MODEL_ID = /^[a-z0-9][a-z0-9.\-]{1,63}$/;
const LANGUAGE = /^(auto|[a-z]{2,3})$/;

export const isVoiceMode = (value: unknown): value is VoiceMode => MODES.includes(value as VoiceMode);
export const isCodexModel = (model: string): boolean => model.startsWith("gpt-live");

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The settings as kept (only what differs from the defaults), with the defaults filled in; what does not parse is left at its default. */
export function readVoice(stored: unknown): VoiceSettings {
    if (!isRecord(stored)) {
        return DEFAULT_VOICE;
    }

    const pick = <T>(value: unknown, ok: (value: unknown) => boolean, fallback: T): T => (ok(value) ? (value as T) : fallback);

    return {
        model: pick(stored.model, (value) => typeof value === "string" && MODEL_ID.test(value), DEFAULT_VOICE.model),
        dictationModel: pick(stored.dictationModel, (value) => typeof value === "string" && MODEL_ID.test(value), DEFAULT_VOICE.dictationModel),
        engine: pick(stored.engine, (value) => ENGINES.includes(value as DictationEngine), DEFAULT_VOICE.engine),
        voice: pick(stored.voice, (value) => typeof value === "string" && /^[a-z]{2,20}$/.test(value), DEFAULT_VOICE.voice),
        language: pick(stored.language, (value) => typeof value === "string" && LANGUAGE.test(value), DEFAULT_VOICE.language),
        mode: pick(stored.mode, isVoiceMode, DEFAULT_VOICE.mode),
        turns: pick(stored.turns, (value) => TURNS.includes(value as VoiceTurns), DEFAULT_VOICE.turns),
        progress: pick(stored.progress, (value) => PROGRESS.includes(value as VoiceProgress), DEFAULT_VOICE.progress),
        cueSeconds: pick(stored.cueSeconds, (value) => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 600, DEFAULT_VOICE.cueSeconds),
        reader: pick(reader(stored.reader), (value) => READERS.includes(value as VoiceReader), DEFAULT_VOICE.reader),
        dailyLimit: pick(stored.dailyLimit, (value) => value === null || (Number.isInteger(value) && (value as number) > 0), DEFAULT_VOICE.dailyLimit),
    };
}

/** `current` with `patch` applied, its shape checked (models, voice and language are checked live by `VoiceService.validate`). */
export function withVoice(current: VoiceSettings, patch: unknown): VoiceSettings {
    if (!isRecord(patch)) {
        throw new HttpError(400, "voice is an object of the settings to change.");
    }

    for (const key of Object.keys(patch)) {
        if (!(KEYS as readonly string[]).includes(key)) {
            throw new HttpError(400, `voice has no setting "${key}".`);
        }
    }

    const next: { -readonly [K in keyof VoiceSettings]: VoiceSettings[K] } = { ...current };
    const text = (key: "model" | "dictationModel", value: unknown) => {
        if (typeof value !== "string" || !MODEL_ID.test(value.trim())) {
            throw new HttpError(400, `voice.${key} is a model's id, like gpt-realtime-2.`);
        }

        return value.trim();
    };

    if (patch.model !== undefined) {
        next.model = text("model", patch.model);
    }

    if (patch.dictationModel !== undefined) {
        next.dictationModel = text("dictationModel", patch.dictationModel);

        if (isCodexModel(next.dictationModel)) {
            throw new HttpError(400, "voice.dictationModel is a transcription model, like gpt-4o-transcribe.");
        }
    }

    if (patch.engine !== undefined) {
        if (!ENGINES.includes(patch.engine as DictationEngine)) {
            throw new HttpError(400, "voice.engine is android or codex.");
        }

        next.engine = patch.engine as DictationEngine;
    }

    if (patch.voice !== undefined) {
        if (typeof patch.voice !== "string" || !/^[a-z]{2,20}$/.test(patch.voice.trim().toLowerCase())) {
            throw new HttpError(400, "voice.voice is a voice's name, like marin.");
        }

        next.voice = patch.voice.trim().toLowerCase();
    }

    if (patch.language !== undefined) {
        if (typeof patch.language !== "string" || !LANGUAGE.test(patch.language.trim().toLowerCase())) {
            throw new HttpError(400, "voice.language is auto, or a language's two-letter code, like vi.");
        }

        next.language = patch.language.trim().toLowerCase();
    }

    if (patch.mode !== undefined) {
        if (!isVoiceMode(patch.mode)) {
            throw new HttpError(400, "voice.mode is work, chat, or think.");
        }

        next.mode = patch.mode;
    }

    if (patch.turns !== undefined) {
        if (!TURNS.includes(patch.turns as VoiceTurns)) {
            throw new HttpError(400, "voice.turns is hands-free or hold.");
        }

        next.turns = patch.turns as VoiceTurns;
    }

    if (patch.progress !== undefined) {
        if (!PROGRESS.includes(patch.progress as VoiceProgress)) {
            throw new HttpError(400, "voice.progress is text or answer.");
        }

        next.progress = patch.progress as VoiceProgress;
    }

    if (patch.cueSeconds !== undefined) {
        if (!Number.isInteger(patch.cueSeconds) || (patch.cueSeconds as number) < 0 || (patch.cueSeconds as number) > 600) {
            throw new HttpError(400, "voice.cueSeconds is a whole number of seconds from 0 (no cues) to 600.");
        }

        next.cueSeconds = patch.cueSeconds as number;
    }

    if (patch.reader !== undefined) {
        if (!READERS.includes(reader(patch.reader) as VoiceReader)) {
            throw new HttpError(400, "voice.reader is live or device.");
        }

        next.reader = reader(patch.reader) as VoiceReader;
    }

    if (patch.dailyLimit !== undefined) {
        if (patch.dailyLimit !== null && !(Number.isInteger(patch.dailyLimit) && (patch.dailyLimit as number) > 0 && (patch.dailyLimit as number) <= 1440)) {
            throw new HttpError(400, "voice.dailyLimit is a number of minutes from 1 to 1440, or null for none.");
        }

        next.dailyLimit = patch.dailyLimit as number | null;
    }

    return next;
}

/** What is kept: only the settings that differ from the defaults; undefined when none do. */
export function storedVoice(settings: VoiceSettings): Partial<VoiceSettings> | undefined {
    const kept: Partial<Record<keyof VoiceSettings, unknown>> = {};

    for (const key of KEYS) {
        if (settings[key] !== DEFAULT_VOICE[key]) {
            kept[key] = settings[key];
        }
    }

    return Object.keys(kept).length === 0 ? undefined : (kept as Partial<VoiceSettings>);
}

/** What the last model check found with this sign-in: the live models with the way each is set up, and the dictation models. */
export interface VoiceCheck {
    readonly at: number;
    readonly live: readonly { readonly id: string; readonly path: VoicePath }[];
    readonly dictation: readonly string[];
    /** Asked about, and not for this sign-in. */
    readonly hidden: readonly string[];
}

export function readVoiceCheck(stored: unknown): VoiceCheck | undefined {
    if (!isRecord(stored) || typeof stored.at !== "number" || !Array.isArray(stored.live) || !Array.isArray(stored.dictation)) {
        return undefined;
    }

    const paths: readonly VoicePath[] = ["key", "server", "codex"];

    return {
        at: stored.at,
        live: stored.live.filter(
            (each): each is { id: string; path: VoicePath } => isRecord(each) && typeof each.id === "string" && paths.includes(each.path as VoicePath),
        ),
        dictation: stored.dictation.filter((each): each is string => typeof each === "string"),
        hidden: Array.isArray(stored.hidden) ? stored.hidden.filter((each): each is string => typeof each === "string") : [],
    };
}

/** Where OpenAI is: the real addresses, or a test's stand-in. */
export interface VoiceEndpoints {
    /** `https://api.openai.com/v1` */
    readonly api: string;
    /** `wss://api.openai.com/v1` */
    readonly socket: string;
    /** `https://chatgpt.com/backend-api/codex` */
    readonly codex: string;
}

export const OPENAI: VoiceEndpoints = {
    api: "https://api.openai.com/v1",
    socket: "wss://api.openai.com/v1",
    codex: "https://chatgpt.com/backend-api/codex",
};

/** The sign-in's access token and its ChatGPT account. */
export interface VoiceAuth {
    readonly token: string;
    readonly account?: string;
}

/** The ChatGPT account a Codex token is for (its JWT's claims), or undefined. */
export function chatgptAccount(token: string): string | undefined {
    try {
        const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown;
        const auth = isRecord(claims) ? claims["https://api.openai.com/auth"] : undefined;
        const id = isRecord(auth) ? auth.chatgpt_account_id : undefined;

        return typeof id === "string" && id !== "" ? id : undefined;
    } catch {
        return undefined;
    }
}

/** An SDP offer for checking a call endpoint without media: audio (opus) and a data channel, made up. */
export function probeOffer(): string {
    const fingerprint = [...randomBytes(32)].map((byte) => byte.toString(16).padStart(2, "0").toUpperCase()).join(":");
    const ufrag = randomBytes(4).toString("hex");
    const pwd = randomBytes(12).toString("hex");
    const media = (kind: string, mid: number) => [
        kind,
        "c=IN IP4 0.0.0.0",
        `a=ice-ufrag:${ufrag}`,
        `a=ice-pwd:${pwd}`,
        `a=fingerprint:sha-256 ${fingerprint}`,
        "a=setup:actpass",
        `a=mid:${mid}`,
    ];

    return [
        "v=0",
        `o=- ${Date.now()} 2 IN IP4 127.0.0.1`,
        "s=-",
        "t=0 0",
        "a=group:BUNDLE 0 1",
        ...media("m=audio 9 UDP/TLS/RTP/SAVPF 111", 0),
        "a=sendrecv",
        "a=rtcp-mux",
        "a=rtpmap:111 opus/48000/2",
        ...media("m=application 9 UDP/DTLS/SCTP webrtc-datachannel", 1),
        "a=sctp-port:5000",
        "",
    ].join("\r\n");
}

/** How a session's call runs: its mode, and the context Pi's session gives it (`voice-bridge.ts` fills these in). */
export interface CallPlan {
    readonly mode: VoiceMode;
    readonly instructions: string;
    /** The tools the live model has: `ask_pi` in "Pi works", none otherwise. */
    readonly tools: readonly Record<string, unknown>[];
}

/** One call: whose, for which session, how it was set up, and since when. */
export interface VoiceCall {
    readonly id: string;
    readonly session: number;
    readonly userId: string;
    readonly model: string;
    readonly path: VoicePath;
    /** Who thinks: the session's mode as the call began, changed with it during the call (`VoiceBridge.modeChanged`). */
    mode: VoiceMode;
    readonly startedAt: number;
    /** OpenAI's id for the call (`rtc_…`), once the SDP went through. */
    rtc?: string;
    ended?: number;
}

/** A Codex dictation: a short-lived key for a transcription session the page opens itself. */
export interface Dictation {
    readonly id: string;
    readonly userId: string;
    readonly model: string;
    readonly startedAt: number;
    ended?: number;
}

export interface VoiceOptions {
    /** The sign-in's token, fresh (refreshed when it ran out); undefined when there is none. */
    auth(): Promise<VoiceAuth | undefined>;
    settings(): VoiceSettings;
    check(): VoiceCheck | undefined;
    saveCheck(check: VoiceCheck): void;
    /** Seconds of voice so far today, calls and dictation together (`Spend.voiceToday`). */
    usedToday(): number;
    /** Count a call's or a dictation's seconds (`Spend.voiceUsed`). */
    used(kind: "call" | "dictation", seconds: number): void;
    /** A call went through: the bridge joins it (`voice-bridge.ts`). */
    joined?(call: VoiceCall): void;
    /** A call ended, by the page or the bridge. */
    ended?(call: VoiceCall): void;
    endpoints?: VoiceEndpoints;
    fetch?: typeof fetch;
    now?: () => number;
}

/** What the page gets to set a call up: never the sign-in's token. */
export type CallStart =
    | { call: string; path: "key"; model: string; url: string; key: string; expiresAt: number }
    | { call: string; path: "server" | "codex"; model: string };

const MINT_SECONDS = 60;
const TIMEOUT_MS = 20_000;

export class VoiceService {
    readonly #options: VoiceOptions;
    readonly #calls = new Map<string, VoiceCall>();
    readonly #dictations = new Map<string, Dictation>();

    constructor(options: VoiceOptions) {
        this.#options = options;
    }

    get endpoints(): VoiceEndpoints {
        return this.#options.endpoints ?? OPENAI;
    }

    #now(): number {
        return (this.#options.now ?? Date.now)();
    }

    /** The sign-in, or a 409 that says where to add it. */
    async auth(): Promise<VoiceAuth> {
        const auth = await this.#options.auth();

        if (auth === undefined || auth.token === "") {
            throw new HttpError(409, "Voice needs the ChatGPT (Codex) sign-in: add it in Settings › Providers.");
        }

        return auth;
    }

    /** The sign-in's headers, as Codex sends them. */
    headers(auth: VoiceAuth): Record<string, string> {
        return {
            authorization: `Bearer ${auth.token}`,
            ...(auth.account === undefined ? {} : { "chatgpt-account-id": auth.account }),
            originator: "pi",
        };
    }

    /** A request to OpenAI: its status and body, with the token never in what comes back (an error may quote the request). */
    async #request(auth: VoiceAuth, url: string, init: { method: string; headers: Record<string, string>; body: string }): Promise<{ status: number; text: string; location: string | null }> {
        const response = await (this.#options.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
        const text = (await response.text()).split(auth.token).join("[token]");

        return { status: response.status, text, location: response.headers.get("location") };
    }

    /** OpenAI's own words for a refusal, short. */
    static #why(text: string): string {
        try {
            const parsed = JSON.parse(text) as unknown;
            const error = isRecord(parsed) ? parsed.error : undefined;
            const message = isRecord(error) ? error.message : undefined;

            if (typeof message === "string") {
                return message.slice(0, 300);
            }
        } catch {
            // Not JSON: its start.
        }

        return text.slice(0, 300);
    }

    /** Mint a short-lived key for one session's configuration. */
    async mint(auth: VoiceAuth, session: Record<string, unknown>): Promise<{ status: number; key?: string; expiresAt?: number; why: string }> {
        const answer = await this.#request(auth, `${this.endpoints.api}/realtime/client_secrets`, {
            method: "POST",
            headers: { ...this.headers(auth), "content-type": "application/json" },
            body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: MINT_SECONDS }, session }),
        });

        if (answer.status !== 200) {
            return { status: answer.status, why: VoiceService.#why(answer.text) };
        }

        const parsed = JSON.parse(answer.text) as unknown;
        const value = isRecord(parsed) ? (parsed.value ?? (isRecord(parsed.client_secret) ? parsed.client_secret.value : undefined)) : undefined;
        const expires = isRecord(parsed) ? (parsed.expires_at ?? (isRecord(parsed.client_secret) ? parsed.client_secret.expires_at : undefined)) : undefined;

        if (typeof value !== "string" || value === "") {
            return { status: 502, why: "OpenAI answered without a key." };
        }

        return { status: 200, key: value, expiresAt: typeof expires === "number" ? expires * 1000 : this.#now() + MINT_SECONDS * 1000, why: "" };
    }

    /** Post an SDP offer with the sign-in: to the public calls endpoint (`server`), or Codex's (`codex`). */
    async postOffer(auth: VoiceAuth, path: "server" | "codex", model: string, sdp: string, session: Record<string, unknown>): Promise<{ status: number; sdp?: string; rtc?: string; why: string }> {
        const answer =
            path === "server"
                ? await this.#request(auth, `${this.endpoints.api}/realtime/calls?model=${encodeURIComponent(model)}`, {
                      method: "POST",
                      headers: { ...this.headers(auth), "content-type": "application/sdp" },
                      body: sdp,
                  })
                : await this.#request(auth, `${this.endpoints.codex}/realtime/calls?intent=quicksilver&architecture=avas`, {
                      method: "POST",
                      headers: { ...this.headers(auth), "openai-alpha": "quicksilver=v2", "content-type": "application/json" },
                      body: JSON.stringify({ sdp, session }),
                  });

        if (answer.status !== 200 && answer.status !== 201) {
            return { status: answer.status, why: VoiceService.#why(answer.text) };
        }

        if (!answer.text.startsWith("v=0")) {
            return { status: 502, why: "The call endpoint answered without an SDP answer." };
        }

        return { status: 201, sdp: answer.text, ...(answer.location === null ? {} : { rtc: answer.location.split("/").pop() }), why: "" };
    }

    /**
     * Which way a live model is set up with this sign-in, or null when it is not for it: Codex's own voice on its
     * endpoint; others by a short-lived key; else, when minting is refused but not for the model (401/403), by the
     * server posting the SDP. A 404 is "no such model for you". Errors other than refusals are thrown.
     */
    async liveModel(auth: VoiceAuth, model: string, voice?: string): Promise<{ path: VoicePath } | { path: null; why: string }> {
        if (isCodexModel(model)) {
            const posted = await this.postOffer(auth, "codex", model, probeOffer(), { model, instructions: "A check: say nothing.", delegation: { type: "client" } });

            return posted.status === 201 ? { path: "codex" } : { path: null, why: posted.why };
        }

        const minted = await this.mint(auth, { type: "realtime", model, ...(voice === undefined ? {} : { audio: { output: { voice } } }) });

        if (minted.status === 200) {
            return { path: "key" };
        }

        if (minted.status === 401 || minted.status === 403) {
            const posted = await this.postOffer(auth, "server", model, probeOffer(), {});

            return posted.status === 201 ? { path: "server" } : { path: null, why: posted.why };
        }

        if (minted.status >= 500) {
            throw new HttpError(502, `OpenAI could not check ${model}: ${minted.why}`);
        }

        return { path: null, why: minted.why };
    }

    /** Whether a transcription model (and a language for it) is for this sign-in. */
    async dictationModel(auth: VoiceAuth, model: string, language = "auto"): Promise<{ ok: true } | { ok: false; why: string }> {
        const minted = await this.mint(auth, dictationSession(model, language));

        if (minted.status >= 500) {
            throw new HttpError(502, `OpenAI could not check ${model}: ${minted.why}`);
        }

        return minted.status === 200 ? { ok: true } : { ok: false, why: minted.why };
    }

    /** Ask OpenAI which live and dictation models this sign-in has, and keep what it said. */
    async check(): Promise<VoiceCheck> {
        const auth = await this.auth();
        const live: { id: string; path: VoicePath }[] = [];
        const dictation: string[] = [];
        const hidden: string[] = [];
        const settings = this.#options.settings();
        const asked = [...new Set([...LIVE_MODELS, ...CODEX_MODELS, settings.model])];

        for (const id of asked) {
            const found = await this.liveModel(auth, id);

            if (found.path === null) {
                hidden.push(id);
            } else {
                live.push({ id, path: found.path });
            }
        }

        for (const id of [...new Set([...DICTATION_MODELS, settings.dictationModel])]) {
            const found = await this.dictationModel(auth, id);

            if (found.ok) {
                dictation.push(id);
            } else {
                hidden.push(id);
            }
        }

        const check: VoiceCheck = { at: this.#now(), live, dictation, hidden };

        this.#options.saveCheck(check);

        return check;
    }

    /**
     * Check the settings a patch changes against OpenAI before they are kept: a live or dictation model, a voice (with
     * the live model), a language (with the dictation model). What is refused says OpenAI's reason. The model check is
     * updated with what this found.
     */
    async validate(current: VoiceSettings, next: VoiceSettings): Promise<void> {
        const changed = (key: keyof VoiceSettings) => current[key] !== next[key];

        if (!changed("model") && !changed("voice") && !changed("dictationModel") && !changed("language")) {
            return;
        }

        const auth = await this.auth();
        const before = this.#options.check();
        let live = [...(before?.live ?? [])];
        let dictation = [...(before?.dictation ?? [])];

        if (changed("model") || changed("voice")) {
            const found = await this.liveModel(auth, next.model, isCodexModel(next.model) ? undefined : next.voice);

            if (found.path === null) {
                throw new HttpError(400, changed("model") ? `${next.model} is not a live model for your sign-in: ${found.why}` : `${next.model} has no voice "${next.voice}": ${found.why}`);
            }

            const entry = { id: next.model, path: found.path };

            live = live.some((each) => each.id === next.model) ? live.map((each) => (each.id === next.model ? entry : each)) : [...live, entry];
        }

        if (changed("dictationModel") || changed("language")) {
            const found = await this.dictationModel(auth, next.dictationModel, next.language);

            if (!found.ok) {
                throw new HttpError(400, changed("dictationModel") ? `${next.dictationModel} is not a dictation model for your sign-in: ${found.why}` : `${next.dictationModel} does not take the language "${next.language}": ${found.why}`);
            }

            dictation = [...new Set([...dictation, next.dictationModel])];
        }

        this.#options.saveCheck({ at: before?.at ?? this.#now(), live, dictation, hidden: (before?.hidden ?? []).filter((id) => id !== next.model && id !== next.dictationModel) });
    }

    /** The way the settings' live model is set up, from the last check; a model not checked yet is checked now. */
    async #pathOf(auth: VoiceAuth, model: string): Promise<VoicePath> {
        const known = this.#options.check()?.live.find((each) => each.id === model);

        if (known !== undefined) {
            return known.path;
        }

        const found = await this.liveModel(auth, model);

        if (found.path === null) {
            throw new HttpError(409, `${model} is not a live model for your sign-in (${found.why}): pick another in Settings › Voice.`);
        }

        return found.path;
    }

    /** Refuse a call or a dictation once today's minutes are used up. */
    #underLimit(): void {
        const limit = this.#options.settings().dailyLimit;

        if (limit !== null && this.#options.usedToday() >= limit * 60) {
            throw new HttpError(429, `Today's voice minutes (${limit}) are used up: raise the limit in Settings › Voice.`);
        }
    }

    /**
     * Set a call up for a session. `plan` is the call's mode and context; with a key the whole configuration goes into
     * it, so the page cannot change what the call does.
     */
    async start(userId: string, session: number, plan: CallPlan): Promise<CallStart> {
        this.#underLimit();

        const settings = this.#options.settings();
        const auth = await this.auth();
        const path = await this.#pathOf(auth, settings.model);
        const call: VoiceCall = { id: randomUUID(), session, userId, model: settings.model, path, mode: plan.mode, startedAt: this.#now() };

        if (path === "key") {
            const minted = await this.mint(auth, callSession(settings, plan));

            if (minted.key === undefined) {
                throw new HttpError(minted.status === 429 ? 429 : 502, `OpenAI did not start the call: ${minted.why}`);
            }

            this.#calls.set(call.id, call);

            return { call: call.id, path, model: call.model, url: `${this.endpoints.api}/realtime/calls`, key: minted.key, expiresAt: minted.expiresAt ?? this.#now() + MINT_SECONDS * 1000 };
        }

        this.#calls.set(call.id, call);

        return { call: call.id, path, model: call.model };
    }

    /** A call of this person's, or a 404. */
    call(userId: string, id: string): VoiceCall {
        const call = this.#calls.get(id);

        if (call === undefined || call.userId !== userId || call.ended !== undefined) {
            throw new HttpError(404, "There is no such call: start it again.");
        }

        return call;
    }

    /** The calls going on now. */
    calls(): VoiceCall[] {
        return [...this.#calls.values()].filter((each) => each.ended === undefined);
    }

    /** For `server` and `codex` calls: post the page's SDP offer with the sign-in, and give back the answer. */
    async answer(userId: string, id: string, sdp: unknown, plan: CallPlan): Promise<{ sdp: string }> {
        const call = this.call(userId, id);

        if (call.path === "key") {
            throw new HttpError(400, "This call posts its own offer with its key.");
        }

        if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > 64 * 1024) {
            throw new HttpError(400, "sdp is the page's SDP offer.");
        }

        const settings = this.#options.settings();
        const auth = await this.auth();
        const session =
            call.path === "codex"
                ? { model: call.model, instructions: plan.instructions, audio: { output: { voice: settings.voice } }, delegation: { type: "client", ack_filler: true } }
                : {};
        const posted = await this.postOffer(auth, call.path, call.model, sdp, session);

        if (posted.sdp === undefined) {
            throw new HttpError(posted.status === 429 ? 429 : 502, `OpenAI did not take the call: ${posted.why}`);
        }

        if (posted.rtc !== undefined) {
            call.rtc = posted.rtc;
        }

        if (call.path === "server" && call.rtc === undefined) {
            throw new HttpError(502, "OpenAI did not name the call.");
        }

        // The bridge joins: by the call's id (`server`), or through the page's data channel (`codex`).
        this.#options.joined?.(call);

        return { sdp: posted.sdp };
    }

    /** For `key` calls: the page posted its offer and OpenAI named the call; the bridge joins it now. */
    joined(userId: string, id: string, rtc: unknown): VoiceCall {
        const call = this.call(userId, id);

        if (call.path !== "key") {
            throw new HttpError(400, "This call went through the server.");
        }

        if (typeof rtc !== "string" || !/^rtc_[A-Za-z0-9_\-]{4,120}$/.test(rtc)) {
            throw new HttpError(400, "rtc is OpenAI's id of the call (rtc_…).");
        }

        call.rtc = rtc;
        this.#options.joined?.(call);

        return call;
    }

    /** End a call: its minutes are counted. Ending one that ended is nothing. */
    end(id: string): void {
        const call = this.#calls.get(id);

        if (call === undefined || call.ended !== undefined) {
            return;
        }

        call.ended = this.#now();
        this.#calls.delete(id);
        this.#options.used("call", Math.max(0, Math.round((call.ended - call.startedAt) / 1000)));
        this.#options.ended?.(call);
    }

    /** End every call (the app closing). */
    endAll(): void {
        for (const call of [...this.#calls.values()]) {
            this.end(call.id);
        }
    }

    /** A Codex dictation for the message box: a short-lived key for a transcription session, which the page opens itself. */
    async dictation(userId: string): Promise<{ dictation: string; model: string; url: string; key: string; expiresAt: number }> {
        this.#underLimit();

        const settings = this.#options.settings();
        const auth = await this.auth();
        const minted = await this.mint(auth, dictationSession(settings.dictationModel, settings.language));

        if (minted.key === undefined) {
            throw new HttpError(minted.status === 429 ? 429 : 502, `OpenAI did not start dictation: ${minted.why}`);
        }

        const dictation: Dictation = { id: randomUUID(), userId, model: settings.dictationModel, startedAt: this.#now() };

        this.#dictations.set(dictation.id, dictation);

        return { dictation: dictation.id, model: dictation.model, url: `${this.endpoints.api}/realtime/calls`, key: minted.key, expiresAt: minted.expiresAt ?? this.#now() + MINT_SECONDS * 1000 };
    }

    /** A dictation ended: its seconds are counted. */
    dictationEnd(userId: string, id: string): void {
        const dictation = this.#dictations.get(id);

        if (dictation === undefined || dictation.userId !== userId) {
            return;
        }

        this.#dictations.delete(id);
        this.#options.used("dictation", Math.max(0, Math.round((this.#now() - dictation.startedAt) / 1000)));
    }
}

/**
 * The live model's instructions for a session's mode. Pi does the work in "Pi works"; the voice only chats in "Chat
 * only"; in "Pi thinks" it only reads Pi's words out.
 */
export function voiceInstructions(mode: VoiceMode, title?: string): string {
    const where = title === undefined ? "" : ` The session is "${title}".`;
    const speak = "Speak briefly and naturally, in the language the owner speaks. Never read code, long paths or tables aloud: say what they mean.";

    if (mode === "think") {
        return `You are only the voice of Pi, a coding agent, on a call with its owner.${where} Never answer on your own. When a message starts with "Read aloud:", read the rest out as written, in the owner's language, without adding anything.`;
    }

    if (mode === "chat") {
        return `You chat by voice with the owner of Pi, a coding agent, in one of Pi's sessions.${where} You cannot act, run anything, or see their files: say so when asked, and suggest they switch the call to "Pi works". ${speak} Pi reads this talk later, as a note with the owner's next message.`;
    }

    return `You are the voice of Pi, a coding agent, on a call with its owner in one of Pi's sessions.${where} Pi does the work: hand every action, every fact about their projects or systems, every check and any real reasoning to Pi with the ask_pi tool, in the owner's own words and complete, then say a short acknowledgement. Never claim work Pi has not done, and never make up results. Pi's words reach you as messages starting with "Pi says:"; tell the owner what they mean, briefly. Messages starting with "Pi is working:" are progress: one short sentence at most. Only small talk and questions about this call you answer yourself. Pi's approvals need a tap on the screen: when Pi asks for one, say so. ${speak}`;
}

/** A transcription session's configuration: the model, and the language unless auto. */
export function dictationSession(model: string, language: string): Record<string, unknown> {
    return {
        type: "transcription",
        audio: {
            input: {
                transcription: { model, ...(language === "auto" ? {} : { language }) },
                turn_detection: { type: "server_vad" },
            },
        },
    };
}

/**
 * A call's whole configuration: its model, voice, how it hears (the dictation model writes down what is said, for the
 * transcript), when it answers (hands-free: semantic VAD that stops the voice when you talk; hold: only when you let
 * go), and its instructions and tools. In "Pi thinks" the model never answers by itself: Pi's words are read out.
 */
export function callSession(settings: VoiceSettings, plan: CallPlan): Record<string, unknown> {
    return {
        type: "realtime",
        model: settings.model,
        instructions: plan.instructions,
        audio: {
            input: {
                transcription: { model: settings.dictationModel, ...(settings.language === "auto" ? {} : { language: settings.language }) },
                turn_detection:
                    settings.turns === "hold"
                        ? null
                        : { type: "semantic_vad", interrupt_response: true, create_response: plan.mode !== "think" },
            },
            output: { voice: settings.voice },
        },
        ...(plan.tools.length === 0 ? {} : { tools: plan.tools, tool_choice: "auto" }),
    };
}
