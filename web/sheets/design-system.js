// Menu › Design system (PP-241, src/server/design-systems.ts): the design system Pi designs pages, artifacts and Office
// files with unless asked otherwise, from OpenDesign's and the person's own, or none. Pi changes it with setting_change
// (design.default). Shown while the Design & video extension is on (PP-247).
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";
import { t } from "../i18n.js";

/** The systems with every word of `query` in their id, name, category or summary. */
function matching(systems, query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);

    return systems.filter((system) => {
        const text = `${system.id} ${system.name} ${system.category} ${system.summary}`.toLowerCase();

        return words.every((word) => text.includes(word));
    });
}

export function DesignSystemSheet() {
    const [state, setState] = useState(null);
    const [query, setQuery] = useState("");
    const load = () => api("design-systems").then(setState);

    useEffect(() => {
        attempt(load);
    }, []);

    const pick = (id) =>
        attempt(async () => {
            await api("settings", { designSystem: id });
            await load();
        });
    const row = (id, title, detail, category) => {
        const chosen = (state.chosen ?? null) === id;

        return html`<button class=${`list-item sg-pick ds-row ${chosen ? "on" : ""}`} aria-pressed=${chosen} data-part="design-system" onClick=${() => pick(id)}>
            <span class="ds-text">
                <span>${title}${category && html` <span class="muted small">· ${category}</span>`}</span>
                <span class="muted small">${detail}</span>
            </span>
            ${chosen && html`<span class="sg-check"><${Icon} name="check" size=${14} /></span>`}
        </button>`;
    };
    const shown = state === null ? [] : matching(state.systems, query);
    const chosen = state?.systems.find((system) => system.id === state.chosen);

    return html`<${Sheet} title=${t("Design system")} onClose=${closeSheet}>
        <p class="muted small">
            ${t("The look Pi uses for pages, artifacts, and Office files unless you ask for another: colours, fonts, and spacing. Ask Pi to make one of your own: yours come first.")}
        </p>
        ${!state && html`<${Loader} label=${t("Loading design systems")} />`}
        ${
            state &&
            html`${state.chosen !== null && !chosen && html`<p class="wiki-problem">${t("The design system {id} is gone; pick another or none.", { id: state.chosen })}</p>`}
                ${state.problems.map((problem) => html`<p class="wiki-problem mono small">${t("Not a design system: {problem}", { problem })}</p>`)}
                <label class="search">
                    <${Icon} name="search" size=${15} />
                    <input type="search" aria-label=${t("Search design systems")} placeholder=${t("Search design systems")} value=${query} onInput=${(event) => setQuery(event.currentTarget.value)} />
                </label>
                <div class="sheet-list">
                    ${query === "" && row(null, t("None"), t("Pi picks a look for each piece of work"))}
                    ${shown.map((system) => row(system.id, system.name, system.summary, system.mine ? t("yours") : system.category))}
                    ${shown.length === 0 && html`<div class="muted small">${t("No design system matches.")}</div>`}
                </div>`
        }
    <//>`;
}
