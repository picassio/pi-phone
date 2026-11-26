// Menu › Images (PP-275, src/server/image-gen.ts): the model Pi's image_generate makes and edits images with, from the
// providers signed in (ChatGPT, OpenRouter, your own providers' models marked as making images), with OpenRouter's
// prices. Pi changes it with setting_change (image.model), and may name another model for one call.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

/** Dollars per million tokens as a short price. */
const perMillion = (amount) => `$${amount < 1 ? amount.toFixed(2) : String(Math.round(amount * 100) / 100)}`;

/**
 * A model as people see it: ChatGPT's by what it is (PP-481: its route picks the model and quality itself, so its id
 * openai-codex/gpt-image-2.5 names no model), any other by its name, or by its id when only that is known.
 */
export function imageModelTitle(model) {
    return isCodex(model.id.split("/")[0]) ? t("ChatGPT Images (ChatGPT picks the model and quality)") : (model.name ?? model.id);
}

/** ChatGPT's original account, or one more of it (`openai-codex~<slug>`, src/server/accounts.ts). */
const isCodex = (provider) => provider === "openai-codex" || provider.startsWith("openai-codex~");

/** A model's price, as OpenRouter gives it, or where it is paid. */
function priceOf(model) {
    if (isCodex(model.provider)) {
        return t("on your ChatGPT plan");
    }

    if (isAgy(model.provider)) {
        return t("on your Google Antigravity plan");
    }

    if (model.price?.imageOut !== undefined) {
        return t("{price}/M image tokens out", { price: perMillion(model.price.imageOut) });
    }

    return model.provider === "openrouter" ? t("price not listed") : t("your provider's price");
}

/** Google Antigravity's original account, or one more of it (`google-antigravity~<slug>`, src/server/accounts.ts). */
const isAgy = (provider) => provider === "google-antigravity" || provider.startsWith("google-antigravity~");

/** Who a model is from, as a group's title; one more account of a provider with its name. */
const providerTitle = (provider, account) =>
    isCodex(provider)
        ? account === undefined
            ? t("ChatGPT sign-in")
            : t("ChatGPT sign-in · {account}", { account })
        : provider === "openrouter"
          ? "OpenRouter"
          : isAgy(provider)
            ? account === undefined
                ? t("Google Antigravity sign-in")
                : t("Google Antigravity sign-in · {account}", { account })
            : provider;

export function ImagesSheet() {
    const [state, setState] = useState(null);
    const load = () => api("images").then(setState);

    useEffect(() => {
        attempt(load);
    }, []);

    const pick = (model) =>
        attempt(async () => {
            await api("images/model", { model }, { method: "PUT" });
            await load();
        });
    const row = (id, title, detail, chosen) =>
        html`<button class=${`list-item sg-pick ds-row ${chosen ? "on" : ""}`} aria-pressed=${chosen} data-part="image-model" data-model=${id ?? "auto"} onClick=${() => pick(id)}>
            <span class="ds-text">
                <span>${title}</span>
                <span class="muted small">${detail}</span>
            </span>
            ${chosen && html`<span class="sg-check"><${Icon} name="check" size=${16} /></span>`}
        </button>`;
    const groups = state === null ? [] : [...new Set(state.models.map((model) => model.provider))];
    const gone = state !== null && state.model !== null && !state.models.some((model) => model.id === state.model);

    return html`<${Sheet} title=${t("Images")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("The model Pi's image_generate makes and edits images with. Pi saves them in the session's folder (images/) and shows them in the chat. Pi may use another model for one image when you ask.")}
        </p>
        ${!state && html`<${Loader} label=${t("Loading image models")} />`}
        ${
            state &&
            html`${gone && html`<p class="wiki-problem">${t("The image model {id} is not signed in now; pick another or Automatic.", { id: state.model })}</p>`}
                ${state.problems.map((problem) => html`<p class="wiki-problem small">${problem}</p>`)}
                ${
                    state.models.length === 0
                        ? html`<p class="muted small" data-part="images-empty">${t("No provider makes images yet: sign in to ChatGPT or OpenRouter, or mark a model of your own provider as making images.")}</p>
                              <div class="sheet-actions"><button class="button small" onClick=${() => openSheet({ type: "providers" })}>${t("Providers")}</button></div>`
                        : html`<div class="sheet-list">
                              ${row(null, t("Automatic"), state.default === null ? t("ChatGPT's when you are signed in, else OpenRouter's first") : t("Now {model}", { model: imageModelTitle({ id: state.default }) }), state.model === null)}
                          </div>
                          ${groups.map(
                              (provider) => html`<div class="label">${providerTitle(provider, state.models.find((model) => model.provider === provider)?.account)}</div>
                                  ${provider === "openai-codex" && html`<p class="muted small" data-part="images-codex-note">${t("On the ChatGPT sign-in, ChatGPT picks the image model and the quality itself; no setting here changes them.")}</p>`}
                                  <div class="sheet-list">
                                      ${state.models
                                          .filter((model) => model.provider === provider)
                                          .map((model) =>
                                              row(
                                                  model.id,
                                                  imageModelTitle(model),
                                                  isCodex(provider) ? priceOf(model) : html`<span class="mono">${model.model}</span> · ${priceOf(model)}`,
                                                  state.model === model.id,
                                              ),
                                          )}
                                  </div>`,
                          )}`
                }`
        }
    <//>`;
}
