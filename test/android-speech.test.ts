import assert from "node:assert/strict";
import { test } from "node:test";

type Event = { type: string; text?: string; error?: string };
type Results = { 0: { transcript: string }; isFinal: boolean }[];

/** Dictation.java, stood in: what the page asked of it. */
const asked: string[] = [];
const store = new Map<string, string>();

Object.assign(globalThis, {
    PiPhoneApp: {
        dictationAvailable: () => true,
        startDictation: (language: string) => asked.push(`start ${language}`),
        stopDictation: () => asked.push("stop"),
        abortDictation: () => asked.push("abort"),
    },
    localStorage: { getItem: (key: string) => store.get(key) ?? null },
});
Object.defineProperty(globalThis, "navigator", { value: { language: "vi-VN" }, configurable: true });

const speech = await import("../web/android-speech.js");
const say = (event: Event) => (globalThis as unknown as { __piPhoneSpeech: (event: Event) => void }).__piPhoneSpeech(event);

/** A recognition as voice.js makes one, and what it heard. */
function listen() {
    const recognition = new speech.AndroidSpeechRecognition();
    const heard: string[] = [];
    const errors: string[] = [];
    const ends: number[] = [];

    recognition.lang = "vi-VN";
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.onresult = ({ results }: { results: Results }) =>
        heard.push(results.map((each) => `${each[0].transcript}${each.isFinal ? "" : "…"}`).join(" | "));
    recognition.onerror = ({ error }: { error: string }) => errors.push(error);
    recognition.onend = () => ends.push(1);

    return { recognition, heard, errors, ends };
}

test("it stands in for SpeechRecognition only inside the app, and listens in the language picked, else the phone's", () => {
    assert.equal((globalThis as { SpeechRecognition?: unknown }).SpeechRecognition, undefined);
    speech.installAndroidSpeech();
    assert.equal((globalThis as { SpeechRecognition?: unknown }).SpeechRecognition, speech.AndroidSpeechRecognition);
    assert.equal(speech.dictationLanguage(), "vi-VN");
    store.set(speech.DICTATION_LANGUAGE_KEY, "en-US");
    assert.equal(speech.dictationLanguage(), "en-US");
    store.clear();
});

test("continuous dictation: Android's utterances one after another, every result kept, until a quiet one", () => {
    asked.length = 0;
    const { recognition, heard, errors, ends } = listen();

    recognition.start();
    assert.deepEqual(asked, ["start vi-VN"]);
    say({ type: "start" });
    say({ type: "partial", text: "xin" });
    say({ type: "partial", text: "xin chào" });
    say({ type: "final", text: "xin chào" });
    say({ type: "end" });
    assert.deepEqual(asked, ["start vi-VN", "start vi-VN"], "the next utterance starts by itself");
    say({ type: "start" });
    say({ type: "partial", text: "bạn khỏe" });
    say({ type: "final", text: "bạn khỏe không" });
    say({ type: "end" });
    say({ type: "start" });
    say({ type: "error", error: "no-speech" });
    say({ type: "end" });

    assert.deepEqual(heard, ["xin…", "xin chào…", "xin chào", "xin chào | bạn khỏe…", "xin chào | bạn khỏe không"]);
    assert.deepEqual(errors, [], "quiet after words is the end, not an error");
    assert.equal(ends.length, 1);
    assert.equal(asked.length, 3);
});

test("nothing heard says so; stop asks Android to finish; abort ends at once; a refused microphone is not-allowed", () => {
    asked.length = 0;
    const quiet = listen();

    quiet.recognition.start();
    say({ type: "error", error: "no-speech" });
    say({ type: "end" });
    assert.deepEqual(quiet.errors, ["no-speech"]);
    assert.equal(quiet.ends.length, 1);

    const stopped = listen();

    stopped.recognition.start();
    say({ type: "partial", text: "hello" });
    stopped.recognition.stop();
    assert.equal(asked.at(-1), "stop");
    say({ type: "final", text: "hello there" });
    say({ type: "end" });
    assert.deepEqual(stopped.heard, ["hello…", "hello there"]);
    assert.equal(stopped.ends.length, 1, "no next utterance after stop");

    const aborted = listen();

    aborted.recognition.start();
    aborted.recognition.abort();
    assert.equal(asked.at(-1), "abort");
    say({ type: "error", error: "aborted" });
    say({ type: "end" });
    assert.deepEqual(aborted.errors, [], "the app's own abort is no error");
    assert.equal(aborted.ends.length, 1);

    const refused = listen();

    refused.recognition.start();
    say({ type: "error", error: "not-allowed" });
    say({ type: "end" });
    assert.deepEqual(refused.errors, ["not-allowed"]);
    assert.equal(refused.ends.length, 1);
    assert.throws(() => {
        refused.recognition.start();
        refused.recognition.start();
    }, /Already listening/);
});
