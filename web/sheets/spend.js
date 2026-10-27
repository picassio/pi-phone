// Spend: what each session and person cost, and their limits.
import { useEffect, useRef, useState } from "preact/hooks";
import { api, attempt, closeSheet, openSheet, store } from "../store.js";
import { html, Icon, Loader, Sheet } from "../ui.js";
import { t, tn, tx } from "../i18n.js";

const money = (amount) => `$${amount.toFixed(2)}`;
const largest = (rows) => rows.reduce((max, row) => Math.max(max, row.spent), 1);

/** A spend limit, and (for the owner) a way to change it. */
function SpendLimit({ budget, editable, save }) {
    const [draft, setDraft] = useState(null);
    const field = useRef(null);
    const change = useRef(null);
    const edited = useRef(false);
    const editing = draft !== null;

    // Into the field as it opens; back to Change as it closes, so the keyboard keeps its place.
    useEffect(() => {
        if (editing) {
            field.current?.focus();
        } else if (edited.current) {
            change.current?.focus();
        }

        edited.current = editing;
    }, [editing]);

    if (draft === null) {
        return html`<span class="muted small">
            ${budget === undefined ? t("no limit") : t("limit {amount}", { amount: money(budget) })}
        </span>
        ${
            editable
                ? html`<button
                    class="link small spend-change"
                    ref=${change}
                    onClick=${() => setDraft(budget === undefined ? "" : String(budget))}
                >
                    ${t("Change")}
                </button>`
                : html`<span class="spend-change" aria-hidden="true"></span>`
        }`;
    }

    const done = (value) =>
        attempt(async () => {
            await save(value);
            setDraft(null);
        });

    return html`<span class="limit-edit">
        $<input type="number" inputmode="decimal" min="0.01" step="0.01" aria-label=${t("Limit in dollars")} ref=${field} value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} onKeyDown=${(
            event,
        ) => {
            // Esc lets go of the limit, not the whole sheet.
            if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(null);
            }
        }} />
        <button
            class="button small primary"
            disabled=${!(Number(draft) > 0)}
            onClick=${() => done(Number(draft))}
        >
            ${t("Set")}
        </button>
        ${
            budget !== undefined &&
            html`<button class="button small ghost" onClick=${() => done(null)}>${t("No limit")}</button>`
        }
        <button class="icon-button" aria-label=${t("Cancel")} onClick=${() => setDraft(null)}>
            <${Icon} name="close" size=${16} />
        </button>
    </span>`;
}

/** Usage against a limit, or the largest spend in the group when there is no limit. */
function Usage({ row, max }) {
    const percent = Math.min(100, Math.max(0, (row.spent / (row.budget ?? max)) * 100));

    return html`<span
        class=${`spend-usage ${row.budget !== undefined && percent >= 80 ? "warn" : ""}`}
        style=${`--usage:${percent}%`}
        aria-hidden="true"
    ><span></span></span>`;
}

