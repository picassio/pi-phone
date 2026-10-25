// Menu › Phone control (PP-141): setting this phone up for Pi to use its apps (src/server/phone-control.ts), the apps Pi
// never touches, and the devices. The setup steps open Android's settings through the app's shell (`window.PiPhoneApp`,
// MainActivity's bridge), only inside the app; their marks come from the app's service, through the server, so they
// show anywhere. Only the owner changes the Never list, here: no tool changes it.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, store } from "../store.js";
import { clockTime, html, Icon, Loader, Sheet } from "../ui.js";

/** What the server says of an app on the built-in lists (`neverReason`), by group. */
const GROUP_OF = { "a banking or payment app": "banking", "a password manager or authenticator": "passwords" };

function Step({ number, done, title, text, open }) {
    return html`<li class=${`phone-step ${done ? "done" : ""}`} data-part="phone-step">
        <span class="phone-step-mark" role="img" aria-label=${done ? t("done") : number}>${done ? html`<${Icon} name="check" size=${14} />` : number}</span>
        <div class="phone-step-text">
            <div>${title}</div>
            <div class="muted small">${text}</div>
        </div>
        ${open && html`<button class=${`button small ${done ? "ghost" : "primary"}`} onClick=${open}>${t("Open")}</button>`}
    </li>`;
}

