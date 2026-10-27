// Settings › Voice (PP-190): voice calls and Codex dictation on the owner's ChatGPT (Codex) sign-in. The live models are
// the ones the last check found for this sign-in, each with the way its calls are set up; a model, voice or language
// is checked with OpenAI before it is kept (the server says why it refuses one). Pi changes the same settings with
// its settings tools (`voice.*`).
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { Choice, html, Icon, Sheet, Switch } from "../ui.js";
import { VOICE_MODES } from "../voice-view.js";
import { deviceVoice } from "../voice-call.js";

/** Languages people pick most; any other two-letter code the model takes works through Pi's settings. */
const LANGUAGES = ["vi", "en", "zh", "ja", "ko", "th", "id", "fr", "de", "es", "pt", "ru"];

const names = new Intl.DisplayNames([navigator.language || "en"], { type: "language" });
const named = (code) => {
    try {
        return `${names.of(code)} (${code})`;
    } catch {
        return code;
    }
};

/** How each way of setting a call up reads. */
const PATHS = () => ({
    key: t("short-lived key"),
    server: t("through pi-phone"),
    codex: t("Codex's own · private"),
});

const minutes = (seconds) => Math.ceil(seconds / 60);

export function VoiceSheet() {
    const voice = store.state.server?.voice;
    const [usage, setUsage] = useState(null);
    const [checking, setChecking] = useState(false);
    const [cue, setCue] = useState(null);
    const [limit, setLimit] = useState(null);

    useEffect(() => {
        attempt(async () => setUsage((await api("voice")).usage));
    }, []);

    if (!voice) {
        return html`<${Sheet} title=${t("Voice")} onClose=${closeSheet}><p class="muted small">${t("Voice is the owner's.")}</p><//>`;
    }

    const { settings, check } = voice;
    const change = (patch) => attempt(() => api("settings", { voice: patch }));
    const checkAgain = () =>
        attempt(async () => {
            setChecking(true);

            try {
                await api("voice/check", {});
            } finally {
                setChecking(false);
            }
        });
    const segmented = (label, part, options, value, key) => html`<div class="assistant-choice" data-part=${part}>
        <div class="segmented" role="group" aria-label=${label}>
            ${options.map(
                ([option, text]) => html`<button class=${value === option ? "on" : ""} aria-pressed=${value === option} onClick=${() => change({ [key]: option })}>${text}</button>`,
            )}
        </div>
    </div>`;
    const live = check?.live ?? [];
    const when = check ? new Date(check.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : null;

    return html`<${Sheet} title=${t("Voice")} onClose=${closeSheet} className="phone-control-sheet assistant-sheet voice-sheet">
        <p class="muted small">
            ${t("Talk with Pi as on a call, with your ChatGPT (Codex) sign-in. Audio goes straight between this device and OpenAI; the sign-in stays on pi-phone's server.")}
        </p>

        <div class="phone-section-title">${t("Live model")}</div>
        ${
            live.length === 0
                ? html`<p class="muted small">${check ? t("No live model for this sign-in.") : t("Not checked yet: check which models your sign-in has.")}</p>`
                : html`<div class="sheet-list" data-part="voice-models">
                      ${live.map(
                          (model) => html`<button
                              class="list-item"
                              aria-pressed=${settings.model === model.id}
                              data-part="voice-model"
                              onClick=${() => settings.model !== model.id && change({ model: model.id })}
                          >
                              <span class=${settings.model === model.id ? "voice-chosen" : ""}>
                                  ${settings.model === model.id && html`<${Icon} name="check" size=${14} stroke=${2.4} />`} ${model.id}
                              </span>
                              <span class="muted small">${PATHS()[model.path] ?? model.path}</span>
                          </button>`,
                      )}
                  </div>`
        }
        ${
            live.some((model) => model.path === "codex") &&
            html`<p class="muted small">${t("gpt-live is Codex's own voice on ChatGPT's private endpoint: it hands work to Pi by itself, and may change without notice. Only used when picked here.")}</p>`
        }
        <div class="limit-wait-notice" data-part="voice-check">
            <div>
                <div class="small">${when ? t("Checked with your sign-in: {when}", { when }) : t("Not checked yet")}</div>
                ${check && check.hidden.length > 0 && html`<div class="muted small">${t("Not for this sign-in: {models}", { models: check.hidden.join(", ") })}</div>`}
            </div>
            <button class="button small" disabled=${checking} onClick=${checkAgain}>${checking ? t("Checking…") : check ? t("Check again") : t("Check")}</button>
        </div>

        <label class="assistant-field">
            <span class="muted small">${t("Voice")}</span>
            <${Choice}
                label=${t("Voice")}
                value=${settings.voice}
                options=${(voice.voices ?? [settings.voice]).map((each) => ({ value: each, label: each }))}
                onChange=${(value) => change({ voice: value })}
            />
            <span class="muted small">${t("Checked with the live model when you pick it.")}</span>
        </label>
        <label class="assistant-field">
            <span class="muted small">${t("Language")}</span>
            <${Choice}
                label=${t("Language")}
                value=${settings.language}
                options=${[{ value: "auto", label: t("Auto: the language you speak") }, ...LANGUAGES.map((code) => ({ value: code, label: named(code) }))]}
                onChange=${(value) => change({ language: value })}
            />
        </label>

        <div class="phone-section-title">${t("New sessions")}</div>
        ${segmented(t("Voice mode"), "voice-mode-default", VOICE_MODES(), settings.mode, "mode")}
        ${segmented(t("Turn-taking"), "voice-turns-default", [["hands-free", t("Hands-free")], ["hold", t("Hold to talk")]], settings.turns, "turns")}
        <p class="muted small">${t("A session can change its own in the model menu or in the call.")}</p>

        <div class="phone-section-title">${t("While Pi works")}</div>
        ${segmented(t("Progress"), "voice-progress", [["text", t("Pi's words as they come")], ["answer", t("Only the answer")]], settings.progress, "progress")}
        <label class="assistant-field">
            <span class="muted small">${t("A short cue on what Pi runs, at most every (seconds; 0 for none)")}</span>
            <input
                type="number"
                min="0"
                max="600"
                inputmode="numeric"
                data-part="voice-cue"
                value=${cue ?? settings.cueSeconds}
                onInput=${(event) => setCue(event.currentTarget.value)}
                onChange=${() => cue !== null && attempt(async () => {
                    await api("settings", { voice: { cueSeconds: Number(cue) } });
                    setCue(null);
                })}
            />
        </label>

        <div class="phone-section-title">${t("Who reads Pi's answers in Pi thinks")}</div>
        ${segmented(t("Reader"), "voice-reader", [["live", t("The live model")], ["device", t("This device's voice")]], settings.reader, "reader")}
        <p class="muted small" data-part="voice-reader-note">
            ${
                settings.reader === "device"
                    ? deviceVoice() === null
                        ? t("This device has no voice to read with: a call in Pi thinks does not start here.")
                        : t("Your phone's text-to-speech (the browser's on a computer) reads Pi's words; talking over it stops it.")
                    : t("The live model reads Pi's words as written, in its voice.")
            }
        </p>

        <div class="phone-section-title">${t("Dictation")}</div>
        ${segmented(t("Who listens to the mic"), "voice-engine", [["android", t("Android's recognizer")], ["codex", t("Codex")]], settings.engine, "engine")}
        <label class="assistant-field">
            <span class="muted small">${t("Codex dictation model, also used in calls")}</span>
            <${Choice}
                label=${t("Codex dictation model")}
                value=${settings.dictationModel}
                options=${(check?.dictation?.length ? check.dictation : [settings.dictationModel]).map((each) => ({ value: each, label: each }))}
                onChange=${(value) => change({ dictationModel: value })}
            />
        </label>

        <div class="phone-section-title">${t("Minutes")}</div>
        ${
            usage &&
            html`<p class="small" data-part="voice-usage">
                ${t("Today: {calls} min of calls, {dictation} min of dictation. This month: {month} min.", {
                    calls: minutes(usage.today.call),
                    dictation: minutes(usage.today.dictation),
                    month: minutes(usage.month.call + usage.month.dictation),
                })}
            </p>`
        }
        <div class="limit-wait-notice" data-part="voice-limit">
            <div>
                <div class="small">${t("A daily limit")}</div>
                <div class="muted small">${settings.dailyLimit === null ? t("None: voice counts on your ChatGPT plan.") : t("{n} minutes a day, calls and dictation together.", { n: settings.dailyLimit })}</div>
            </div>
            <${Switch}
                on=${settings.dailyLimit !== null}
                label=${t("A daily limit")}
                onChange=${() => change({ dailyLimit: settings.dailyLimit === null ? 60 : null })}
            />
        </div>
        ${
            settings.dailyLimit !== null &&
            html`<label class="assistant-field">
                <span class="muted small">${t("Minutes a day")}</span>
                <input
                    type="number"
                    min="1"
                    max="1440"
                    inputmode="numeric"
                    data-part="voice-limit-minutes"
                    value=${limit ?? settings.dailyLimit}
                    onInput=${(event) => setLimit(event.currentTarget.value)}
                    onChange=${() => limit !== null && attempt(async () => {
                        await api("settings", { voice: { dailyLimit: Number(limit) } });
                        setLimit(null);
                    })}
                />
            </label>`
        }
        <p class="muted small">
            ${t("Minutes are in Spend too. Pi can change these settings with your OK on a card.")}
            <button class="link small" onClick=${() => openSheet({ type: "spend" })}>${t("Spend")}</button>
        </p>
    <//>`;
}
