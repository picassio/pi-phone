/**
 * Audio for Pi (PP-261) on the person's ChatGPT (Codex) sign-in, which OpenAI's plain audio endpoints refuse
 * (`/v1/audio/transcriptions` answers 401 to it): the realtime sockets voice calls use.
 *
 * - Transcribe (PP-305): a file, turned by the media engine into 24 kHz mono pcm16 parts of at most `PART_SECONDS`,
 *   each sent at once into a transcription session (`/realtime?intent=transcription`) with server VAD; VAD cuts it into
 *   utterances with their start and end (`input_audio_buffer.speech_started/stopped`), and each utterance's text comes
 *   as `conversation.item.input_audio_transcription.completed`. Their times give SRT and VTT cues.
 */
import { WebSocket } from "ws";
import { HttpError } from "./errors.ts";

/** The transcription models, best first. */
export const TRANSCRIBE_MODELS = ["gpt-4o-transcribe", "gpt-4o-mini-transcribe", "whisper-1"] as const;
export const DEFAULT_TRANSCRIBE_MODEL = TRANSCRIBE_MODELS[0];
/** One part of a file in one session, in seconds (a session lives at most an hour; a part is a few MB of pcm). */
export const PART_SECONDS = 600;
/** pcm16 mono at 24 kHz: bytes a second. */
export const PCM_RATE = 24000;
const BYTES_A_SECOND = PCM_RATE * 2;
/** The longest one cue shows, and its most characters, in subtitles. */
const CUE_SECONDS = 7;
const CUE_CHARS = 84;
/** How long a part may take to come back, beyond its length sent at once. */
const PART_TIMEOUT_MS = 5 * 60 * 1000;
const SETTLE_MS = 5000;

export type AudioAuth = { token: string; account?: string };
/** One utterance: from and to, in milliseconds from the file's start, and what was said. */
export type Utterance = { start: number; end: number; text: string };
export type TranscribeUsage = { input: number; output: number };

export interface AudioOptions {
    auth: () => Promise<AudioAuth | undefined>;
    /** The transcription model the owner set (`audio.transcribeModel`), or null for the default. */
    transcribeSetting: () => string | null;
    /** Settings › Voice's language (`auto`, or a code) and words to listen for (the hint), which transcriptions use too. */
    voice: () => { language: string; words: string };
    endpoints?: { socket: string };
    /** How long nothing more must come before a part is done (tests: short). */
    settleMs?: number;
}

export class Audio {
    readonly #options: AudioOptions;

    constructor(options: AudioOptions) {
        this.#options = options;
    }

    /** The model a transcription uses: `asked`, else the setting, else the default; refused when it is not one. */
    transcribeModel(asked?: string): string {
        const model = asked ?? this.#options.transcribeSetting() ?? DEFAULT_TRANSCRIBE_MODEL;

        if (!(TRANSCRIBE_MODELS as readonly string[]).includes(model)) {
            throw new HttpError(400, `${model} is not a transcription model: ${TRANSCRIBE_MODELS.join(", ")}.`);
        }

        return model;
    }

    /** A transcription's language and hint: those asked, else Settings › Voice's (none when it says auto, or has no words). */
    transcribeHints(asked: { language?: string; prompt?: string }): { language?: string; prompt?: string } {
        const voice = this.#options.voice();
        const language = asked.language ?? (voice.language === "auto" ? undefined : voice.language);
        const prompt = asked.prompt ?? (voice.words.trim() === "" ? undefined : voice.words.trim());

        return { ...(language === undefined ? {} : { language }), ...(prompt === undefined ? {} : { prompt }) };
    }

    async #auth(): Promise<AudioAuth> {
        const auth = await this.#options.auth();

        if (auth === undefined || auth.token === "") {
            throw new HttpError(409, "Audio needs the ChatGPT (Codex) sign-in: add it in Settings › Providers.");
        }

