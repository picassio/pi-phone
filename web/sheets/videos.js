// Menu › Videos (PP-297, PP-298; the owner's mockup videos-mock): the model Pi's video_generate makes videos with, and
// the one its video_ask watches them with, from OpenRouter's models, with their prices. Pi changes them with
// setting_change (video.model, video.askModel), and may name another model for one call.
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

    const pick = (route, model) =>
        attempt(async () => {
            await api(route, { model }, { method: "PUT" });
            await load();
        });
    const row = (part, route, id, title, detail, chosen) =>
        html`<button class=${`list-item sg-pick ds-row ${chosen ? "on" : ""}`} aria-pressed=${chosen} data-part=${part} data-model=${id ?? "auto"} onClick=${() => pick(route, id)}>
            <span class="ds-text">
                <span>${title}</span>
                <span class="muted small">${detail}</span>
            </span>
            ${chosen && html`<span class="sg-check"><${Icon} name="check" size=${16} /></span>`}
        </button>`;
    const gone = state !== null && state.askModel !== null && !state.askModels.some((model) => model.id === state.askModel);
    const makeGone = state !== null && state.model !== null && !state.makeModels.some((model) => model.id === state.model);
    // A price a second, with sound beside it when the model says; by tokens, said so.
    const perSecond = (model) =>
        model.perSecond === undefined && model.withAudio === undefined
            ? t("priced by tokens")
            : [model.perSecond === undefined ? "" : t("{price}/s", { price: `$${model.perSecond}` }), model.withAudio === undefined ? "" : t("{price}/s with sound", { price: `$${model.withAudio}` })].filter(Boolean).join(", ");
    const what = (model) => [model.resolutions.join(", "), model.durations.length === 0 ? "" : t("{from}-{to} s", { from: String(Math.min(...model.durations)), to: String(Math.max(...model.durations)) })].filter(Boolean).join(" · ");

    return html`<${Sheet} title=${t("Videos")} onClose=${closeSheet}>
        <p class="muted small">${t("Through OpenRouter, on your key. Videos Pi makes are saved in the session's folder (videos/) and shown in the chat; their cost is in Spend.")}</p>
        ${!state && html`<${Loader} label=${t("Loading video models")} />`}
        ${
            state &&
            html`${state.problem && html`<p class="wiki-problem small" data-part="videos-problem">${state.problem}</p>`}
                ${
                    state.problem !== undefined && state.askModels.length === 0 && state.makeModels.length === 0
                        ? html`<div class="sheet-actions"><button class="button small" onClick=${() => openSheet({ type: "providers" })}>${t("Providers")}</button></div>`
                        : html`<div class="label">${t("Making videos (video_generate)")}</div>
                              ${makeGone && html`<p class="wiki-problem">${t("{id} does not make videos on OpenRouter now; pick another or Automatic.", { id: state.model })}</p>`}
                              <div class="sheet-list">
                                  ${row("video-model", "videos/model", null, t("Automatic"), t("Now {model}", { model: state.makeDefault }), state.model === null)}
                                  ${state.makeModels.map((model) =>
                                      row("video-model", "videos/model", model.id, model.name, html`<span class="mono">${model.id}</span> · ${perSecond(model)}${what(model) === "" ? "" : html` · ${what(model)}`}`, state.model === model.id),
                                  )}
                              </div>
                              <div class="label">${t("Watching videos (video_ask)")}</div>
                              <p class="muted small">${t("video_ask watches a video (a file where the session works, or a YouTube address) and answers your question; long or large videos are shrunk first.")}</p>
                              ${gone && html`<p class="wiki-problem">${t("{id} does not take video on OpenRouter now; pick another or Automatic.", { id: state.askModel })}</p>`}
                              <div class="sheet-list">
                                  ${row("video-ask-model", "videos/ask-model", null, t("Automatic"), t("Now {model}", { model: state.askDefault }), state.askModel === null)}
                                  ${state.askModels.map((model) =>
                                      row("video-ask-model", "videos/ask-model", model.id, model.name, html`<span class="mono">${model.id}</span>${model.price === undefined ? "" : html` · ${t("{price}/M in", { price: perMillion(model.price.input) })}`}`, state.askModel === model.id),
                                  )}
                              </div>`
                }`
        }
    <//>`;
}
