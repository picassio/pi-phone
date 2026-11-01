// Menu › Audio (PP-307, the owner's mockup audio-sheet-mock v3): the model audio_transcribe transcribes with, the one
// audio_speak reads aloud with, and its default voice, each a dropdown (the owner's call); the voice with a play
// button that reads a short sample once, then keeps it. Pi changes them with setting_change (audio.transcribeModel,
// audio.speakModel, audio.voice).
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { Choice, html, Icon, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

const DETAILS = {
    "gpt-4o-transcribe": "Most accurate",
    "gpt-4o-mini-transcribe": "Faster",
    "whisper-1": "Older",
    "gpt-realtime-mini": "Fast",
    "gpt-realtime": "More natural, slower",
};

export function AudioSheet() {
    const [state, setState] = useState(null);
    const [sampling, setSampling] = useState(false);
    const player = useRef(null);
    const load = () => api("audio").then(setState);

    useEffect(() => {
        attempt(load);
    }, []);

    const pick = (route, value) =>
        attempt(async () => {
            await api(`audio/${route}`, { value: value === "auto" ? null : value }, { method: "PUT" });
            await load();
        });
    const options = (list, fallback) => [
        { value: "auto", label: t("Automatic"), detail: t("Now {model}", { model: fallback }) },
        ...list.map((each) => ({ value: each, label: each, ...(DETAILS[each] === undefined ? {} : { detail: t(DETAILS[each]) }) })),
    ];
    const voice = state?.voice ?? state?.defaults.voice;
    const sample = () => {
        setSampling(true);
        player.current.src = `api/audio/sample?voice=${encodeURIComponent(voice)}`;
        player.current.play().catch(() => setSampling(false));
    };

    return html`<${Sheet} title=${t("Audio")} onClose=${closeSheet}>
        <p class="muted small">${t("audio_transcribe and audio_speak use your ChatGPT (Codex) sign-in, included in your plan. Transcripts are saved in transcripts/, audio in audio/, where the session works.")}</p>
        ${!state && html`<${Loader} label=${t("Loading audio settings")} />`}
        ${
            state &&
            html`${
                !state.signedIn &&
                html`<p class="wiki-problem small" data-part="audio-problem">${t("Audio needs the ChatGPT (Codex) sign-in: add it in Settings › Providers.")}</p>
                    <div class="sheet-actions"><button class="button small" onClick=${() => openSheet({ type: "providers" })}>${t("Providers")}</button></div>`
            }
                <div class="label">${t("Transcription model (audio_transcribe)")}</div>
                <div data-part="audio-transcribe-model">
                    <${Choice} label=${t("Transcription model")} value=${state.transcribeModel ?? "auto"} options=${options(state.transcribeModels, state.defaults.transcribeModel)} onChange=${(value) => pick("transcribe-model", value)} />
                </div>
                <div class="label">${t("Reading model (audio_speak)")}</div>
                <div data-part="audio-speak-model">
                    <${Choice} label=${t("Reading model")} value=${state.speakModel ?? "auto"} options=${options(state.speakModels, state.defaults.speakModel)} onChange=${(value) => pick("speak-model", value)} />
                </div>
                <div class="label">${t("Default voice")}</div>
                <div class="audio-voice-row" data-part="audio-voice">
                    <${Choice} label=${t("Default voice")} value=${state.voice ?? "auto"} options=${options(state.voices, state.defaults.voice)} onChange=${(value) => pick("voice", value)} />
                    <button class="button small ghost" data-part="audio-sample" disabled=${sampling || !state.signedIn} aria-label=${t("Play a sample of {voice}", { voice })} onClick=${sample}>
                        <${Icon} name=${sampling ? "pause" : "play"} size=${14} /> ${t("Sample")}
                    </button>
                </div>
                <p class="muted small">${t("The sample is read in your language by the reading model once, then kept.")}</p>
                <audio ref=${player} onEnded=${() => setSampling(false)} onError=${() => setSampling(false)} onPause=${() => setSampling(false)}></audio>`
        }
    <//>`;
}
