// Pi's browser (src/server/browser/): the run model browser_run decides each step with. The owner's default for every
// session (this session's own model, or a Jev model through OpenRouter, tested with one decision), and the session open
// now can have its own.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

export const JEV_DEFAULT = "typesafe/jev-1.13";

/** A run model as a person reads it. */
export const runModelText = (model) => (model === "session" ? "the session's own model" : `Jev (${model})`);

/** A run model's editor: the session's model, or a Jev model by its OpenRouter id, with a test. */
function RunModelField({ value, onSave, allowInherit = false }) {
    const kind = value === null ? "inherit" : value === "session" ? "session" : "jev";
    const [choice, setChoice] = useState(kind);
    const [model, setModel] = useState(kind === "jev" ? value : JEV_DEFAULT);
    const [test, setTest] = useState(null);
    const next = choice === "inherit" ? "inherit" : choice === "session" ? "session" : model.trim();
    const changed = next !== (value ?? "inherit");

    return html`<div class="field">
        ${
            allowInherit &&
            html`<label class="check"><input type="radio" name=${`rm-${allowInherit}`} checked=${choice === "inherit"} onChange=${() => setChoice("inherit")} /> The default for every session</label>`
        }
        <label class="check"><input type="radio" name=${`rm-${allowInherit}`} checked=${choice === "session"} onChange=${() => setChoice("session")} /> The session's own model</label>
        <label class="check"><input type="radio" name=${`rm-${allowInherit}`} checked=${choice === "jev"} onChange=${() => setChoice("jev")} /> Jev, through OpenRouter</label>
        ${
            choice === "jev" &&
            html`<input class="mono" value=${model} aria-label="Jev model's OpenRouter id" placeholder=${JEV_DEFAULT} onInput=${(event) => setModel(event.currentTarget.value)} />
                <p class="muted small">
                    TypeSafe's decision model: about a third of a second and $0.0002 a step. It needs your OpenRouter sign-in, with TypeSafe allowed in
                    OpenRouter's settings (privacy, allowed providers).
                </p>`
        }
        ${test && html`<p class=${`small ${test.error ? "wiki-problem" : "muted"}`}>${test.error ?? `It answered ${test.choice} in ${test.ms} ms, for $${test.cost.toFixed(6)}.`}</p>`}
        <div class="sheet-actions">
            ${
                choice === "jev" &&
                html`<button
                    class="button small"
                    onClick=${async () => {
                        setTest(null);

                        try {
                            setTest(await api("browser/run-model/test", { model: model.trim() }));
                        } catch (error) {
                            setTest({ error: error.message });
                        }
                    }}
                >
                    Test
                </button>`
            }
            <button class="button small primary" disabled=${!changed || next === ""} onClick=${() => onSave(next)}>Save</button>
        </div>
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

    return html`<${Sheet} title="Pi's browser" onClose=${closeSheet}>
        <p class="muted small">
            browser_run carries out a goal in Pi's browser on its own, a step at a time. Each step is decided by the run model: the session's own model (no
            other model, slower), or Jev, a small decision model made for this.
        </p>
        ${
            global === null
                ? html`<${Loader} label="Reading the setting" />`
                : html`<div class="group">
                      <div class="group-title">Every session</div>
                      <${RunModelField} key=${global} value=${global} onSave=${(model) => attempt(async () => setGlobal((await api("browser/run-model", { model }, { method: "PUT" })).model))} />
                  </div>`
        }
        ${
            own !== undefined &&
            html`<div class="group">
                <div class="group-title">This session</div>
                <${RunModelField}
                    key=${String(own)}
                    value=${own}
                    allowInherit="session"
                    onSave=${(model) => attempt(async () => setOwn((await api(`c/${id}/browser-run-model`, { model })).own))}
                />
                <p class="muted small">Now: ${runModelText(own ?? global ?? "session")}.</p>
            </div>`
        }
    <//>`;
}
