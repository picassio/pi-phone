// Machines (src/server/machines.ts): other computers sessions can work on, over ssh with one of the app's SSH keys.
// Add one, accept its host key, approve the daemon install, test it, edit, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, notify, openSheet } from "../store.js";
import { Choice, copyText, html, Icon, Loader, Sheet, timeAgo } from "../ui.js";
import { windowsSetupScript } from "../windows-setup.js";

const address = (machine) => `${machine.user}@${machine.host}${machine.port === undefined ? "" : `:${machine.port}`}`;

/** The form for a new machine, or for editing one: name, address, key. */
function MachineForm({ machine, keys, onDone }) {
    const [name, setName] = useState(machine?.name ?? "");
    const [where, setWhere] = useState(machine ? address(machine) : "");
    const [keyId, setKeyId] = useState(machine?.keyId ?? keys[0]?.id ?? "");

    // Keys that arrive after the form opened: the first one, as when they were there.
    useEffect(() => {
        if (keyId === "" && keys.length > 0) {
            setKeyId(keys[0].id);
        }
    }, [keys]);
    const [busy, setBusy] = useState(false);
    const [windows, setWindows] = useState(false);
    const key = keys.find((each) => each.id === keyId);
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
                    : html`<${Choice}
                        label="SSH key"
                        value=${keyId}
                        options=${keys.map((key) => ({ value: key.id, label: key.name, detail: `${key.type} · ${key.fingerprint.slice(0, 27)}…` }))}
                        onChange=${setKeyId}
                    />`
            }
        </div>
        ${!machine && key && html`<label class="check">
            <input type="checkbox" checked=${windows} onChange=${(event) => setWindows(event.currentTarget.checked)} /> It's a Windows PC
        </label>`}
        ${windows && key && html`<${WindowsSetup} publicKey=${key.publicKey} />`}
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(null)}>Cancel</button>
            <button class="button primary" disabled=${busy || name.trim() === "" || where.trim() === "" || keyId === ""} onClick=${save}>
                ${busy ? "Saving…" : machine ? "Save" : "Add"}
            </button>
        </div>
    </div>`;
}

/**
 * Getting a Windows PC ready (web/windows-setup.js): one script, with this key in it, pasted into PowerShell as
 * administrator; it says which addresses to put above.
 */
function WindowsSetup({ publicKey }) {
    const script = windowsSetupScript(publicKey);

    return html`<div class="windows-setup">
        <ol class="small">
            <li>On the PC, open the Start menu, type <b>PowerShell</b>, and choose <b>Run as administrator</b>, signed in as the account pi-phone will use.</li>
            <li>Paste this script and press Enter. It turns on OpenSSH Server, lets SSH (port 22) through the firewall, adds this key, and installs Git for Windows if it is missing (Git Bash runs Pi's commands there).</li>
            <li>It ends with addresses like <span class="mono">you@192.168.1.20</span>: put one in Address above, then Add, and connect.</li>
            <li>By hand instead: OpenSSH Server (<span class="mono">winget install Microsoft.OpenSSH.Preview</span>), Git for Windows, port 22 open in the firewall, and this key in <span class="mono">~/.ssh/authorized_keys</span>, or for an administrator in <span class="mono">C:\\ProgramData\\ssh\\administrators_authorized_keys</span>.</li>
        </ol>
        <div class="sheet-actions">
            <button
                class="button"
                onClick=${() =>
                    copyText(script).then(
                        () => notify("info", "Script copied: paste it into PowerShell on the PC."),
                        () => notify("error", "Could not copy."),
                    )}
            >
                <${Icon} name="copy" size=${14} /> Copy script
            </button>
        </div>
        <pre class="ssh-public-key">${script}</pre>
        <p class="muted small">From another network, put the PC on your Tailscale network too and use its 100.x address.</p>
    </div>`;
}

/** Where a tool stands on a machine, in a few words. */
function toolState(tool) {
    if (!tool.supported) {
        return "no build for this machine";
    }

    if (tool.installed && tool.installed === tool.version) {
        return `installed, ${tool.installed}`;
    }

    if (tool.installed) {
        return `installed, ${tool.installed}; ${tool.version} available`;
    }

    if (tool.own) {
        return `the machine's own: ${tool.own}`;
    }

    return `not installed · ${tool.size}`;
}

