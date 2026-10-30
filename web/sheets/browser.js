// Pi's browser (src/server/browser/): the run model browser_run decides each step with. The owner's default for every
// session (this session's own model, or a Jev model through OpenRouter, tested with one decision), and the session open
// now can have its own. And what the phone's browser does with a window a page opens (PP-249: browser.popups).
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

export const JEV_DEFAULT = "typesafe/jev-1.13";

/** A run model as a person reads it. */
export const runModelText = (model) => (model === "session" ? t("the session's own model") : t("Jev ({model})", { model }));

/** The run model in use now, as a row's detail: "the default" when a session has none of its own. */
const nowText = (model, isDefault = false) =>
    model === "session"
        ? isDefault
            ? t("Now the session's own model, the default")
            : t("Now the session's own model")
        : isDefault
          ? t("Now Jev ({model}), the default", { model })
          : t("Now Jev ({model})", { model });

/** A setting's row, as the Appearance sheet draws them: what it is on the left, its control on the right. */
function Row({ title, detail, children }) {
    return html`<div class="setting-row">
        <div class="setting-text">
            <span>${title}</span>
            ${detail && html`<span>${detail}</span>`}
        </div>
        ${children}
    </div>`;
}

/**
 * A run model's rows: a segmented choice that saves when tapped (the session's model, or the default for a session's
 * own), and for Jev a row with its OpenRouter id, a test, and Save.
 */
function RunModelRows({ title, detail, value, onSave, inherit = false }) {
    const kind = value === null ? "inherit" : value === "session" ? "session" : "jev";
    const [choice, setChoice] = useState(kind);
    const [model, setModel] = useState(kind === "jev" ? value : JEV_DEFAULT);
    const [test, setTest] = useState(null);
    const choices = [...(inherit ? [["inherit", t("Default")]] : []), ["session", t("Session model")], ["jev", "Jev"]];
    const pick = (next) => {
        setChoice(next);
        setTest(null);

        if (next !== "jev" && next !== kind) {
            onSave(next);
        }
    };

    return html`<${Row} title=${title} detail=${detail}>
            <div class="segmented">
                ${choices.map(
                    ([key, label]) => html`<button class=${choice === key ? "on" : ""} aria-pressed=${choice === key} onClick=${() => pick(key)}>${label}</button>`,
                )}
            </div>
        <//>
        ${
            choice === "jev" &&
            html`<div class="setting-row pb-jev">
                <div class="field">
                    <span class="label">${t("Jev model (OpenRouter id)")}</span>
                    <input class="mono" value=${model} placeholder=${JEV_DEFAULT} onInput=${(event) => setModel(event.currentTarget.value)} />
                    <span class="muted small">${t("About a second and $0.00003 a step. Needs your OpenRouter sign-in, with TypeSafe allowed in OpenRouter's settings (privacy, allowed providers).")}</span>
                    ${test && html`<span class=${`small ${test.error ? "wiki-problem" : "muted"}`}>${test.error ?? t("It answered {choice} in {ms} ms, for ${cost}.", { choice: test.choice, ms: test.ms, cost: test.cost.toFixed(6) })}</span>`}
                    <div class="sheet-actions">
                        <button
                            class="button small"
                            disabled=${model.trim() === ""}
                            onClick=${async () => {
                                setTest(null);

                                try {
                                    setTest(await api("browser/run-model/test", { model: model.trim() }));
                                } catch (error) {
                                    setTest({ error: error.message });
                                }
                            }}
                        >
                            ${t("Test")}
                        </button>
                        <button class="button small primary" disabled=${model.trim() === "" || model.trim() === value} onClick=${() => onSave(model.trim())}>${t("Save")}</button>
                    </div>
                </div>
            </div>`
        }`;
}

/** What the phone's browser does with a window a page opens (a sign-in popup): a segmented choice that saves when tapped. */
function PopupsRow() {
    const [popups, setPopups] = useState(null);
    const choices = [
        ["allow", t("Allow")],
        ["ask", t("Ask")],
        ["off", t("Off")],
    ];
    const details = {
        allow: t("A window a page opens, such as a sign-in popup, becomes a tab in front; the page can talk to it."),
        ask: t("You answer a card before a window a page opens becomes a tab."),
        off: t("Pages get no windows: a sign-in that opens one does not work."),
    };

    useEffect(() => {
        void attempt(async () => setPopups((await api("browser/popups")).popups));
    }, []);

    if (popups === null) {
        return html`<${Loader} label=${t("Reading the setting")} />`;
    }

    return html`<div class="sheet-list">
        <${Row} title=${t("Windows pages open")} detail=${details[popups]}>
            <div class="segmented">
                ${choices.map(
                    ([key, label]) =>
                        html`<button
                            class=${popups === key ? "on" : ""}
                            aria-pressed=${popups === key}
                            onClick=${() => key !== popups && attempt(async () => setPopups((await api("browser/popups", { popups: key }, { method: "PUT" })).popups))}
                        >
                            ${label}
                        </button>`,
                )}
            </div>
        <//>
    </div>`;
}

export function BrowserSheet() {
    const conversation = store.state.view.conversation;
    const id = store.state.conversationId;
    const [global, setGlobal] = useState(null);
    const [own, setOwn] = useState(undefined);

    useEffect(() => {
        void attempt(async () => setGlobal((await api("browser/run-model")).model));

        if (id !== null && conversation?.kind === "session") {
            void attempt(async () => setOwn((await api(`c/${id}/browser-run-model`)).own));
        }
    }, [id]);

    return html`<${Sheet} title=${t("Pi's browser")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("browser_run carries out a goal in Pi's browser on its own, deciding each step with the run model: the session's own model, or Jev, a small, fast decision model.")}
        </p>
        <p class="muted small">
            ${t("Each step sends the run model the goal, the values Pi gave (a secret by its name only), the page's address, title and visible text, and its controls with their values: with Jev, to OpenRouter (openrouter.ai) with your OpenRouter key; with the session's model, to its provider. A run clicks and types without asking, on pages you may be signed in to.")}
        </p>
        <div class="label">${t("Run model")}</div>
        ${
            global === null
                ? html`<${Loader} label=${t("Reading the setting")} />`
                : html`<div class="sheet-list">
                      <${RunModelRows}
                          key=${global}
                          title=${t("Every session")}
                          detail=${nowText(global)}
                          value=${global}
                          onSave=${(model) => attempt(async () => setGlobal((await api("browser/run-model", { model }, { method: "PUT" })).model))}
                      />
                      ${
                          own !== undefined &&
                          html`<${RunModelRows}
                              key=${String(own)}
                              title=${t("This session")}
                              detail=${nowText(own ?? global, own === null)}
                              value=${own}
                              inherit=${true}
                              onSave=${(model) => attempt(async () => setOwn((await api(`c/${id}/browser-run-model`, { model })).own))}
                          />`
                      }
                  </div>`
        }
        <div class="label">${t("Windows on the phone")}</div>
        <${PopupsRow} />
    <//>`;
}
