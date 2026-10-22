// Compact context: now, with what the summary should keep; and when this session (or every session) compacts by itself
// (PP-78, src/server/auto-compact.ts): the setting for all, only when nearly full, or at a percentage of the context.
import { t, tn } from "../i18n.js";
import { useState } from "preact/hooks";
import { actions, api, attempt, closeSheet, store } from "../store.js";
import { html, Icon, Sheet } from "../ui.js";

const MIN = 10;
const MAX = 95;
/** A rule as a person reads it. */
const atText = (at) => (at === "full" ? t("only when nearly full") : t("at {n}% of the context", { n: at }));

/** One rule's choices: each a row, the chosen one ticked; a percentage typed in place. */
function AtChoices({ label, value, inherit, onPick }) {
    const [percent, setPercent] = useState(typeof value === "number" ? String(value) : "70");
    const number = Number(percent);
    const valid = Number.isInteger(number) && number >= MIN && number <= MAX;
    const row = (key, title, hint, chosen) => html`<button class=${`list-item sg-pick ${chosen ? "on" : ""}`} aria-pressed=${chosen} onClick=${() => onPick(key)}>
        <span>${title}</span>
        ${chosen ? html`<span class="sg-check"><${Icon} name="check" size=${14} /></span>` : html`<span class="muted small">${hint}</span>`}
    </button>`;

    return html`<div class="field">
        <div class="label">${label}</div>
        <div class="sheet-list">
            ${inherit !== undefined && row("inherit", t("The setting for all sessions"), atText(inherit), value === undefined)}
            ${row("full", t("Only when nearly full"), t("the default: just before the model's limit"), value === "full")}
            <div class=${`list-item ac-percent ${typeof value === "number" ? "on" : ""}`}>
                <span>${t("At")}</span>
                <input
                    class="mono"
                    type="number"
                    inputmode="numeric"
                    min=${MIN}
                    max=${MAX}
                    aria-label=${`${label}: percent of the context`}
                    value=${percent}
                    onInput=${(event) => setPercent(event.currentTarget.value)}
                    onKeyDown=${(event) => event.key === "Enter" && valid && onPick(number)}
                />
                <span>${t("% of the context")}</span>
                <button class="button small primary" disabled=${!valid || value === number} onClick=${() => onPick(number)}>
                    ${value === number ? html`<${Icon} name="check" size=${14} />` : t("Use")}
                </button>
            </div>
        </div>
    </div>`;
}

export function CompactSheet() {
    const { view, server, me } = store.state;
    const id = store.state.conversationId;
    const own = view.conversation?.compactAt;
    const all = server?.compactAt ?? "full";
    const [instructions, setInstructions] = useState("");

    const setOwn = (at) => attempt(() => api(`c/${id}/compact-at`, { at }));
    const setAll = (at) => attempt(() => api("settings", { compactAt: at }));
    const compact = () =>
        attempt(async () => {
            await actions.compact(instructions);
            closeSheet();
        });

    return html`<${Sheet} title=${t("Compact context")} onClose=${closeSheet}>
        <p class="muted small">${t("Compacting summarizes older messages, so the session stays quick and costs less. It happens by itself just before the model's limit; it can happen sooner, at a share of the context.")}</p>
        <${AtChoices} key=${`own-${String(own)}`} label=${t("This session compacts by itself")} value=${own} inherit=${all} onPick=${setOwn} />
        ${me?.role === "owner" && html`<${AtChoices} key=${`all-${String(all)}`} label=${t("Every session, unless it has its own")} value=${all} onPick=${setAll} />`}
        <div class="field">
            <div class="label">${t("Compact now: what should the summary keep? (optional)")}</div>
            <textarea rows="3" aria-label=${t("What should the summary keep?")} value=${instructions} placeholder=${t("e.g. the failing test names")} onInput=${(event) => setInstructions(event.currentTarget.value)}></textarea>
            <div class="sheet-actions">
                <button class="button primary" onClick=${compact}>${t("Compact now")}</button>
            </div>
        </div>
    <//>`;
}
