// Types for android-speech.js, for the tests (the web app itself has no build step).
type SpeechResult = { 0: { transcript: string; confidence: number }; isFinal: boolean };

export class AndroidSpeechRecognition {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onstart: ((event: object) => void) | null;
    onresult: ((event: { results: SpeechResult[]; resultIndex: number }) => void) | null;
    onerror: ((event: { error: string }) => void) | null;
    onend: ((event: object) => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
    hear(event: { type: string; text?: string; error?: string }): void;
}

export function installAndroidSpeech(): void;
export const DICTATION_LANGUAGE_KEY: string;
export function dictationLanguage(): string;
