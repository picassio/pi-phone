// Machines (src/server/machines.ts): other computers sessions can work on, over ssh with one of the app's SSH keys.
// Add one, accept its host key, approve the daemon install, test it, edit, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, openSheet } from "../store.js";
import { copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";

const address = (machine) => `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;

/** The form for a new machine, or for editing one: name, address, key. */
function MachineForm({ machine, keys, onDone }) {
    const [name, setName] = useState(machine?.name ?? "");
    const [where, setWhere] = useState(machine ? address(machine) : "");
    const [keyId, setKeyId] = useState(machine?.keyId ?? keys[0]?.id ?? "");
    const [busy, setBusy] = useState(false);
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const saved = await api(
                    machine ? `machines/${encodeURIComponent(machine.id)}` : "machines",
                    { name, address: where, keyId },
                );

                onDone(saved);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="machine-form">
        <div class="field">
            <div class="label">Name</div>
            <input autofocus aria-label="Machine name" placeholder="laptop" value=${name} onInput=${(event) => setName(event.currentTarget.value)} />
        </div>
        <div class="field">
            <div class="label">Address</div>
            <input
                class="mono"
                aria-label="Address"
                placeholder="user@host or user@host:port"
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                value=${where}
                onInput=${(event) => setWhere(event.currentTarget.value)}
            />
        </div>
        <div class="field">
            <div class="label">SSH key</div>
            ${
                keys.length === 0
                    ? html`<p class="muted small">
                        No keys yet. <button class="link" onClick=${() => openSheet({ type: "ssh-keys" })}>Make one under SSH keys</button>, then come back.
                    </p>`
                    : html`<select aria-label="SSH key" value=${keyId} onChange=${(event) => setKeyId(event.currentTarget.value)}>
                        ${keys.map((key) => html`<option value=${key.id}>${key.name} · ${key.fingerprint.slice(0, 20)}…</option>`)}
                    </select>`
            }
        </div>
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(null)}>Cancel</button>
            <button class="button primary" disabled=${busy || name.trim() === "" || where.trim() === "" || keyId === ""} onClick=${save}>
                ${busy ? "Saving…" : machine ? "Save" : "Add"}
            </button>
        </div>
    </div>`;
}

/**
 * One machine and where it stands: added (scan its host key), host key accepted (install and connect), connected
 * (test, edit, remove). Each step is the owner's tap; nothing runs on the machine before "Install and connect".
 */
