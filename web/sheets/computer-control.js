// Menu › Computer control (PP-178): Pi operating desktop apps on the owner's machines (src/server/computer-control.ts),
// built as Menu › Phone control is (phone-control.js): how a machine is set up for it, each machine and where it stands
// (with its desktop's setup line, what ocu reads there now, and Stop), the apps Pi never touches, and how cards work.
// Only the owner changes the Never list, here: no tool changes it.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n.js";
import { api, attempt, closeSheet, openSheet } from "../store.js";
import { clockTime, html, Icon, Loader, Sheet } from "../ui.js";

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

/** A desktop setup line, as the field's example: a shell command, not words to translate. */
const PREPARE_EXAMPLE = ". ~/desktop-env.sh";

/** Where a machine stands for computer control, in a few words. */
function machineState(machine) {
    if (!machine.connected) {
        return t("not connected");
    }

    if (machine.platform === "windows") {
        return t("Windows · not yet: it needs pi-phone's task in your desktop session");
    }

    if (machine.platform !== "linux") {
        return t("{system} · not yet", { system: machine.platform ?? t("unknown system") });
    }

    return machine.ocu === null ? t("Linux · ocu not installed") : t("Linux · ocu {version}", { version: machine.ocu });
}

/** One machine: its state, its desktop's setup line (Linux with ocu), what ocu reads there, and its session's Stop. */
function MachineRow({ machine, onChanged }) {
    const [prepare, setPrepare] = useState(machine.prepare);
    const [checked, setChecked] = useState(null);
    const [busy, setBusy] = useState(false);
    const ready = machine.connected && machine.platform === "linux" && machine.ocu !== null;
    const check = () =>
        attempt(async () => {
            setBusy(true);

            try {
                setChecked(await api("computer-control/check", { machine: machine.id }));
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="provider" data-part="computer-machine">
        <div>
            <div>${machine.name}</div>
            <div class="muted small">
                ${machineState(machine)}
                ${machine.session && ` · ${t("in use by session #{n} until {time}", { n: machine.session.session, time: clockTime(new Date(machine.session.until)) })}`}
            </div>
            ${
                ready &&
                html`<label class="field">
                    <span class="label">${t("Before ocu starts (one shell line, for its desktop)")}</span>
                    <input class="mono" value=${prepare} placeholder=${PREPARE_EXAMPLE} spellcheck="false" onInput=${(event) => setPrepare(event.currentTarget.value)} />
                </label>`
            }
            ${
                checked &&
                html`<div class=${`small ${checked.ok ? "muted" : "machine-problem"}`}>
                    ${
                        checked.ok
                            ? t("ocu reads: {apps}", {
                                  apps: checked.apps.filter((app) => app.running).map((app) => (app.never ? `${app.window || app.name} (${t("never")})` : app.window || app.name)).join(", ") || t("no windows"),
                              })
                            : checked.problem
                    }
                </div>`
            }
        </div>
        ${
            (ready || machine.session) &&
            html`<div class="provider-actions">
                ${
                    ready &&
                    html`<button
                            class="button small"
                            disabled=${busy || prepare === machine.prepare}
                            onClick=${() =>
                                attempt(async () => {
                                    await api("computer-control/prepare", { machine: machine.id, prepare });
                                    onChanged();
                                })}
                        >
                            ${t("Save")}
                        </button>
                        <button class="button small" disabled=${busy} onClick=${check}>${busy ? t("Checking…") : t("Check")}</button>`
                }
                ${
                    machine.session &&
                    html`<button
                        class="button small"
                        onClick=${() =>
                            attempt(async () => {
                                await api("computer-control/stop", { machine: machine.id });
                                onChanged();
                            })}
                    >
                        ${t("Stop")}
                    </button>`
                }
            </div>`
        }
    </div>`;
}

export function ComputerControlSheet() {
    const [state, setState] = useState(null);
    const [adding, setAdding] = useState(false);
    const [name, setName] = useState("");
    const load = () => attempt(async () => setState(await api("computer-control")));

    useEffect(() => {
        load();
    }, []);

    const never = (body) =>
        attempt(async () => {
            const saved = await api("computer-control/never", body);

            setState((was) => ({ ...was, never: saved.never }));
        });

    if (state === null) {
        return html`<${Sheet} title=${t("Computer control")} onClose=${closeSheet}><${Loader} /><//>`;
    }

    const installed = state.machines.some((each) => each.ocu !== null);

    return html`<${Sheet} title=${t("Computer control")} onClose=${closeSheet} className="phone-control-sheet computer-control-sheet">
        <p class="muted small">
            ${t("Pi can read and operate desktop apps on your machines, in a session you approve on a card: only the apps it names, for the minutes it asks for. A window on the machine shows it, with Stop, and the session's panel shows the window live.")}
        </p>

        <div class="phone-section-title">${t("Set up a machine")}</div>
        <ol class="phone-steps sheet-list">
            <${Step}
                number="1"
                done=${installed}
                title=${t("Install Computer use (ocu)")}
                text=${t("Settings › Machines › Install tools: about 2.5 MB into ~/.pi/mobile/tools, checked against its sha256. Ticked by default when you add a machine.")}
                open=${() => openSheet({ type: "machines" })}
            />
            <${Step}
                number="2"
                done=${false}
                title=${t("A desktop to work in")}
                text=${t("Linux: a signed-in desktop session, or a virtual one; if its environment must be set first, give that line below (Check shows what ocu reads). Windows comes next.")}
            />
        </ol>

        <div class="phone-section-title">${t("Machines")}</div>
        ${state.machines.length === 0 && html`<p class="muted small">${t("No machines yet: add one in Settings › Machines.")}</p>`}
        ${state.machines.length > 0 && html`<div class="sheet-list">${state.machines.map((machine) => html`<${MachineRow} key=${machine.id} machine=${machine} onChanged=${load} />`)}</div>`}

        <div class="phone-section-title">${t("Never these apps")}</div>
        <div class="muted small">${t("Pi never reads or controls these, even when a card names them. Only you change this list, here.")}</div>
        <div class="phone-never" data-part="computer-never">
            <span class="chip"><${Icon} name="shield" size=${12} /> ${t("pi-phone itself (always)")}</span>
            ${state.never.groups.map((group) => html`<span class="chip" title=${group.names.join(", ")}><${Icon} name="shield" size=${12} /> ${t(group.label)}</span>`)}
            ${state.never.own.map(
                (each) => html`<span class="chip" title=${each.label}>
                    ${each.label}
                    <button aria-label=${t("Remove {name}", { name: each.label })} onClick=${() => never({ remove: each.label })}><${Icon} name="close" size=${12} /></button>
                </span>`,
            )}
            <button class="chip" onClick=${() => setAdding(!adding)}><${Icon} name="plus" size=${12} /> ${t("Add")}</button>
        </div>
        ${
            adding &&
            html`<form
                class="pb-row"
                onSubmit=${(event) => {
                    event.preventDefault();

                    if (name.trim() !== "") {
                        never({ add: name.trim() });
                        setName("");
                    }
                }}
            >
                <input placeholder=${t("An app's name or window title, like Outlook")} value=${name} onInput=${(event) => setName(event.currentTarget.value)} />
                <button class="button small">${t("Add")}</button>
            </form>`
        }
        <div class="muted small">${t("Matched in an app's name and window title, on every machine.")}</div>

        <div class="phone-section-title">${t("How cards work")}</div>
        <p class="muted small">${t("Pi asks for 5 to 60 minutes on each card, and asks again for more. A session ends 20 s after Pi's run, at its time, or on Stop.")}</p>
    <//>`;
}