export function PhoneControlSheet() {
    const app = window.PiPhoneApp;
    const [state, setState] = useState(null);
    const [apps, setApps] = useState(null);
    const [adding, setAdding] = useState(false);
    const [filter, setFilter] = useState("");
    const load = () =>
        attempt(async () => {
            const loaded = await api("phone-control");

            setState(loaded);

            if (loaded.present && loaded.status !== null) {
                setApps((await api("phone-control/apps")).apps);
            }
        });

    useEffect(() => {
        load();
        // Back from Android's settings, the marks may have changed.
        const again = () => load();

        addEventListener("focus", again);

        return () => removeEventListener("focus", again);
    }, []);

    const openSettings = (which) => app?.openSettings && (() => app.openSettings(which));
    const never = (body) =>
        attempt(async () => {
            const saved = await api("phone-control/never", body);

            setState((was) => ({ ...was, never: saved.never }));
            setApps((await api("phone-control/apps")).apps);
        });

    if (state === null) {
        return html`<${Sheet} title=${t("Phone control")} onClose=${closeSheet}><${Loader} /><//>`;
    }

    const status = state.status;
    const enabled = status?.enabled === true;
    const restricted = status !== null && status.android >= 33;
    const own = state.never.own;
    const counts = { banking: 0, passwords: 0 };

    for (const each of apps ?? []) {
        const group = GROUP_OF[each.never];

        if (group !== undefined) {
            counts[group]++;
        }
    }

    const choices = (apps ?? []).filter((each) => each.never === null && each.label.toLowerCase().includes(filter.trim().toLowerCase()));
    const session = state.sessions[0];

    return html`<${Sheet} title=${t("Phone control")} onClose=${closeSheet} className="phone-control-sheet">
        <p class="muted small">
                ${t("Pi can read and operate apps on this phone, in a session you approve on a card: only the apps it names, and the home screen, for the minutes on the card. A banner on the phone shows it, with Stop.")}
            </p>

            <div class="phone-section-title">${t("Set up this phone")}</div>
            ${!state.present && html`<p class="muted small">${t("pi-phone's service is not polling: open pi-phone on the phone, then come back.")}</p>`}
            ${state.present && !app && html`<p class="muted small">${t("Open this in the pi-phone app on the phone to open Android's settings from here.")}</p>`}
            ${state.problem && html`<div class="error-box small">${state.problem}</div>`}
            <ol class="phone-steps sheet-list">
                ${
                    restricted &&
                    html`<${Step}
                        number="1"
                        done=${enabled}
                        title=${t("Allow restricted settings")}
                        text=${t("Android 13 and later block accessibility for apps installed outside a store. In pi's App info, tap ⋮ (top right), then Allow restricted settings. No such item? Try step 2 first: Android offers it after it blocks the switch once.")}
                        open=${openSettings("app-info")}
                    />`
                }
                <${Step}
                    number=${restricted ? "2" : "1"}
                    done=${enabled}
                    title=${t("Turn on pi-phone in Accessibility")}
                    text=${t("In Accessibility › Downloaded apps (or Installed apps), open \"pi: phone control\" and turn it on.")}
                    open=${openSettings("accessibility")}
                />
                <${Step}
                    number=${restricted ? "3" : "2"}
                    done=${status?.unrestricted === true}
                    title=${t("Let it run in the background")}
                    text=${t("Android may pause pi while the screen is off or another app is in front: allow it to run unrestricted.")}
                    open=${openSettings("battery")}
                />
            </ol>

            <div class="phone-section-title">${t("Never these apps")}</div>
            <div class="muted small">${t("Pi never reads or controls these, even when a card names them. Only you change this list, here.")}</div>
            <div class="phone-never" data-part="phone-never">
                <span class="chip"><${Icon} name="shield" size=${12} /> ${t("pi-phone itself (always)")}</span>
                ${state.never.groups.map(
                    (group) =>
                        html`<span class="chip"><${Icon} name="shield" size=${12} /> ${t(group.label)}${apps !== null && html` <span class="muted">· ${t("{n} installed", { n: counts[group.id] ?? 0 })}</span>`}</span>`,
                )}
                ${own.map(
                    (each) => html`<span class="chip" title=${each.package}>
                        ${each.label}
                        <button aria-label=${t("Remove {name}", { name: each.label })} onClick=${() => never({ remove: each.package })}><${Icon} name="close" size=${12} /></button>
                    </span>`,
                )}
                ${apps !== null && html`<button class="chip" onClick=${() => setAdding(!adding)}><${Icon} name="plus" size=${12} /> ${t("Add")}</button>`}
            </div>
            ${
                adding &&
                html`<input placeholder=${t("Find an app")} value=${filter} onInput=${(event) => setFilter(event.currentTarget.value)} />
                    <div class="phone-picker" data-part="phone-picker">
                        ${choices.length === 0 && html`<div class="muted small" style="padding: 10px 12px">${t("No app to add")}</div>`}
                        ${choices.map(
                            (each) => html`<button onClick=${() => never({ add: { label: each.label, package: each.package } })}>
                                <span>${each.label}</span><span class="muted mono small">${each.package}</span>
                            </button>`,
                        )}
                    </div>`
            }

            <div class="phone-section-title">${t("Devices")}</div>
            <div class="sheet-list">
            ${state.devices.map(
                (device) => html`<div class="provider" data-part="phone-device">
                    <div>
                        <div>${device.name === "This phone" ? t("This phone") : device.name}</div>
                        <div class="muted small">
                            ${
                                !state.present
                                    ? t("not connected")
                                    : status === null
                                      ? t("not answering")
                                      : `Android ${status.android} · ${enabled ? t("accessibility on") : t("accessibility off")}`
                            }
                            ${
                                session &&
                                session.device === device.id &&
                                html` · ${t("in use by session #{n} until {time}", { n: session.session, time: clockTime(new Date(session.until)) })}`
                            }
                        </div>
                    </div>
                    ${
                        session &&
                        session.device === device.id &&
                        html`<div class="provider-actions">
                            <button class="button small" onClick=${() =>
                                attempt(async () => {
                                    await api("phone-control/stop", { device: device.id });
                                    load();
                                })}>${t("Stop")}</button>
                        </div>`
                    }
                </div>`,
            )}
            </div>
            ${store.state.server?.gateway && html`<p class="muted small">${t("The team server has no phone.")}</p>`}
    <//>`;
}
