// Settings › Dictation: the language the mic listens for on this device (`android-speech.js`, `voice.js`). The phone's
// language unless one is picked; kept in this browser, as each device may speak its own.
import { useState } from "preact/hooks";
import { DICTATION_LANGUAGE_KEY } from "../android-speech.js";
import { closeSheet, notify } from "../store.js";
import { html, Sheet } from "../ui.js";

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
        notify("info", `Dictation listens for ${named(tag === "" ? phone : tag)}.`);
    };

    return html`<${Sheet} title="Dictation" onClose=${closeSheet}>
        <p class="muted small">
            Tap the mic beside Send and speak: words show in the message box as they are heard, and nothing is sent by
            itself. In the app, Android's own speech recognizer listens (Google's, as voice typing uses); in a browser, the
            browser's. This device keeps its own choice.
        </p>
        <div class="field">
            <div class="label">Language</div>
            <select value=${picked} onChange=${(event) => pick(event.currentTarget.value)}>
                <option value="">The phone's: ${named(phone)}</option>
                ${LANGUAGES.map((tag) => html`<option value=${tag}>${named(tag)}</option>`)}
            </select>
        </div>
    <//>`;
}
