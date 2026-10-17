// Ports of a machine opened on this phone (src/server/forwards.ts): a dev server there shows in the phone's browser.
// One machine's, or every machine's; a port to open, and the ones open, each with Open and Close. Laid out as the
// Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { html, Loader, Sheet, timeAgo } from "../ui.js";

export function ForwardsSheet({ machineId }) {
    const machines = store.state.server?.machines ?? [];
    const [chosen, setChosen] = useState(machineId ?? machines[0]?.id ?? "");
    const [forwards, setForwards] = useState(null);
    const [port, setPort] = useState("");
    const [busy, setBusy] = useState(false);
    const load = async () => setForwards((await api("forwards")).forwards);
    const machine = machines.find((each) => each.id === chosen);

    useEffect(() => {
        attempt(load);
    }, []);

    const open = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const forward = await api("forwards", { machineId: chosen, port: Number(port) });

                setPort("");
                await load();
                window.open(forward.url, "_blank");
            } finally {
                setBusy(false);
            }
        });
    const close = (forward) =>
        attempt(async () => {
            await api(`forwards/${forward.id}`, undefined, { method: "DELETE" });
            await load();
        });

    return html`<${Sheet} title="Ports" onClose=${closeSheet}>
        <p class="muted small">
            A server running on a machine, such as a dev server on <span class="mono">localhost:5173</span> there, opens in this phone's browser through ssh. It stays open until you close it here.
        </p>
        ${machines.length === 0 && html`<p class="muted">Connect a machine first: Settings > Machines.</p>`}
        ${
            machines.length > 0 &&
            html`<form
                onSubmit=${(event) => {
                    event.preventDefault();
                    open();
                }}
            >
                ${
                    machines.length > 1 &&
                    html`<div class="field">
                        <div class="label">Machine</div>
                        <select value=${chosen} onChange=${(event) => setChosen(event.currentTarget.value)} aria-label="Machine">
                            ${machines.map((each) => html`<option value=${each.id}>${each.name}</option>`)}
                        </select>
                    </div>`
                }
                <div class="field">
                    <div class="label">Port on ${machine?.name ?? "the machine"}</div>
                    <input
                        class="mono"
                        type="number"
                        inputmode="numeric"
                        min="1"
                        max="65535"
                        placeholder="5173"
                        aria-label="Port"
                        value=${port}
                        onInput=${(event) => setPort(event.currentTarget.value)}
                    />
                </div>
                <div class="sheet-actions">
                    <button class="button primary" disabled=${busy || port === ""}>${busy ? "Opening…" : "Open"}</button>
                </div>
            </form>`
        }
        ${forwards === null && html`<${Loader} label="Loading ports" />`}
        ${
            forwards?.length > 0 &&
            html`<div class="sheet-list">
                ${forwards.map(
                    (forward) => html`<div class="provider" key=${forward.id}>
                        <div>
                            <div>${forward.machine} : ${forward.remotePort}</div>
                            <div class="muted small mono">${forward.url}</div>
                            <div class="muted small">open ${timeAgo(forward.startedAt)} ago</div>
                        </div>
                        <div class="provider-actions">
                            <a class="button small primary" href=${forward.url} target="_blank" rel="noopener">Open</a>
                            <button class="button small ghost" onClick=${() => close(forward)}>Close</button>
                        </div>
                    </div>`,
                )}
            </div>`
        }
    <//>`;
}