function MachineRow({ machine, keys, onChanged }) {
    const [editing, setEditing] = useState(false);
    const [scan, setScan] = useState(null);
    const [busy, setBusy] = useState(null);
    const [checked, setChecked] = useState(null);
    const key = keys.find((each) => each.id === machine.keyId);
    const call = (what, run) =>
        attempt(async () => {
            setBusy(what);

            try {
                await run();
            } finally {
                setBusy(null);
            }
        });
    const doScan = () => call("scan", async () => setScan(await api(`machines/${encodeURIComponent(machine.id)}/scan`, {})));
    const accept = () =>
        call("accept", async () => {
            await api(`machines/${encodeURIComponent(machine.id)}/accept`, { lines: scan.lines, fingerprint: scan.fingerprints[0] });
            setScan(null);
            onChanged();
        });
    const connect = () =>
        call("connect", async () => {
            const connected = await api(`machines/${encodeURIComponent(machine.id)}/connect`, {});

            for (const warning of connected.warnings ?? []) {
                notify("warning", `${machine.name}: ${warning}`);
            }

            notify("info", `${machine.name} is connected: ${connected.remote.platform} ${connected.remote.arch}, pi-env ${connected.daemon}.`);
            onChanged();
        });
    const detect = () =>
        call("detect", async () => {
            const remote = await api(`machines/${encodeURIComponent(machine.id)}/detect`, {});

            setChecked(`${remote.platform} ${remote.arch}, home ${remote.home}`);
        });
    const forget = () =>
        confirm(`Forget ${machine.name}'s host key?\n\nOnly do this when you know why it changed (the machine was reinstalled). You then scan and accept the new key.`) &&
        call("forget", async () => {
            await api(`machines/${encodeURIComponent(machine.id)}/forget`, {});
            onChanged();
        });
    const remove = () =>
        confirm(
            `Remove ${machine.name}?\n\nThe app forgets it and its host key. The pi-env helper stays in ~/.pi/mobile/tools on the machine until you delete it there, and the key stays in its authorized_keys.`,
        ) &&
        call("remove", async () => {
            await api(`machines/${encodeURIComponent(machine.id)}`, undefined, { method: "DELETE" });
            onChanged();
        });
    const copyKey = () =>
        key &&
        copyText(key.publicKey).then(
            () => notify("info", "Public key copied."),
            () => notify("error", "Could not copy."),
        );

    if (editing) {
        return html`<div class="provider machine">
            <${MachineForm}
                machine=${machine}
                keys=${keys}
                onDone=${() => {
                    setEditing(false);
                    onChanged();
                }}
            />
        </div>`;
    }

    const state = machine.remote ? "connected" : machine.hostKey ? "trusted" : "new";

    return html`<div class="provider machine">
        <div>
            <div>
                ${machine.name}
                ${state === "connected" && html` <span class="ok">✓</span>`}
            </div>
            <div class="muted small mono">${address(machine)}</div>
            <div class="muted small">
                ${
                    state === "connected"
                        ? `${machine.remote.platform} ${machine.remote.arch} · pi-env ${machine.daemon} · connected ${timeAgo(machine.connectedAt)} ago`
                        : state === "trusted"
                          ? "host key accepted · not connected yet"
                          : "not connected yet"
                }
                ${key ? ` · key: ${key.name}` : " · key missing"}
            </div>
            ${checked && html`<div class="muted small">Reached: ${checked}</div>`}
            ${
                scan &&
                html`<div class="machine-step">
                    <p class="small">
                        The machine presents this host key. Compare it with <span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span> run on the machine itself, then accept.
                    </p>
                    <pre class="ssh-public-key">${scan.fingerprints.join("\n")}</pre>
                    <div class="sheet-actions">
                        <button class="button small" onClick=${() => setScan(null)}>Not now</button>
                        <button class="button small primary" disabled=${busy !== null} onClick=${accept}>Accept this key</button>
                    </div>
                </div>`
            }
            ${
                state === "trusted" &&
                !scan &&
                html`<div class="machine-step">
                    <p class="small">
                        Connecting copies the app's helper program (pi-env, about 2 MB) to <span class="mono">~/.pi/mobile/tools</span> on ${machine.name} over ssh and starts it there whenever a session works on this machine. It runs as <span class="mono">${machine.user}</span>, only while connected, and is checked against its hash before every start.
                    </p>
                    <button class="button primary" disabled=${busy !== null} onClick=${connect}>
                        ${busy === "connect" ? "Connecting…" : "Install and connect"}
                    </button>
                </div>`
            }
        </div>
        <div class="provider-actions">
            ${state === "new" && !scan && html`<button class="button small primary" disabled=${busy !== null} onClick=${doScan}>${busy === "scan" ? "Scanning…" : "Scan host key"}</button>`}
            ${
                state === "connected" &&
                html`<button
                    class="button small"
                    onClick=${() => openSheet({ type: "terminal", place: `machine:${machine.id}:${machine.remote.home}` })}
                >
                    Terminal
                </button>`
            }
            ${state === "connected" && html`<button class="button small" disabled=${busy !== null} onClick=${detect}>${busy === "detect" ? "Testing…" : "Test"}</button>`}
            ${state === "connected" && html`<button class="button small ghost" disabled=${busy !== null} onClick=${connect}>${busy === "connect" ? "Updating…" : "Update helper"}</button>`}
            ${key && html`<button class="button small ghost" onClick=${copyKey}>Copy public key</button>`}
            <button class="button small ghost" onClick=${() => setEditing(true)}>Edit</button>
            ${machine.hostKey && html`<button class="button small ghost" disabled=${busy !== null} onClick=${forget}>Forget host key</button>`}
            <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>Remove</button>
        </div>
    </div>`;
}

export function MachinesSheet() {
    const [machines, setMachines] = useState(null);
    const [keys, setKeys] = useState([]);
    const [adding, setAdding] = useState(false);
    const load = async () => {
        const [list, keyList] = await Promise.all([api("machines"), api("ssh-keys")]);

        setMachines(list.machines);
        setKeys(keyList.keys);
    };

    useEffect(() => {
        attempt(load);
    }, []);

    return html`<${Sheet} title="Machines" onClose=${closeSheet}>
        <p class="muted small">
            Other computers a session can work on. Pi's tools then run there over ssh; the conversation, its history, and your Claude sign-in stay on this phone. Each machine uses one of your SSH keys; its public half must be in the machine's <span class="mono">~/.ssh/authorized_keys</span>.
        </p>
        ${machines === null && html`<${Loader} label="Loading machines" />`}
        ${machines !== null && machines.length === 0 && !adding && html`<p class="muted">No machines yet.</p>`}
        ${
            machines !== null &&
            machines.length > 0 &&
            html`<div class="sheet-list">
                ${machines.map((machine) => html`<${MachineRow} key=${machine.id} machine=${machine} keys=${keys} onChanged=${() => attempt(load)} />`)}
            </div>`
        }
        ${
            adding
                ? html`<${MachineForm}
                    keys=${keys}
                    onDone=${(saved) => {
                        setAdding(false);

                        if (saved) {
                            attempt(load);
                        }
                    }}
                />`
                : machines !== null &&
                  html`<div class="sheet-actions">
                      <button class="button primary" onClick=${() => setAdding(true)}>
                          <${Icon} name="plus" size=${14} /> Add a machine
                      </button>
                  </div>`
        }
    <//>`;
}
