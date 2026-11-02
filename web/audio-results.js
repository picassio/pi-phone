// What the audio tools leave in the chat (PP-307, the owner's mockup audio-sheet-mock): audio_speak's file in a player
// with its waveform (decoded in the page from the file), and audio_transcribe's first lines with their times, Copy and
// Open file.
import { useEffect, useRef, useState } from "preact/hooks";
import { actions, attempt, notify } from "./store.js";
import { downloadFile } from "./download.js";
import { copyText, html, Icon, openFile, videoUrl } from "./ui.js";
import { t } from "./i18n.js";

const BARS = 48;

/** A time as m:ss. */
const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** The loudest sample in each of BARS slices of the sound, 0 to 1; null while it decodes or when it cannot. */
async function peaksOf(url) {
    const data = await (await fetch(url)).arrayBuffer();
    const context = new OfflineAudioContext(1, 1, 24000);
    const sound = await context.decodeAudioData(data);
    const samples = sound.getChannelData(0);
    const step = Math.max(1, Math.floor(samples.length / BARS));
    const peaks = Array.from({ length: BARS }, (_, bar) => {
        let peak = 0;

        for (let at = bar * step; at < Math.min(samples.length, (bar + 1) * step); at += 16) {
            peak = Math.max(peak, Math.abs(samples[at]));
        }

        return peak;
    });
    const top = Math.max(...peaks, 0.01);

    return peaks.map((peak) => peak / top);
}

/** Save a file Pi made to the device (Downloads in the app), as the file viewer's Download does (the owner's ask). */
export function DownloadButton({ path, conversationId, compact = false }) {
    const name = path.split("/").pop();

    return html`<button
        class=${compact ? "icon-button made-download" : "button small ghost"}
        data-part="made-download"
        title=${t("Download")}
        aria-label=${t("Download {name}", { name })}
        onClick=${() => attempt(() => downloadFile(`api/c/${conversationId}/download?path=${encodeURIComponent(path)}`, name))}
    >
        <${Icon} name="download" size=${14} />${compact ? "" : ` ${t("Download")}`}
    </button>`;
}

/** audio_speak's file: play and pause, the waveform (tap to seek), the time and the file's name. */
export function MadeAudio({ audio, conversationId, voice }) {
    const url = videoUrl(audio.path, conversationId);
    const element = useRef(null);
    const [playing, setPlaying] = useState(false);
    const [at, setAt] = useState(0);
    const [peaks, setPeaks] = useState(null);
    const length = audio.duration ?? 0;

    useEffect(() => {
        let live = true;

        peaksOf(url).then(
            (found) => live && setPeaks(found),
            () => live && setPeaks(Array(BARS).fill(0.5)),
        );

        return () => {
            live = false;
        };
    }, [url]);

    const toggle = () => (element.current.paused ? element.current.play() : element.current.pause());
    const seek = (event) => {
        const box = event.currentTarget.getBoundingClientRect();

        element.current.currentTime = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width)) * (element.current.duration || length);
    };
    const done = length > 0 ? at / length : 0;

    return html`<figure class="made-audio" data-part="made-audio">
        <audio
            ref=${element}
            src=${url}
            preload="metadata"
            onPlay=${() => setPlaying(true)}
            onPause=${() => setPlaying(false)}
            onEnded=${() => setPlaying(false)}
            onTimeUpdate=${(event) => setAt(event.currentTarget.currentTime)}
        ></audio>
        <div class="made-audio-row">
            <button class="made-audio-play" data-part="audio-play" aria-label=${playing ? t("Pause") : t("Play")} onClick=${toggle}>
                <${Icon} name=${playing ? "pause" : "play"} size=${16} />
            </button>
            <div class="made-audio-wave" role="slider" aria-label=${t("Position")} aria-valuemin="0" aria-valuemax=${Math.round(length)} aria-valuenow=${Math.round(at)} onClick=${seek}>
                ${(peaks ?? Array(BARS).fill(0.15)).map((peak, index) => html`<i class=${index / BARS < done ? "on" : ""} style=${`height:${Math.round(12 + peak * 88)}%`}></i>`)}
            </div>
        </div>
        <figcaption class="muted small">
            <span>${clock(at)} / ${clock(length)}</span>
            <span class="made-audio-name">${[voice, audio.path.split("/").slice(-2).join("/")].filter(Boolean).join(" · ")}</span>
            <${DownloadButton} path=${audio.path} conversationId=${conversationId} compact=${true} />
        </figcaption>
    </figure>`;
}

/** audio_transcribe's transcript: its first lines with their times, how many more, Copy and Open file. */
export function MadeTranscript({ transcript, conversationId }) {
    const lines = Array.isArray(transcript.lines) ? transcript.lines : [];
    const more = (transcript.utterances ?? 0) - lines.length;
    const copy = () =>
        attempt(async () => {
            const file = await actions.view(transcript.path);

            await copyText(file.text);
            notify("info", t("Transcript copied"));
        });

    return html`<div class="made-transcript" data-part="made-transcript">
        ${lines.length === 0 && html`<p class="muted small">${t("No speech heard.")}</p>`}
        ${lines.map((line) => html`<p><span class="made-transcript-time">${clock(line.start / 1000)}</span>${line.text}</p>`)}
        ${more > 0 && html`<p class="muted small">${t("+ {count} more lines", { count: String(more) })}</p>`}
        <div class="made-transcript-actions">
            <button class="button small ghost" data-part="transcript-copy" onClick=${copy}><${Icon} name="copy" size=${14} /> ${t("Copy")}</button>
            <button class="button small ghost" data-part="transcript-open" onClick=${() => openFile(transcript.path)}><${Icon} name="external" size=${14} /> ${t("Open file")}</button>
            <${DownloadButton} path=${transcript.path} conversationId=${conversationId} />
        </div>
    </div>`;
}
