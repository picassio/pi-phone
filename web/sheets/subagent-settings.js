// The model and thinking level Pi starts subagents on (PP-281): every session's (Menu › Subagents), with the models Pi
// may also use when the person asks, each with its state and plan limit; and one session's own (from its menu), over
// every session's. Pi changes the same choices on a card (subagents.model, subagents.sessionModel, …).
import { useEffect } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, loadUsage, store } from "../store.js";
import { levelName } from "../subagents.js";
import { usageLine, usagePeak } from "../usage.js";
import { Choice, html, Icon, MultiChoice, Sheet } from "../ui.js";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const specOf = (model) => `${model.provider}/${model.id}`;

/** A model by `provider/id`, among those signed in. */
const modelOf = (spec) => store.state.models.find((model) => specOf(model) === spec);

/** A model's name for people: its own when signed in, else its id. */
const nameOf = (spec) => modelOf(spec)?.name ?? spec;

/** A model's facts in one line: provider, context, its account's plan figures. */
function factsOf(model) {
    const usage = usageLine(model.provider);

    return [
        model.provider,
        t("{n}k context", { n: Math.round(model.contextWindow / 1000) }),
        ...(model.signIn ? [t("sign in again: Settings › Providers")] : usage === undefined ? [] : [usage]),
    ].join(" · ");
}

/** What a part comes to for a session: its own, else every session's, else the session's own model or level. */
function resolved(part, own) {
    const all = store.state.server?.subagentDefaults ?? {};
    const value = own?.[part] ?? all[part];

    return value === undefined || value === "session" ? undefined : value;
}

/** The subagents' model and level in a few words, as the session's menu shows them: "GPT-6 mini · Low". */
export function subagentSummary(own) {
    const model = resolved("model", own);
    const thinking = resolved("thinking", own);

    return `${model === undefined ? t("the session's model") : nameOf(model)} · ${thinking === undefined ? t("its level") : levelName(thinking)}`;
}

/** The two dropdowns: model and thinking, with "As every session" first for one session's own. */
function Parts({ own, set }) {
    const { models, view } = store.state;
    const all = store.state.server?.subagentDefaults ?? {};
    const session = view.agent?.model;
    const sessionModel = session === undefined ? undefined : `${session.provider}/${session.modelId}`;
    const sessionLevel = view.agent?.thinkingLevel ?? "off";
    const forOne = own !== undefined;
    const inherit = (part, words) => (forOne ? [{ value: "inherit", label: t("As every session"), detail: words }] : []);
    const allModel = all.model === undefined ? t("The session's own") : nameOf(all.model);
    const allLevel = all.thinking === undefined ? t("The session's own") : levelName(all.thinking);

    return html`<div class="sam-parts">
        <div class="pp-row" data-part="subagent-model">
            <span>${t("Model")}</span>
            <div class="pp-choice">
                <${Choice}
                    label=${t("Subagents' model")}
                    value=${forOne ? (own.model ?? "inherit") : (all.model ?? "session")}
                    options=${[
                        ...inherit("model", allModel),
                        {
                            value: "session",
                            label: t("The session's own"),
                            detail: forOne && sessionModel !== undefined ? nameOf(sessionModel) : t("whatever the session runs on"),
                        },
                        ...models.map((model) => ({ value: specOf(model), label: model.name, detail: factsOf(model) })),
                    ]}
                    onChange=${(value) => set("model", value)}
                />
            </div>
        </div>
        <div class="pp-row" data-part="subagent-thinking">
            <span>${t("Thinking")}</span>
            <div class="pp-choice">
                <${Choice}
                    label=${t("Subagents' thinking level")}
                    value=${forOne ? (own.thinking ?? "inherit") : (all.thinking ?? "session")}
                    options=${[
                        ...inherit("thinking", allLevel),
                        {
                            value: "session",
                            label: t("The session's own"),
                            detail: forOne ? levelName(sessionLevel) : t("its level, never above it"),
                        },
                        ...LEVELS.map((level) => ({ value: level, label: levelName(level), ...(level === "low" ? { detail: t("quicker, cheaper") } : {}) })),
                    ]}
                    onChange=${(value) => set("thinking", value)}
                />
            </div>
        </div>
    </div>`;
}

