// Ports of a machine opened on this phone (src/server/forwards.ts): a dev server there shows in the phone's browser.
// One machine's, or every machine's; a port to open, and the ones open, each with Open and Close. Laid out as the
// Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { Choice, html, Loader, Sheet, timeAgo } from "../ui.js";
import { t, tx } from "../i18n.js";

export function ForwardsSheet({ machineId }) {
    const machines = store.state.server?.machines ?? [];
    const [chosen, setChosen] = useState(machineId ?? machines[0]?.id ?? "");
    // In the store: the server sends every change (one that ended by itself too), so an open sheet stays right (PP-108).
    const forwards = store.state.forwards;
    const [port, setPort] = useState("");
    const [busy, setBusy] = useState(false);
    const load = async () => store.set({ forwards: (await api("forwards")).forwards });
    const machine = machines.find((each) => each.id === chosen);

    useEffect(() => {
        attempt(load);
    }, []);

    // In a browser the window opens in the tap itself, before anything is awaited, since one opened later is blocked
    // (PP-109); it goes to the port once ssh listens, and closes if the port could not open. Blocked anyway, the list's
    // Open is there. The phone app (`PiPhoneApp`) blocks nothing and hands an address to the phone's browser as it loads,
    // so it opens the port's address once it is known, as before.
    const open = () => {
        const inApp = globalThis.PiPhoneApp !== undefined;
        const tab = inApp ? null : window.open("about:blank", "_blank");

        return attempt(async () => {
            setBusy(true);

            try {
                const forward = await api("forwards", { machineId: chosen, port: Number(port) });

                setPort("");
                await load();

                if (inApp) {
                    window.open(forward.url, "_blank");
                } else if (tab !== null) {
                    tab.location.href = forward.url;
                }
            } catch (error) {
                tab?.close();

                throw error;
            } finally {
                setBusy(false);
            }
        });
    };
    const close = (forward) =>
        attempt(async () => {
            await api(`forwards/${forward.id}`, undefined, { method: "DELETE" });
            await load();
        });

    return html`<${Sheet} title=${t("Ports")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("A server running on a machine, such as a dev server on {address} there, opens in this phone's browser through ssh. It stays open until you close it here.", {
                address: html`<span class="mono">localhost:5173</span>`,
            })}
        </p>
        ${machines.length === 0 && html`<p class="muted">${t("Connect a machine first: Settings > Machines.")}</p>`}
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
                        <div class="label">${t("Machine")}</div>
                        <${Choice}
                            label=${t("Machine")}
                            value=${chosen}
                            options=${machines.map((each) => ({ value: each.id, label: each.name }))}
                            onChange=${setChosen}
                        />
                    </div>`
                }
                <div class="field">
                    <div class="label">${machine?.name !== undefined ? t("Port on {machine}", { machine: machine.name }) : t("Port on the machine")}</div>
                    <input
                        class="mono"
                        type="number"
                        inputmode="numeric"
                        min="1"
                        max="65535"
                        placeholder="5173"
                        aria-label=${t("Port")}
                        value=${port}
                        onInput=${(event) => setPort(event.currentTarget.value)}
                    />
                </div>
                <div class="sheet-actions">
                    <button class="button primary" disabled=${busy || port === ""}>${busy ? t("Opening…") : t("Open")}</button>
                </div>
            </form>`
        }
        ${forwards === null && html`<${Loader} label=${t("Loading ports")} />`}
        ${
            forwards?.length > 0 &&
            html`<div class="sheet-list">
                ${forwards.map(
                    (forward) => html`<div class="provider" key=${forward.id}>
                        <div>
                            <div>${forward.machine} : ${forward.remotePort}</div>
                            <div class="muted small mono">${forward.url}</div>
                            <div class="muted small">${t("open {time} ago", { time: timeAgo(forward.startedAt) })}</div>
                        </div>
                        <div class="provider-actions">
                            <a class="button small primary" href=${forward.url} target="_blank" rel="noopener">${t("Open")}</a>
                            <button class="button small ghost" onClick=${() => close(forward)}>${t("Close")}</button>
                        </div>
                    </div>`,
                )}
            </div>`
        }
    <//>`;
}
