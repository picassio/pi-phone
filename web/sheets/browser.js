// Pi's browser (src/server/browser/): the run model browser_run decides each step with. The owner's default for every
// session (this session's own model, or one of the Jev models OpenRouter offers, tested with one decision), and the
// session open now can have its own. And what the phone's browser does with a window a page opens (PP-249).
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { Choice, html, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

/** The run model in use now, as the default's detail. */
const nowText = (model, names) => (model === "session" ? t("now the session's own model, the setting for every session") : t("now {model}, the setting for every session", { model: names.get(model) ?? model }));

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
 * A run model's row: the app's dropdown, which saves when picked (the session's own model, a Jev model OpenRouter offers,
 * or the default for a session's own), and for a Jev model its cost and a test of one decision.
 */
function RunModelRow({ part, title, value, jev, global = null, onSave }) {
    const [test, setTest] = useState(null);
    const names = new Map((jev?.models ?? []).map((model) => [model.id, model.name]));
    const options = [
        ...(global !== null ? [{ value: "inherit", label: t("Default"), detail: nowText(global, names) }] : []),
        { value: "session", label: t("The session's own model"), detail: t("each session decides with its model") },
        ...(jev?.models ?? []).map((model) => ({ value: model.id, label: model.name, detail: model.id })),
    ];
    const chosen = value ?? "inherit";

    // A Jev model the list no longer has still shows as chosen.
    if (!options.some((option) => option.value === chosen)) {
        options.push({ value: chosen, label: chosen, detail: chosen });
    }

    const used = chosen === "inherit" ? global : chosen;
    const isJev = used !== null && used !== "session";

    return html`<div class="setting-row pb-run" data-part=${part}>
        <div class="field">
            <span>${title}</span>
            <span class="label">${t("Run model")}</span>
            <${Choice}
                label=${t("Run model")}
                value=${chosen}
                options=${options}
                onChange=${(next) => {
                    setTest(null);

                    if (next !== chosen) {
                        onSave(next);
                    }
                }}
            />
            ${jev?.error && html`<span class="small wiki-problem">${jev.error}</span>`}
            ${jev && !jev.error && !jev.signedIn && html`<span class="muted small">${t("Sign in to OpenRouter in Settings › Providers to use Jev.")}</span>`}
            ${
                isJev &&
                html`<span class="muted small">${t("About a second and $0.00003 a step. Needs your OpenRouter sign-in, with TypeSafe allowed in OpenRouter's settings (privacy, allowed providers).")}</span>
                    ${test && html`<span class=${`small ${test.error ? "wiki-problem" : "muted"}`}>${test.error ?? t("It answered {choice} in {ms} ms, for ${cost}.", { choice: test.choice, ms: test.ms, cost: test.cost.toFixed(6) })}</span>`}
                    <div class="sheet-actions">
                        <button
                            class="button small"
                            onClick=${async () => {
                                setTest(null);

                                try {
                                    setTest(await api("browser/run-model/test", { model: used }));
                                } catch (error) {
                                    setTest({ error: error.message });
                                }
                            }}
                        >
                            ${t("Test")}
                        </button>
                    </div>`
            }
        </div>
    </div>`;
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

/** Whether browser_eval runs scripts that read the page (PP-244): On or Off, saved when tapped. */
function EvalRow() {
    const [on, setOn] = useState(null);
    const choices = [
        [true, t("On")],
        [false, t("Off")],
    ];

    useEffect(() => {
        void attempt(async () => setOn((await api("browser/eval")).eval));
    }, []);

    if (on === null) {
        return html`<${Loader} label=${t("Reading the setting")} />`;
    }

    return html`<div class="sheet-list">
        <${Row}
            title=${t("Scripts that read the page")}
            detail=${on
                ? t("Pi may run a script that reads the page (its colours, fonts and spacing, or what is on it), in a world of its own with no cookies, storage or network, that changes nothing; what you type on a card reads as empty.")
                : t("browser_eval refuses: Pi reads pages only as their controls, text and pictures.")}
        >
            <div class="segmented">
                ${choices.map(
                    ([key, label]) =>
                        html`<button
                            class=${on === key ? "on" : ""}
                            aria-pressed=${on === key}
                            onClick=${() => key !== on && attempt(async () => setOn((await api("browser/eval", { eval: key }, { method: "PUT" })).eval))}
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
    const [jev, setJev] = useState(null);

    useEffect(() => {
        void attempt(async () => setGlobal((await api("browser/run-model")).model));
        api("browser/jev-models").then(setJev, (error) => setJev({ error: error.message }));

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
        <p class="muted small">
            ${t("computer_run decides each step of a goal in an app on your computer with the same run model, and sends it the window's title and text (its elements and their values) instead of a page's.")}
        </p>
        <div class="label">${t("Run model")}</div>
        ${
            global === null
                ? html`<${Loader} label=${t("Reading the setting")} />`
                : html`<div class="sheet-list">
                      <${RunModelRow}
                          part="browser-run-every"
                          title=${t("Every session")}
                          value=${global}
                          jev=${jev}
                          onSave=${(model) => attempt(async () => setGlobal((await api("browser/run-model", { model }, { method: "PUT" })).model))}
                      />
                      ${
                          own !== undefined &&
                          html`<${RunModelRow}
                              part="browser-run-session"
                              title=${t("This session")}
                              value=${own}
                              jev=${jev}
                              global=${global}
                              onSave=${(model) => attempt(async () => setOwn((await api(`c/${id}/browser-run-model`, { model })).own))}
                          />`
                      }
                  </div>`
        }
        <div class="label">${t("Windows on the phone")}</div>
        <${PopupsRow} />
        <div class="label">${t("Scripts")}</div>
        <${EvalRow} />
    <//>`;
}
