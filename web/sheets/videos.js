// Menu › Videos (PP-297, the owner's mockup videos-mock): the model Pi's video_ask watches videos with, from OpenRouter's
// models that take video, with their prices. Pi changes it with setting_change (video.askModel), and may name another
// model for one call. Videos Pi makes (PP-298) join this sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

/** Dollars per million tokens as a short price. */
const perMillion = (amount) => `$${amount < 1 ? amount.toFixed(2) : String(Math.round(amount * 100) / 100)}`;

export function VideosSheet() {
    const [state, setState] = useState(null);
    const load = () => api("videos").then(setState);

    useEffect(() => {
        attempt(load);
    }, []);

    const pick = (model) =>
        attempt(async () => {
            await api("videos/ask-model", { model }, { method: "PUT" });
            await load();
        });
    const row = (id, title, detail, chosen) =>
        html`<button class=${`list-item sg-pick ds-row ${chosen ? "on" : ""}`} aria-pressed=${chosen} data-part="video-ask-model" data-model=${id ?? "auto"} onClick=${() => pick(id)}>
            <span class="ds-text">
                <span>${title}</span>
                <span class="muted small">${detail}</span>
            </span>
            ${chosen && html`<span class="sg-check"><${Icon} name="check" size=${14} /></span>`}
        </button>`;
    const gone = state !== null && state.askModel !== null && !state.askModels.some((model) => model.id === state.askModel);

    return html`<${Sheet} title=${t("Videos")} onClose=${closeSheet}>
        <p class="muted small">${t("Through OpenRouter, on your key. Pi's video_ask watches a video (a file where the session works, or a YouTube address) with the model below and answers your question; long or large videos are shrunk first. The cost is in Spend.")}</p>
        ${!state && html`<${Loader} label=${t("Loading video models")} />`}
        ${
            state &&
            html`<div class="label">${t("Watching videos (video_ask)")}</div>
                ${gone && html`<p class="wiki-problem">${t("{id} does not take video on OpenRouter now; pick another or Automatic.", { id: state.askModel })}</p>`}
                ${state.problem && html`<p class="wiki-problem small" data-part="videos-problem">${state.problem}</p>`}
                ${
                    state.problem !== undefined && state.askModels.length === 0
                        ? html`<div class="sheet-actions"><button class="button small" onClick=${() => openSheet({ type: "providers" })}>${t("Providers")}</button></div>`
                        : html`<div class="sheet-list">
                              ${row(null, t("Automatic"), t("Now {model}", { model: state.askDefault }), state.askModel === null)}
                              ${state.askModels.map((model) =>
                                  row(model.id, model.name, html`<span class="mono">${model.id}</span>${model.price === undefined ? "" : html` · ${t("{price}/M in", { price: perMillion(model.price.input) })}`}`, state.askModel === model.id),
                              )}
                          </div>`
                }`
        }
    <//>`;
}
