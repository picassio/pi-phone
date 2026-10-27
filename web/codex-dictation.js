// Codex dictation (PP-190): the message box's mic with the dictation model on the owner's ChatGPT sign-in, in the shape
// of the browser's own SpeechRecognition (`voice.js` drives either the same way). The server mints a short-lived key for
// a transcription session (`POST /api/voice/dictation`); the page opens it over WebRTC itself (the key once, not kept)
// and turns its events into results: words as they come (`…transcription.delta`), settled when each piece is done
// (`…completed`). Its seconds are counted in Spend when it ends.
import { t } from "./i18n.js";
import { api } from "./store.js";

/** One piece of speech, as SpeechRecognition's results hold it: its words, and whether they are settled. */
const result = (text, isFinal) => Object.assign([{ transcript: text }], { isFinal });

export class CodexRecognition {
    lang = "";
    continuous = true;
    interimResults = true;
    onresult = null;
    onerror = null;
    onend = null;
    /** Pieces in the order spoken, by OpenAI's item id. */
    #items = [];
    #byId = new Map();
    #pc = null;
    #mic = null;
    #channel = null;
    #dictation = null;
    #ended = false;

    start() {
        this.#run().catch((error) => {
            this.onerror?.({ error: error?.message ?? String(error) });
            void this.#finish();
        });
    }

    async #run() {
        const started = await api("voice/dictation", {});

        this.#dictation = started.dictation;
        this.#mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });

        if (this.#ended) {
            this.#mic.getTracks().forEach((track) => track.stop());

            return;
        }

        const pc = new RTCPeerConnection();

        this.#pc = pc;
        this.#mic.getTracks().forEach((track) => pc.addTrack(track, this.#mic));
        this.#channel = pc.createDataChannel("oai-events");
        this.#channel.onmessage = (event) => {
            try {
                this.#receive(JSON.parse(event.data));
            } catch {
                // Not JSON: nothing to show.
            }
        };
        await pc.setLocalDescription(await pc.createOffer());

        const posted = await fetch(started.url, {
            method: "POST",
            headers: { authorization: `Bearer ${started.key}`, "content-type": "application/sdp" },
            body: pc.localDescription.sdp,
        });

        if (!posted.ok) {
            throw new Error(t("OpenAI did not take dictation ({status}).", { status: posted.status }));
        }

        await pc.setRemoteDescription({ type: "answer", sdp: await posted.text() });
    }

    #piece(id) {
        let piece = this.#byId.get(id);

        if (piece === undefined) {
            piece = { text: "", isFinal: false };
            this.#byId.set(id, piece);
            this.#items.push(piece);
        }

        return piece;
    }

    #receive(event) {
        if (event.type === "conversation.item.input_audio_transcription.delta") {
            this.#piece(event.item_id).text += event.delta ?? "";
        } else if (event.type === "conversation.item.input_audio_transcription.completed") {
            const piece = this.#piece(event.item_id);

            piece.text = String(event.transcript ?? piece.text);
            piece.isFinal = true;
        } else if (event.type === "error") {
            this.onerror?.({ error: event.error?.message ?? "error" });

            return;
        } else {
            return;
        }

        this.onresult?.({ results: this.#items.map((piece) => result(piece.text, piece.isFinal)) });
    }

    /** Stop listening: what was said last is written down first (a short wait), then it ends. */
    stop() {
        if (this.#channel?.readyState === "open") {
            this.#channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }

        this.#mic?.getAudioTracks().forEach((track) => (track.enabled = false));

        const started = Date.now();
        const wait = () => {
            const pending = this.#items.some((piece) => !piece.isFinal);

            if (pending && Date.now() - started < 2500 && !this.#ended) {
                setTimeout(wait, 100);
            } else {
                void this.#finish();
            }
        };

        setTimeout(wait, 150);
    }

    /** Stop now: what is not settled is dropped. */
    abort() {
        this.onresult = null;
        void this.#finish();
    }

    async #finish() {
        if (this.#ended) {
            return;
        }

        this.#ended = true;
        this.#channel?.close();
        this.#pc?.close();
        this.#mic?.getTracks().forEach((track) => track.stop());

        if (this.#dictation !== null) {
            await api(`voice/dictation/${this.#dictation}/end`, {}).catch(() => {});
        }

        this.onend?.();
    }
}
