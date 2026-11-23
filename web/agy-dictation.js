// Dictation by Google Antigravity (PP-557): the message box's mic with agy's dictation model, on the owner's Google
// Antigravity sign-in, in the shape of the browser's own SpeechRecognition (`voice.js` drives it as it drives the
// others). Google's stream is gRPC with the sign-in's token, which never leaves the server: so the page records its mic
// as 16 kHz pcm16 (agy's format), posts it about four times a second (`POST /api/voice/agy-dictation/<id>/audio`), and
// shows what the server says was heard so far. Stopping posts the end, and the server's answer, once Google has read
// all the audio, is the settled text.
import { t } from "./i18n.js";
import { api } from "./store.js";

/** What was heard, as SpeechRecognition's results hold it: one piece, settled or not. */
const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });

export class AgyRecognition {
    lang = "";
    continuous = true;
    interimResults = true;
    onresult = null;
    onerror = null;
    onend = null;
    #id = null;
    #mic = null;
    #context = null;
    #node = null;
    /** Recorded pcm not posted yet, and the post under way. */
    #queue = [];
    #sending = null;
    #text = "";
    #stopping = false;
    #ended = false;

    start() {
        this.#run().catch((error) => this.#fail(error));
    }

    async #run() {
        const started = await api("voice/agy-dictation", {});

        this.#id = started.dictation;
        this.#mic = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

        if (this.#ended || this.#stopping) {
            this.#release();

            return;
        }

        // The browser resamples the mic to agy's rate.
        const context = new AudioContext({ sampleRate: started.rate });
        const source = context.createMediaStreamSource(this.#mic);
        const node = context.createScriptProcessor(4096, 1, 1);

        node.onaudioprocess = (event) => {
            if (this.#stopping || this.#ended) {
                return;
            }

            const input = event.inputBuffer.getChannelData(0);
            const pcm = new Int16Array(input.length);

            for (let index = 0; index < input.length; index++) {
                const sample = Math.max(-1, Math.min(1, input[index]));

                pcm[index] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
            }

            this.#queue.push(pcm);
            this.#pump();
        };
        source.connect(node);
        node.connect(context.destination);
        this.#context = context;
        this.#node = node;
        // Made after the tap's awaits: started here, as the page was tapped.
        await context.resume();
    }

    /** Post what was recorded, one post at a time, and show what Google heard so far. */
    #pump() {
        if (this.#sending !== null || this.#id === null || this.#queue.length === 0) {
            return this.#sending ?? Promise.resolve();
        }

        const chunks = this.#queue.splice(0);

        this.#sending = api(`voice/agy-dictation/${this.#id}/audio`, new Blob(chunks, { type: "application/octet-stream" }))
            .then((heard) => this.#show(heard.text, false))
            .catch((error) => this.#fail(error))
            .finally(() => {
                this.#sending = null;

                if (!this.#ended) {
                    this.#pump();
                }
            });

        return this.#sending;
    }

    #show(text, isFinal) {
        if (this.#ended || (text === this.#text && !isFinal)) {
            return;
        }

        this.#text = text;
        this.onresult?.({ results: text.trim() === "" ? [] : [result(text, isFinal)] });
    }

    /** Stop listening: the audio already recorded is posted, then the end; Google's settled text is shown, then it ends. */
    stop() {
        if (this.#stopping || this.#ended) {
            return;
        }

        this.#stopping = true;
        this.#release();

        void (async () => {
            if (this.#id === null) {
                await this.#finish(false);

                return;
            }

            while (this.#sending !== null || this.#queue.length > 0) {
                await this.#pump();
            }

            const end = await api(`voice/agy-dictation/${this.#id}/end`, {});

            this.#show(end.text, true);
            await this.#finish(false);
        })().catch((error) => this.#fail(error));
    }

    /** Stop now: what is not settled is dropped. */
    abort() {
        this.onresult = null;
        void this.#finish(true);
    }

    #fail(error) {
        if (!this.#ended) {
            this.onerror?.({ error: error?.message ?? String(error ?? t("Google Antigravity's dictation stopped.")) });
        }

        void this.#finish(true);
    }

    #release() {
        this.#node?.disconnect();
        this.#node = null;
        void this.#context?.close().catch(() => {});
        this.#context = null;
        this.#mic?.getTracks().forEach((track) => track.stop());
        this.#mic = null;
    }

    async #finish(drop) {
        if (this.#ended) {
            return;
        }

        this.#ended = true;
        this.#release();

        if (drop && this.#id !== null) {
            await api(`voice/agy-dictation/${this.#id}/end`, { drop: true }).catch(() => {});
        }

        this.onend?.();
    }
}