        return auth;
    }

    /**
     * One part's utterances (times from the part's start) and the tokens it took: the pcm sent at once, with silence
     * after it so the last utterance ends, into a transcription session with server VAD.
     */
    async transcribePart(pcm: Uint8Array, settings: { model: string; language?: string; prompt?: string }, signal?: AbortSignal): Promise<{ utterances: Utterance[]; usage: TranscribeUsage }> {
        const auth = await this.#auth();
        const socket = new WebSocket(`${this.#options.endpoints?.socket ?? "wss://api.openai.com/v1"}/realtime?intent=transcription`, {
            headers: { authorization: `Bearer ${auth.token}`, ...(auth.account === undefined ? {} : { "chatgpt-account-id": auth.account }), originator: "pi" },
        });
        const times = new Map<string, { start: number; end?: number }>();
        const texts = new Map<string, string>();
        const usage: TranscribeUsage = { input: 0, output: 0 };
        let sent = false;

        return new Promise((resolve, reject) => {
            let settle: ReturnType<typeof setTimeout> | undefined;
            const timeout = setTimeout(() => finish(new Error("The transcription took too long: no answer from OpenAI.")), PART_TIMEOUT_MS + (pcm.length / BYTES_A_SECOND) * 1000);
            const onAbort = () => finish(new Error("Stopped."));
            const finish = (error?: Error) => {
                clearTimeout(timeout);
                clearTimeout(settle);
                signal?.removeEventListener("abort", onAbort);
                socket.removeAllListeners();
                socket.on("error", () => undefined);
                socket.close();

                if (error !== undefined) {
                    reject(error);
                    return;
                }

                const utterances = [...times.entries()]
                    .map(([id, time]) => ({ start: time.start, end: time.end ?? time.start, text: (texts.get(id) ?? "").trim() }))
                    .filter((each) => each.text !== "")
                    .sort((a, b) => a.start - b.start);

                resolve({ utterances, usage });
            };
            // Done when every utterance VAD found has ended and has its text, after all was sent, and nothing more came
            // for SETTLE_MS (VAD reads the audio faster than real time, but still reads it after it is sent).
            const check = () => {
                clearTimeout(settle);

                if (sent && [...times.entries()].every(([id, time]) => time.end !== undefined && texts.has(id))) {
                    settle = setTimeout(() => finish(), this.#options.settleMs ?? SETTLE_MS);
                }
            };

            signal?.addEventListener("abort", onAbort);
            socket.on("error", (error) => finish(new Error(`Could not reach OpenAI's transcription: ${error.message}`)));
            socket.on("unexpected-response", (_request, response) => finish(new Error(`OpenAI refused the transcription (${response.statusCode}): is the ChatGPT (Codex) sign-in still good?`)));
            socket.on("close", () => finish(sent && times.size === texts.size ? undefined : new Error("OpenAI closed the transcription before it finished.")));
            socket.on("open", () => {
                const transcription = { model: settings.model, ...(settings.language === undefined ? {} : { language: settings.language }), ...(settings.prompt === undefined ? {} : { prompt: settings.prompt }) };

                socket.send(
                    JSON.stringify({
                        type: "session.update",
                        session: {
                            type: "transcription",
                            audio: { input: { format: { type: "audio/pcm", rate: PCM_RATE }, transcription, turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 500, prefix_padding_ms: 300 } } },
                        },
                    }),
                );

                for (let at = 0; at < pcm.length; at += BYTES_A_SECOND) {
                    socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.from(pcm.subarray(at, at + BYTES_A_SECOND)).toString("base64") }));
                }

                socket.send(JSON.stringify({ type: "input_audio_buffer.append", audio: Buffer.alloc(BYTES_A_SECOND * 2).toString("base64") }));
                sent = true;
                check();
            });
            socket.on("message", (data) => {
                const event = JSON.parse(String(data)) as { type: string; item_id?: string; audio_start_ms?: number; audio_end_ms?: number; transcript?: string; usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };

                if (event.type === "error") {
                    finish(new Error(`OpenAI's transcription: ${event.error?.message ?? "an error"}`));
                } else if (event.type === "input_audio_buffer.speech_started" && event.item_id !== undefined) {
                    times.set(event.item_id, { start: event.audio_start_ms ?? 0 });
                    check();
                } else if (event.type === "input_audio_buffer.speech_stopped" && event.item_id !== undefined) {
                    times.set(event.item_id, { start: times.get(event.item_id)?.start ?? 0, end: event.audio_end_ms ?? 0 });
                    check();
                } else if (event.type === "conversation.item.input_audio_transcription.completed" && event.item_id !== undefined) {
                    texts.set(event.item_id, event.transcript ?? "");
                    usage.input += event.usage?.input_tokens ?? 0;
                    usage.output += event.usage?.output_tokens ?? 0;
                    check();
                }
            });
        });
    }
}

