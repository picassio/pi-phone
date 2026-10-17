// How many messages and new sessions Pi may send other sessions in an hour (src/server/session-control.ts): the
// owner's setting for every session, and this session's own (the setting, none, or a number of its own).
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet } from "../ui.js";

/** A limit as a person reads it. */
const limitText = (limit) => (limit === null ? "no limit" : `${limit} an hour`);

/** A limit's editor: a number an hour, or none. */
function LimitField({ label, value, onSave }) {
    const [none, setNone] = useState(value === null);
    const [number, setNumber] = useState(value === null ? "30" : String(value));
    const changed = none ? value !== null : Number(number) !== value;

    return html`<div class="field">
        <div class="label">${label}</div>
        <label class="check">
            <input type="checkbox" checked=${none} onChange=${(event) => setNone(event.currentTarget.checked)} /> No limit
        </label>
        ${
            !none &&
            html`<input
                class="mono"
                type="number"
                inputmode="numeric"
                min="1"
                max="10000"
                aria-label=${`${label}: an hour`}
                value=${number}
                onInput=${(event) => setNumber(event.currentTarget.value)}
            />`
        }
        <div class="sheet-actions">
            <button class="button small primary" disabled=${!changed} onClick=${() => onSave(none ? null : Number(number))}>Save</button>
        </div>
    </div>`;
}

export function SendLimitSheet() {
    const id = store.state.conversationId;
    const [status, setStatus] = useState(null);
    const load = async () => setStatus(await api(`c/${id}/send-limit`));

    useEffect(() => {
        attempt(load);
    }, [id]);

    const setOwn = (limit) =>
        attempt(async () => {
            await api(`c/${id}/send-limit`, { limit });
            await load();
        });
    const setGlobal = (limit) =>
        attempt(async () => {
            await api("settings", { sessionSendLimit: limit });
            await load();
        });

    return html`<${Sheet} title="Other sessions" onClose=${closeSheet}>
        <p class="muted small">
            Pi in a session can message, start, and stop other sessions for you (the sessions tools). A limit keeps two sessions from messaging each other without end.
        </p>
        ${status === null && html`<${Loader} label="Loading" />`}
        ${
            status &&
            html`<div class="sheet-list">
                <div class="provider">
                    <div>
                        <div>This session: ${limitText(status.limit)}</div>
                        <div class="muted small">
                            ${status.used} sent or started in the last hour · ${status.own ? "its own limit" : "the setting for all sessions"}
                        </div>
                    </div>
                    <div class="provider-actions">
                        ${status.own && html`<button class="button small ghost" onClick=${() => setOwn("inherit")}>Use the setting for all</button>`}
                    </div>
                </div>
                <div class="provider">
                    <${LimitField} key=${`own-${String(status.limit)}-${status.own}`} label="This session's own limit" value=${status.limit} onSave=${setOwn} />
                </div>
                <div class="provider">
                    <${LimitField} key=${`all-${String(status.global)}`} label="For all sessions" value=${status.global} onSave=${setGlobal} />
                </div>
            </div>`
        }
    <//>`;
}
