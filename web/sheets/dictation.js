// Menu › Dictation: who listens to the message box's mic, and the language it listens for. The language is Settings ›
// Voice's, one setting for Voice and dictation (the owner: two were confusing): Auto, or a language. Android's recognizer
// detects Auto among the phone's languages (Android 14 and later); Codex hears it itself.
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { Choice, html, Sheet } from "../ui.js";
import { t } from "../i18n.js";
import { LANGUAGES, named } from "./voice.js";

export function DictationSheet() {
    // Who listens (PP-190): the phone's or browser's recognizer, or Codex on the owner's ChatGPT sign-in (Settings › Voice).
    const voice = store.state.server?.voice;
    const codex = voice?.settings.engine === "codex";
    const language = voice?.settings.language ?? "auto";

    return html`<${Sheet} title=${t("Dictation")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("Tap the mic beside Send and speak: words show in the message box as they are heard, and nothing is sent by itself. In the app, Android's own speech recognizer listens (Google's, as voice typing uses); in a browser, the browser's.")}
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
                        ${codex ? t("Codex ({model}) on your ChatGPT sign-in; audio goes to OpenAI.", { model: voice.settings.dictationModel }) : t("Free, as voice typing is. Codex is on your ChatGPT sign-in.")}
                        ${" "}
                        <button class="link small" onClick=${() => openSheet({ type: "voice" })}>${t("Voice settings")}</button>
                    </p>
                </div>
            </div>`
        }
        <div class="field" data-part="dictation-language">
            <div class="label">${t("Language")}</div>
            <${Choice}
                label=${t("Language")}
                value=${language}
                options=${[{ value: "auto", label: t("Auto: the language you speak") }, ...LANGUAGES.map((code) => ({ value: code, label: named(code) }))]}
                onChange=${(value) => attempt(() => api("settings", { voice: { language: value } }))}
            />
            <p class="muted small">
                ${
                    language !== "auto"
                        ? t("The same as Settings › Voice › Language: one setting for Voice and dictation.")
                        : codex
                          ? t("Codex hears the language you speak, mixed languages too. The same as Settings › Voice › Language.")
                          : t("Android's recognizer picks among your phone's languages (Android 14 and later; add English in Android's language settings to be heard in both). The same as Settings › Voice › Language.")
                }
            </p>
        </div>
    <//>`;
}