/**
 * Tools pi-phone installs on a connected machine (src/server/machine-tools.ts): each one's state there, the ones offered
 * ticked, and Install for those ticked.
 */
function MachineToolsPanel({ machine, onClose }) {
    const [tools, setTools] = useState(null);
    const [ticked, setTicked] = useState(new Set());
    const [busy, setBusy] = useState(false);
    const path = `machines/${encodeURIComponent(machine.id)}/tools`;
    const show = (list) => {
        setTools(list);
        setTicked(new Set(list.filter((tool) => tool.offered).map((tool) => tool.id)));
    };

    useEffect(() => {
        attempt(async () => show((await api(path, {})).tools));
    }, [path]);

    const install = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const done = await api(path, { install: [...ticked] });

                for (const result of done.results) {
                    notify(result.ok ? "info" : "error", `${machine.name}: ${result.id} ${result.ok ? `${result.version} installed` : `not installed: ${result.said}`}`);
                }

                show(done.tools);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="machine-step">
        <div class="label">Tools on ${machine.name}</div>
        ${!tools && html`<${Loader} label="Looking at the machine" />`}
        ${
            tools &&
            tools.map(
                (tool) => html`<label class="check machine-tool" key=${tool.id}>
                    <input
                        type="checkbox"
                        checked=${ticked.has(tool.id)}
                        disabled=${busy || !tool.supported || (tool.own && !tool.installed)}
                        onChange=${(event) => {
                            const next = new Set(ticked);

                            if (event.currentTarget.checked) {
                                next.add(tool.id);
                            } else {
                                next.delete(tool.id);
                            }

                            setTicked(next);
                        }}
                    />
                    <span>
                        <strong>${tool.name}</strong> ${tool.version}
                        <span class="muted small"> · ${toolState(tool)}</span>
                        <div class="muted small">${tool.description}</div>
                    </span>
                </label>`,
            )
        }
        <p class="muted small">
            Each is downloaded by the machine itself, checked against its pinned sha256, into <span class="mono">~/.pi/mobile/tools</span>, and put first on bash's PATH in sessions there.
        </p>
        <div class="sheet-actions">
            <button class="button small" disabled=${busy} onClick=${onClose}>Close</button>
            <button class="button small primary" disabled=${busy || ticked.size === 0} onClick=${install}>${busy ? "Installing…" : "Install"}</button>
        </div>
    </div>`;
}

/**
 * One machine and where it stands: added (scan its host key), host key accepted (install and connect), connected
 * (test, edit, remove). Each step is the owner's tap; nothing runs on the machine before "Install and connect".
 */
function MachineRow({ machine, keys, onChanged, health, onRecheck }) {
    const [editing, setEditing] = useState(false);
    const [scan, setScan] = useState(null);
    const [busy, setBusy] = useState(null);
    const [checked, setChecked] = useState(null);
    const [toolsOpen, setToolsOpen] = useState(false);
    // Tools to install once it connects: every tool, ticked, as the owner chose (they untick what they don't want).
    const [catalog, setCatalog] = useState(null);
    const [wanted, setWanted] = useState(new Set());

    useEffect(() => {
        if (machine.hostKey && !machine.remote && catalog === null) {
            attempt(async () => {
                const list = (await api("machines/tools")).tools;

                setCatalog(list);
                setWanted(new Set(list.map((tool) => tool.id)));
            });
        }
    }, [machine.hostKey, machine.remote]);
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

            // Then the tools ticked: those the machine has a build of and, for rg and fd, has none of its own.
            if (state === "trusted" && wanted.size > 0) {
                const path = `machines/${encodeURIComponent(machine.id)}/tools`;
                const status = (await api(path, {})).tools;
                const install = status.filter((tool) => tool.offered && wanted.has(tool.id)).map((tool) => tool.id);

                for (const tool of status.filter((each) => wanted.has(each.id) && !each.offered)) {
                    notify("info", `${machine.name}: ${tool.name} not installed (${toolState(tool)}).`);
                }

                if (install.length > 0) {
                    setBusy("tools");
                    const done = await api(path, { install });

                    for (const result of done.results) {
                        notify(result.ok ? "info" : "error", `${machine.name}: ${result.id} ${result.ok ? `${result.version} installed` : `not installed: ${result.said}`}`);
                    }
                }
            }

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
                ${state === "connected" && health?.ok !== false && html` <span class="ok">✓</span>`}
                ${state === "connected" && health?.ok === false && html` <span class="warn">⚠</span>`}
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
                state === "connected" &&
                machine.tools &&
                html`<div class="muted small">Tools: ${Object.entries(machine.tools).map(([tool, version]) => `${tool} ${version}`).join(", ")}</div>`
            }
            ${state === "connected" && toolsOpen && html`<${MachineToolsPanel} machine=${machine} onClose=${() => { setToolsOpen(false); onChanged(); }} />`}
            ${
                state === "connected" &&
                health !== undefined &&
                (health.ok
                    ? html`<div class="muted small">Answers now (checked ${timeAgo(health.at)} ago)</div>`
                    : html`<div class="machine-problem small">
                          <strong>Can't connect:</strong> ${health.problem}
                          ${health.said && health.said !== health.problem && html`<div class="muted mono">${health.said}</div>`}
                          <button class="link small" onClick=${onRecheck}>Check again</button>
                      </div>`)
            }
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
                    ${
                        catalog &&
                        html`<div class="machine-tools-pick">
                            <div class="label">Also install there</div>
                            ${catalog.map(
                                (tool) => html`<label class="check machine-tool" key=${tool.id}>
                                    <input
                                        type="checkbox"
                                        checked=${wanted.has(tool.id)}
                                        disabled=${busy !== null}
                                        onChange=${(event) => {
                                            const next = new Set(wanted);

                                            if (event.currentTarget.checked) {
                                                next.add(tool.id);
                                            } else {
                                                next.delete(tool.id);
                                            }

                                            setWanted(next);
                                        }}
                                    />
                                    <span>
                                        <strong>${tool.name}</strong> ${tool.version} <span class="muted small">· ${tool.size}${tool.onlyIfMissing ? " · only if the machine has none" : ""}</span>
                                        <div class="muted small">${tool.description}</div>
                                    </span>
                                </label>`,
                            )}
                        </div>`
                    }
                    <button class="button primary" disabled=${busy !== null} onClick=${connect}>
                        ${busy === "connect" ? "Connecting…" : busy === "tools" ? "Installing tools…" : "Install and connect"}
                    </button>
                </div>`
            }
        </div>
        <div class="provider-actions">
            <div class="action-group">
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
            ${state === "connected" && html`<button class="button small" onClick=${() => openSheet({ type: "forwards", machineId: machine.id })}>Ports</button>`}
            ${state === "connected" && html`<button class="button small" disabled=${toolsOpen} onClick=${() => setToolsOpen(true)}>Install tools</button>`}
            ${state === "connected" && html`<button class="button small" disabled=${busy !== null} onClick=${detect}>${busy === "detect" ? "Testing…" : "Test"}</button>`}
            </div>
            <div class="action-group">
            ${state === "connected" && html`<button class="button small ghost" disabled=${busy !== null} onClick=${connect}>${busy === "connect" ? "Updating…" : "Update helper"}</button>`}
            ${key && html`<button class="button small ghost" onClick=${copyKey}>Copy public key</button>`}
            <button class="button small ghost" onClick=${() => setEditing(true)}>Edit</button>
            ${machine.hostKey && html`<button class="button small ghost" disabled=${busy !== null} onClick=${forget}>Forget host key</button>`}
            <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>Remove</button>
            </div>
        </div>
    </div>`;
}

export function MachinesSheet() {
    const [machines, setMachines] = useState(null);
    const [keys, setKeys] = useState([]);
    const [adding, setAdding] = useState(false);
    // Whether each set-up machine answers now: asked fresh as the sheet opens, and again on Check again.
    const [health, setHealth] = useState({});
    const recheck = () =>
        api("machines/health?fresh=1").then(
            (answer) => setHealth(answer.health),
            () => {},
        );
    const load = async () => {
        const [list, keyList] = await Promise.all([api("machines"), api("ssh-keys")]);

        setMachines(list.machines);
        setKeys(keyList.keys);
    };

    useEffect(() => {
        attempt(load);
        recheck();
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
                ${machines.map((machine) => html`<${MachineRow} key=${machine.id} machine=${machine} keys=${keys} health=${health[machine.id]} onRecheck=${recheck} onChanged=${() => attempt(load)} />`)}
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