/** What Pi spent, by person and by session, with the owner's limits. */
export function SpendSheet() {
    const owner = store.state.me?.role === "owner";
    const [data, setData] = useState(null);

    useEffect(() => {
        attempt(async () => setData(await api("spend")));
    }, []);
    const save = (target) => async (budget) => setData(await api("spend", { ...target, budget }));
    const peopleMax = largest(data?.people ?? []);
    const sessionsMax = largest(data?.sessions ?? []);

    return html`<${Sheet} title=${t("Spend")} onClose=${closeSheet} wide=${true}>
        ${data === null && html`<${Loader} label=${t("Adding it up")} />`}
        ${
            data?.total !== undefined &&
            html`<p class="spend-total">
                ${tx("Pi spent {amount} on this server so far.", { amount: html`<strong>${money(data.total)}</strong>` }).map((piece) =>
                    typeof piece === "string" ? html`<span>${piece.trim()}</span>` : piece,
                )}
            </p>`
        }
        ${
            data?.wiki &&
            html`<div class="group">
                <div class="group-title">${t("Wiki and documents")}</div>
                <div class="sheet-list">
                    <div class="spend-row">
                        <span class="grow">
                            ${t("Search by meaning and image descriptions")}
                            <small class="muted spend-sub">${tn(data.wiki.requests, "{n} request · {tokens} tokens · since {date}", "{n} requests · {tokens} tokens · since {date}", { tokens: data.wiki.tokens.toLocaleString(), date: new Date(data.wiki.since).toLocaleDateString() })}</small>
                        </span>
                        <span class="mono">${data.wiki.cost > 0 && data.wiki.cost < 0.01 ? `${data.wiki.cost.toFixed(4)}` : money(data.wiki.cost)}</span>
                    </div>
                </div>
                <p class="muted small">${t("Indexing pages and each search by meaning (OpenRouter): counted in the total, not in anyone's limit.")}</p>
            </div>`
        }
        ${
            // Voice on the ChatGPT sign-in (PP-190): minutes, counted on the plan, not in dollars.
            data?.voice &&
            html`<div class="group" data-part="spend-voice">
                <div class="group-title">${t("Voice (ChatGPT sign-in)")}</div>
                <div class="sheet-list">
                    <div class="spend-row">
                        <span class="grow">
                            ${t("Calls")}
                            <small class="muted spend-sub">${t("today {today} min · this month {month} min", { today: Math.ceil(data.voice.today.call / 60), month: Math.ceil(data.voice.month.call / 60) })}</small>
                        </span>
                        <span class="mono">${t("{n} min", { n: Math.ceil(data.voice.today.call / 60) })}</span>
                    </div>
                    <div class="spend-row">
                        <span class="grow">
                            ${t("Dictation (Codex)")}
                            <small class="muted spend-sub">${t("today {today} min · this month {month} min", { today: Math.ceil(data.voice.today.dictation / 60), month: Math.ceil(data.voice.month.dictation / 60) })}</small>
                        </span>
                        <span class="mono">${t("{n} min", { n: Math.ceil(data.voice.today.dictation / 60) })}</span>
                    </div>
                    <div class="spend-row">
                        <span class="grow">${t("Daily limit")}</span>
                        <span class="mono">${data.voice.limit === null ? t("none") : t("{n} min", { n: data.voice.limit })}</span>
                        <button class="button small ghost" onClick=${() => openSheet({ type: "voice" })}>${t("Change")}</button>
                    </div>
                </div>
                <p class="muted small">${t("Counted on your ChatGPT plan in minutes, not in the money above. No limit unless you set one.")}</p>
            </div>`
        }
        <p class="muted small">
            ${t("Spend goes to whoever asked for the work. Past a limit, Pi takes no new messages there, a run that crosses it stops, and subagents' reports wait until it is raised.")}
        </p>
        ${
            data &&
            html`<div class="group">
                <div class="group-title">${t("People")}</div>
                <div class="sheet-list">
                    ${data.people.map(
                        (person) => html`<div class="spend-row" key=${person.id}>
                            <span class="grow">${person.name}</span>
                            <${Usage} row=${person} max=${peopleMax} />
                            <span class="mono">${money(person.spent)}</span>
                            <${SpendLimit}
                                budget=${person.budget}
                                editable=${owner && person.id !== store.state.me?.id}
                                save=${save({ person: person.id })}
                            />
                        </div>`,
                    )}
                </div>
            </div>
            <div class="group">
                <div class="group-title">${t("Sessions")}</div>
                <div class="sheet-list">
                    ${data.sessions.map(
                        (session) => html`<div class="spend-row" key=${session.id}>
                            <span class="grow">${session.title}</span>
                            <${Usage} row=${session} max=${sessionsMax} />
                            <span class="mono">${money(session.spent)}</span>
                            <${SpendLimit}
                                budget=${session.budget}
                                editable=${owner}
                                save=${save({ session: session.id })}
                            />
                        </div>`,
                    )}
                </div>
            </div>`
        }
    <//>`;
}
