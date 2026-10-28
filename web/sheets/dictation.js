// Settings › Dictation: the language the mic listens for on this device (`android-speech.js`, `voice.js`). The phone's
// language unless one is picked; kept in this browser, as each device may speak its own.
import { useState } from "preact/hooks";
import { DICTATION_LANGUAGE_KEY } from "../android-speech.js";
import { api, attempt, closeSheet, notify, openSheet, store } from "../store.js";
import { Choice, html, Sheet } from "../ui.js";
import { t } from "../i18n.js";

/** Languages Google's recognizer hears well, by BCP 47 tag; names come from the browser, in its own language. */
const LANGUAGES = [
    "vi-VN", "en-US", "en-GB", "en-AU", "en-IN", "zh-CN", "zh-TW", "yue-Hant-HK", "ja-JP", "ko-KR", "th-TH", "id-ID",
    "ms-MY", "fil-PH", "hi-IN", "fr-FR", "de-DE", "es-ES", "es-MX", "pt-BR", "pt-PT", "it-IT", "nl-NL", "pl-PL", "ru-RU",
    "uk-UA", "tr-TR", "ar-SA", "he-IL", "sv-SE", "nb-NO", "da-DK", "fi-FI", "cs-CZ", "el-GR", "hu-HU", "ro-RO",
];

const names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
const named = (tag) => {
    try {
        return `${names.of(tag)} (${tag})`;
    } catch {
        return tag;
    }
};

export function DictationSheet() {
    const [picked, setPicked] = useState(localStorage.getItem(DICTATION_LANGUAGE_KEY) ?? "");
    const phone = navigator.language || "en-US";
    const pick = (tag) => {
        if (tag === "") {
            localStorage.removeItem(DICTATION_LANGUAGE_KEY);
        } else {
            localStorage.setItem(DICTATION_LANGUAGE_KEY, tag);
        }

        setPicked(tag);
        notify("info", t("Dictation listens for {language}.", { language: named(tag === "" ? phone : tag) }));
        // Every device of theirs follows it, and Pi can read and set it (`dictation.language`, PP-235).
        void attempt(() => api("me", { dictation: tag === "" ? "auto" : tag }));
    };

    // Who listens (PP-190): the phone's or browser's recognizer, or Codex on the owner's ChatGPT sign-in (Settings › Voice).
    const voice = store.state.server?.voice;
    const codex = voice?.settings.engine === "codex";

    return html`<${Sheet} title=${t("Dictation")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("Tap the mic beside Send and speak: words show in the message box as they are heard, and nothing is sent by itself. In the app, Android's own speech recognizer listens (Google's, as voice typing uses); in a browser, the browser's. The language you pick here goes for all your devices.")}
        </p>
        ${
            voice &&
            html`<div class="field" data-part="dictation-engine">
                <div class="label">${t("Who listens")}</div>
                <div class="assistant-choice">
                    <div class="segmented" role="group" aria-label=${t("Who listens")}>
                        <button class=${codex ? "" : "on"} aria-pressed=${!codex} onClick=${() => attempt(() => api("settings", { voice: { engine: "android" } }))}>${t("Android's recognizer")}</button>
                        <button class=${codex ? "on" : ""} aria-pressed=${codex} onClick=${() => attempt(() => api("settings", { voice: { engine: "codex" } }))}>${t("Codex")}</button>
                    </div>
                    <p class="muted small">
                        ${codex ? t("Codex ({model}) on your ChatGPT sign-in; audio goes to OpenAI. Its model and language are in Settings › Voice.", { model: voice.settings.dictationModel }) : t("Free, as voice typing is. Codex is on your ChatGPT sign-in.")}
                        ${" "}
                        <button class="link small" onClick=${() => openSheet({ type: "voice" })}>${t("Voice settings")}</button>
                    </p>
                </div>
            </div>`
        }
        <div class="field">
            <div class="label">${t("Language")}</div>
            <${Choice}
                label=${t("Language")}
                value=${picked}
                options=${[{ value: "", label: t("The phone's: {language}", { language: named(phone) }) }, ...LANGUAGES.map((tag) => ({ value: tag, label: named(tag) }))]}
                onChange=${pick}
            />
        </div>
    <//>`;
}