/** ffmpeg's arguments for one part of a file's sound, from `start` for `seconds`, as 24 kHz mono pcm16 in a WAV. */
export function pcmPartArgs(input: string, out: string, start: number, seconds: number): string[] {
    return ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(seconds), "-i", input, "-vn", "-ac", "1", "-ar", String(PCM_RATE), "-c:a", "pcm_s16le", "-map_metadata", "-1", out];
}

/** A WAV's samples: what its `data` chunk holds (chunks before it skipped), or undefined when it is not a WAV. */
export function wavData(bytes: Uint8Array): Uint8Array | undefined {
    const ascii = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4));

    if (bytes.length < 12 || ascii(0) !== "RIFF" || ascii(8) !== "WAVE") {
        return undefined;
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let at = 12; at + 8 <= bytes.length; ) {
        const size = view.getUint32(at + 4, true);

        if (ascii(at) === "data") {
            return bytes.subarray(at + 8, Math.min(bytes.length, at + 8 + size));
        }

        at += 8 + size + (size % 2);
    }

    return undefined;
}

/** Subtitle cues: each utterance, split by words into cues of at most CUE_SECONDS and CUE_CHARS, times shared by length. */
export function cuesOf(utterances: readonly Utterance[]): Utterance[] {
    return utterances.flatMap((utterance) => {
        const words = utterance.text.split(/\s+/).filter((word) => word !== "");
        const length = utterance.end - utterance.start;
        const pieces = Math.max(1, Math.ceil(length / (CUE_SECONDS * 1000)), Math.ceil(utterance.text.length / CUE_CHARS));

        if (pieces === 1 || words.length < 2) {
            return [utterance];
        }

        const lines: string[][] = [];
        const target = utterance.text.length / pieces;
        let line: string[] = [];

        for (const word of words) {
            if (line.length > 0 && [...line, word].join(" ").length > target && lines.length < pieces - 1) {
                lines.push(line);
                line = [];
            }

            line.push(word);
        }

        lines.push(line);
        const total = lines.reduce((sum, each) => sum + each.join(" ").length, 0);
        let at = utterance.start;

        return lines.map((each, index) => {
            const start = at;

            at = index === lines.length - 1 ? utterance.end : Math.round(at + (length * each.join(" ").length) / total);

            return { start, end: at, text: each.join(" ") };
        });
    });
}

const clock = (ms: number, mark: "," | ".") => {
    const two = (value: number) => String(value).padStart(2, "0");
    const whole = Math.max(0, Math.round(ms));

    return `${two(Math.floor(whole / 3600000))}:${two(Math.floor(whole / 60000) % 60)}:${two(Math.floor(whole / 1000) % 60)}${mark}${String(whole % 1000).padStart(3, "0")}`;
};

/** Utterances as SRT subtitles. */
export function srtOf(utterances: readonly Utterance[]): string {
    return cuesOf(utterances)
        .map((cue, index) => `${index + 1}\n${clock(cue.start, ",")} --> ${clock(cue.end, ",")}\n${cue.text}\n`)
        .join("\n");
}

/** Utterances as WebVTT subtitles. */
export function vttOf(utterances: readonly Utterance[]): string {
    return `WEBVTT\n\n${cuesOf(utterances)
        .map((cue) => `${clock(cue.start, ".")} --> ${clock(cue.end, ".")}\n${cue.text}\n`)
        .join("\n")}`;
}
