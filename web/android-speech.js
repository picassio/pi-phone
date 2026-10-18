// The Web Speech API's SpeechRecognition, in the Android app, on Android's own recognizer (Dictation.java): WebView has
// none of its own. `voice.js` uses it as it would Chrome's. Android hears one utterance per start; while dictating
// continuously this starts it again after each, and keeps every result heard so far, as Chrome does.

/** The app's bridge, when this page is in the Android app and Android has a recognizer. */
const bridge = () => {
    const app = globalThis.PiPhoneApp;

    return typeof app?.dictationAvailable === "function" && app.dictationAvailable() ? app : undefined;
};

/** The one recognition listening now: Android's recognizer hears one at a time. */
let active = null;

globalThis.__piPhoneSpeech = (event) => active?.hear(event);

/** One result as the Web Speech API gives it: alternatives by index, and whether it is settled. */
const result = (transcript, isFinal) => Object.assign([{ transcript, confidence: 1 }], { isFinal });

export class AndroidSpeechRecognition {
    lang = "";
    continuous = false;
    interimResults = false;
    onstart = null;
    onresult = null;
    onerror = null;
    onend = null;
    /** Settled results so far, and the words still coming. */
    #finals = [];
    #partial = "";
    /** Whether `stop()` or `abort()` was asked: no further utterance starts. */
    #stopping = false;
    #started = false;
    /** Whether anything was heard in the utterance listening now. */
    #heardNow = false;

    start() {
        const app = bridge();

        if (!app) {
            throw new Error("Dictation is not available on this phone.");
        }

        if (this.#started) {
            throw new Error("Already listening.");
        }

        active?.abort();
        active = this;
        this.#started = true;
        this.#stopping = false;
        this.#finals = [];
        this.#partial = "";
        this.#listen(app, true);
    }

    stop() {
        if (active !== this) {
            return;
        }

        this.#stopping = true;
        bridge()?.stopDictation();
    }

    abort() {
        if (active !== this) {
            return;
        }

        this.#stopping = true;
        this.#partial = "";
        bridge()?.abortDictation();
    }

    #first = true;

    #listen(app, first) {
        this.#first = first;
        this.#heardNow = false;
        app.startDictation(this.lang || navigator.language || "en-US");
    }

    #results() {
        const all = this.#finals.map((text) => result(text, true));

        if (this.interimResults && this.#partial !== "") {
            all.push(result(this.#partial, false));
        }

        return all;
    }

    #deliver() {
        const results = this.#results();

        this.onresult?.({ results, resultIndex: Math.max(0, results.length - 1) });
    }

    /** An event from Dictation.java. */
    hear(event) {
        if (event.type === "start") {
            if (this.#first) {
                this.onstart?.({});
            }

            return;
        }

        if (event.type === "partial") {
            this.#heardNow = true;
            this.#partial = event.text;
            this.#deliver();

            return;
        }

        if (event.type === "final") {
            this.#partial = "";

            if (event.text.trim() !== "") {
                this.#heardNow = true;
                this.#finals.push(event.text);
            }

            this.#deliver();

            return;
        }

        if (event.type === "error") {
            // Quiet after words already heard: the person finished. Only a dictation that heard nothing says so.
            const quiet = event.error === "no-speech" && this.#finals.length > 0;

            if (!quiet && !(this.#stopping && event.error === "aborted")) {
                this.onerror?.({ error: event.error });
            }

            this.#stopping = true;

            return;
        }

        if (event.type === "end") {
            const app = bridge();

            // Continuous: the next utterance, until stopped, an error, or one that heard nothing.
            if (this.continuous && !this.#stopping && this.#heardNow && app) {
                this.#listen(app, false);

                return;
            }

            if (this.#partial !== "") {
                this.#partial = "";
                this.#deliver();
            }

            active = null;
            this.#started = false;
            this.onend?.({});
        }
    }
}

/**
 * Inside the Android app, Android's recognizer replaces the WebView's: WebView has a `webkitSpeechRecognition` that
 * exists but never listens (every start ends in "not-allowed"), so both names become this one.
 */
export function installAndroidSpeech() {
    if (bridge()) {
        globalThis.SpeechRecognition = AndroidSpeechRecognition;
        globalThis.webkitSpeechRecognition = AndroidSpeechRecognition;
    }
}

/** The language dictation listens for on this device: the one picked in Settings, else the phone's. */
export const DICTATION_LANGUAGE_KEY = "pi-phone.dictation-language";

export function dictationLanguage() {
    return localStorage.getItem(DICTATION_LANGUAGE_KEY) || navigator.language || "en-US";
}
