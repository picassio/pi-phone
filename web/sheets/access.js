// Settings › Access (src/server/tailnet.ts): whether people on the owner's tailnet reach this phone, and where. The
// Tailscale app on the phone connects it to the tailnet; this only listens on its address, never on other networks.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, openSheet } from "../store.js";
import { copyText, html, Loader, Sheet, Switch } from "../ui.js";

export function AccessSheet() {
    const [state, setState] = useState(null);
    const [busy, setBusy] = useState(false);
    const load = () => api("access").then(setState);

    useEffect(() => {
        attempt(load);
        // The Tailscale app may connect or drop while this is open.
        const timer = setInterval(() => attempt(load), 5000);

        return () => clearInterval(timer);
    }, []);

    const toggle = (on) =>
        attempt(async () => {
            setBusy(true);

            try {
                setState(await api("access", { tailscale: on }, { method: "PUT" }));
            } finally {
                setBusy(false);
            }
        });

    return html`<${Sheet} title="Access" onClose=${closeSheet}>
        <p class="muted small">
            Let people on your Tailscale network open this phone's invite links. Connect the Tailscale app on this phone;
            pi-phone then listens on its Tailscale address too, and on no other network. Invite people from Settings › People.
        </p>
        ${!state && html`<${Loader} label="Loading" />`}
        ${
            state &&
            html`<div class="provider">
                <div class="grow">
                    <div>Tailscale</div>
                    <div class="muted small">
                        ${
                            !state.enabled
                                ? "Off: only this phone reaches pi-phone."
                                : state.url
                                  ? html`On: <span class="mono">${state.url}</span>`
                                  : "On, waiting for Tailscale."
                        }
                    </div>
                    ${state.problem && html`<p class="wiki-problem">${state.problem}</p>`}
                </div>
                <${Switch} on=${state.enabled} disabled=${busy} label="Reach over Tailscale" onChange=${() => toggle(!state.enabled)} />
            </div>
            ${
                state.url &&
                html`<div class="sheet-actions">
                    <button
                        class="button"
                        onClick=${() =>
                            copyText(state.url).then(
                                () => notify("info", "Address copied."),
                                () => notify("error", "Could not copy."),
                            )}
                    >
                        Copy address
                    </button>
                    <button class="button primary" onClick=${() => openSheet({ type: "people" })}>Invite someone</button>
                </div>`
            }`
        }
    <//>`;
}