/** How close an account is to its limit, for a row's bar. */
const levelOf = (percent) => (percent >= 90 ? "high" : percent >= 70 ? "near" : "low");

/** The models Pi may also use when the person asks: a row each with its state and limit, and Add for more. */
function Allowed() {
    const { models, server } = store.state;
    const allowed = server?.subagentModels ?? [];
    const save = (model, on) =>
        attempt(async () => {
            const answer = await api("subagent-models", { model, allowed: on });

            if (Array.isArray(answer?.subagentModels)) {
                store.set((state) => ({ server: { ...state.server, subagentModels: answer.subagentModels } }));
            }
        });
    const add = async (chosen) => {
        for (const model of chosen) {
            await save(model, true);
        }
    };

    return html`<div class="field" data-part="subagent-allowed">
        <div class="label sam-label"><span>${t("Models Pi may also use, when you ask")}</span><span class="muted">${allowed.length}</span></div>
        ${allowed.length === 0 && html`<p class="muted small">${t("None: Pi uses only the model above, unless you allow another on a card.")}</p>`}
        ${allowed.map((spec) => {
            const model = modelOf(spec);
            const peak = model === undefined ? undefined : usagePeak(model.provider);

            return html`<div class="sam-model" data-part="allowed-model" data-model=${spec}>
                <span class=${`sam-dot ${model === undefined || model.signIn ? "off" : peak !== undefined && peak >= 70 ? "near" : ""}`} aria-hidden="true"></span>
                <span class="sam-text">
                    <b>${nameOf(spec)}</b>
                    <small>${model === undefined ? t("{spec}: not signed in now", { spec }) : `${model.provider} · ${t("{n}k context", { n: Math.round(model.contextWindow / 1000) })} · ${model.levels.length > 1 ? t("thinking up to {level}", { level: levelName(model.levels.at(-1)) }) : t("no thinking")}`}</small>
                    ${
                        model !== undefined &&
                        peak !== undefined &&
                        html`<span class="sam-meter"><span class="sam-track"><i class=${levelOf(peak)} style=${`width:${Math.max(2, peak)}%`}></i></span><span>${usageLine(model.provider)}</span></span>`
                    }
                </span>
                <button class="icon-button" type="button" aria-label=${t("Take {model} off", { model: nameOf(spec) })} onClick=${() => save(spec, false)}>
                    <${Icon} name="close" size=${15} />
                </button>
            </div>`;
        })}
        <div class="sam-add">
            <${MultiChoice}
                label=${t("Add models")}
                placeholder=${t("Add models")}
                options=${models.map((model) => ({
                    value: specOf(model),
                    label: model.name,
                    group: model.provider,
                    chosen: allowed.includes(specOf(model)),
                    disabled: model.signIn === true,
                    detail: allowed.includes(specOf(model)) ? t("in the list") : factsOf(model),
                }))}
                onAdd=${(chosen) => void add(chosen)}
            />
        </div>
    </div>`;
}

/** Menu › Subagents (every session), or a session's own (`own`). */
export function SubagentSettingsSheet({ own }) {
    const { view } = store.state;
    const id = store.state.conversationId;
    const forOne = own === true;

    // The plan figures as they are now, for the rows and the dropdowns.
    useEffect(() => {
        void loadUsage(true);
    }, []);

    const set = (part, value) =>
        attempt(() => (forOne ? api(`c/${id}/subagent-defaults`, { part, value }) : api("settings", { subagentDefault: { part, value } })));

    return html`<${Sheet} title=${forOne ? t("Subagents of this session") : t("Subagents")} onClose=${closeSheet}>
        <p class="muted small">
            ${
                forOne
                    ? t("The model and thinking level of the subagents this session starts from now on. Those already running keep theirs.")
                    : t("The model and thinking level Pi starts subagents on, in every session unless the session has its own. Pi picks another only when you ask in the chat.")
            }
        </p>
        <div class="field">
            ${!forOne && html`<div class="label">${t("Every session")}</div>`}
            <${Parts} own=${forOne ? (view.conversation?.subagentDefaults ?? {}) : undefined} set=${set} />
        </div>
        ${!forOne && store.state.me?.role === "owner" && html`<${Allowed} />`}
        <p class="muted small">${t("A level above a model's highest becomes its highest. A model you name that is not in the list comes as a card first.")}</p>
    <//>`;
}
