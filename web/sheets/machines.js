// Machines (src/server/machines.ts): other computers sessions can work on, over ssh with one of the app's SSH keys.
// Add one, accept its host key, approve the daemon install, test it, edit, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { t, tx } from "../i18n.js";
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
            <div class="label">${t("Name")}</div>
            <input autofocus aria-label=${t("Machine name")} placeholder=${t("laptop")} value=${name} onInput=${(event) => setName(event.currentTarget.value)} />
        </div>
        <div class="field">
            <div class="label">${t("Address")}</div>
            <input
                class="mono"
                aria-label=${t("Address")}
                placeholder=${t("user@host or user@host:port")}
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                value=${where}
                onInput=${(event) => setWhere(event.currentTarget.value)}
            />
        </div>
        <div class="field">
            <div class="label">${t("SSH key")}</div>
            ${
                keys.length === 0
                    ? html`<p class="muted small">
                        ${tx("No keys yet. {link}, then come back.", {
                            link: html`<button class="link" onClick=${() => openSheet({ type: "ssh-keys" })}>${t("Make one under SSH keys")}</button>`,
                        })}
                    </p>`
                    : html`<${Choice}
                        label=${t("SSH key")}
                        value=${keyId}
                        options=${keys.map((key) => ({ value: key.id, label: key.name, detail: `${key.type} · ${key.fingerprint.slice(0, 27)}…` }))}
                        onChange=${setKeyId}
                    />`
            }
        </div>
        ${!machine && key && html`<label class="check">
            <input type="checkbox" checked=${windows} onChange=${(event) => setWindows(event.currentTarget.checked)} /> ${t("It's a Windows PC")}
        </label>`}
        ${windows && key && html`<${WindowsSetup} publicKey=${key.publicKey} />`}
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(null)}>${t("Cancel")}</button>
            <button class="button primary" disabled=${busy || name.trim() === "" || where.trim() === "" || keyId === ""} onClick=${save}>
                ${busy ? t("Saving…") : machine ? t("Save") : t("Add")}
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
            <li>
                ${tx("On the PC, open the Start menu, type {powershell}, and choose {admin}, signed in as the account pi-phone will use.", {
                    powershell: html`<b>PowerShell</b>`,
                    admin: html`<b>${t("Run as administrator")}</b>`,
                })}
            </li>
            <li>${t("Paste this script and press Enter. It turns on OpenSSH Server, lets SSH (port 22) through the firewall, adds this key, and installs Git for Windows if it is missing (Git Bash runs Pi's commands there).")}</li>
            <li>${tx("It ends with addresses like {example}: put one in Address above, then Add, and connect.", { example: html`<span class="mono">you@192.168.1.20</span>` })}</li>
            <li>
                ${tx("By hand instead: OpenSSH Server ({command}), Git for Windows, port 22 open in the firewall, and this key in {file}, or for an administrator in {adminFile}.", {
                    command: html`<span class="mono">winget install Microsoft.OpenSSH.Preview</span>`,
                    file: html`<span class="mono">~/.ssh/authorized_keys</span>`,
                    adminFile: html`<span class="mono">C:\\ProgramData\\ssh\\administrators_authorized_keys</span>`,
                })}
            </li>
        </ol>
        <div class="sheet-actions">
            <button
                class="button"
                onClick=${() =>
                    copyText(script).then(
                        () => notify("info", t("Script copied: paste it into PowerShell on the PC.")),
                        () => notify("error", t("Could not copy.")),
                    )}
            >
                <${Icon} name="copy" size=${14} /> ${t("Copy script")}
            </button>
        </div>
        <pre class="ssh-public-key">${script}</pre>
        <p class="muted small">${t("From another network, put the PC on your Tailscale network too and use its 100.x address.")}</p>
    </div>`;
}

/** Where a tool stands on a machine, in a few words. */
function toolState(tool) {
    if (!tool.supported) {
        return t("no build for this machine");
    }

    if (tool.installed && tool.installed === tool.version) {
        return t("installed, {version}", { version: tool.installed });
    }

    if (tool.installed) {
        return t("installed, {version}; {latest} available", { version: tool.installed, latest: tool.version });
    }

    if (tool.own) {
        return t("the machine's own: {own}", { own: tool.own });
    }

    return t("not installed · {size}", { size: tool.size });
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
                    notify(
                        result.ok ? "info" : "error",
                        result.ok
                            ? t("{machine}: {tool} {version} installed", { machine: machine.name, tool: result.id, version: result.version })
                            : t("{machine}: {tool} not installed: {said}", { machine: machine.name, tool: result.id, said: result.said }),
                    );
                }

                show(done.tools);
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="machine-step">
        <div class="label">${t("Tools on {name}", { name: machine.name })}</div>
        ${!tools && html`<${Loader} label=${t("Looking at the machine")} />`}
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
            ${tx("Each is downloaded by the machine itself, checked against its pinned sha256, into {path}, and put first on bash's PATH in sessions there.", { path: html`<span class="mono">~/.pi/mobile/tools</span>` })}
        </p>
        <div class="sheet-actions">
            <button class="button small" disabled=${busy} onClick=${onClose}>${t("Close")}</button>
            <button class="button small primary" disabled=${busy || ticked.size === 0} onClick=${install}>${busy ? t("Installing…") : t("Install")}</button>
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

            notify(
                "info",
                t("{name} is connected: {platform} {arch}, pi-env {daemon}.", {
                    name: machine.name,
                    platform: connected.remote.platform,
                    arch: connected.remote.arch,
                    daemon: connected.daemon,
                }),
            );

            // Then the tools ticked: those the machine has a build of and, for rg and fd, has none of its own.
            if (state === "trusted" && wanted.size > 0) {
                const path = `machines/${encodeURIComponent(machine.id)}/tools`;
                const status = (await api(path, {})).tools;
                const install = status.filter((tool) => tool.offered && wanted.has(tool.id)).map((tool) => tool.id);

                for (const tool of status.filter((each) => wanted.has(each.id) && !each.offered)) {
                    notify("info", t("{machine}: {tool} not installed ({state}).", { machine: machine.name, tool: tool.name, state: toolState(tool) }));
                }

                if (install.length > 0) {
                    setBusy("tools");
                    const done = await api(path, { install });

                    for (const result of done.results) {
                        notify(
                            result.ok ? "info" : "error",
                            result.ok
                                ? t("{machine}: {tool} {version} installed", { machine: machine.name, tool: result.id, version: result.version })
                                : t("{machine}: {tool} not installed: {said}", { machine: machine.name, tool: result.id, said: result.said }),
                        );
                    }
                }
            }

            onChanged();
        });
    const detect = () =>
        call("detect", async () => {
            const remote = await api(`machines/${encodeURIComponent(machine.id)}/detect`, {});

            setChecked(t("{platform} {arch}, home {home}", { platform: remote.platform, arch: remote.arch, home: remote.home }));
        });
    const forget = () =>
        confirm(
            t("Forget {name}'s host key?\n\nOnly do this when you know why it changed (the machine was reinstalled). You then scan and accept the new key.", { name: machine.name }),
        ) &&
        call("forget", async () => {
            await api(`machines/${encodeURIComponent(machine.id)}/forget`, {});
            onChanged();
        });
    const remove = () =>
        confirm(
            t(
                "Remove {name}?\n\nThe app forgets it and its host key. The pi-env helper stays in ~/.pi/mobile/tools on the machine until you delete it there, and the key stays in its authorized_keys.",
                { name: machine.name },
            ),
        ) &&
        call("remove", async () => {
            await api(`machines/${encodeURIComponent(machine.id)}`, undefined, { method: "DELETE" });
            onChanged();
        });
    const copyKey = () =>
        key &&
        copyText(key.publicKey).then(
            () => notify("info", t("Public key copied.")),
            () => notify("error", t("Could not copy.")),
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
                        ? `${machine.remote.platform} ${machine.remote.arch} · pi-env ${machine.daemon} · ${t("connected {ago} ago", { ago: timeAgo(machine.connectedAt) })}`
                        : state === "trusted"
                          ? t("host key accepted · not connected yet")
                          : t("not connected yet")
                }
                ${key ? ` · ${t("key: {name}", { name: key.name })}` : ` · ${t("key missing")}`}
            </div>
            ${checked && html`<div class="muted small">${t("Reached: {what}", { what: checked })}</div>`}
            ${
                state === "connected" &&
                machine.tools &&
                html`<div class="muted small">${t("Tools: {list}", { list: Object.entries(machine.tools).map(([tool, version]) => `${tool} ${version}`).join(", ") })}</div>`
            }
            ${state === "connected" && toolsOpen && html`<${MachineToolsPanel} machine=${machine} onClose=${() => { setToolsOpen(false); onChanged(); }} />`}
            ${
                state === "connected" &&
                health !== undefined &&
                (health.ok
                    ? html`<div class="muted small">${t("Answers now (checked {ago} ago)", { ago: timeAgo(health.at) })}</div>`
                    : html`<div class="machine-problem small">
                          <strong>${t("Can't connect:")}</strong> ${health.problem}
                          ${health.said && health.said !== health.problem && html`<div class="muted mono">${health.said}</div>`}
                          <button class="link small" onClick=${onRecheck}>${t("Check again")}</button>
                      </div>`)
            }
            ${
                scan &&
                html`<div class="machine-step">
                    <p class="small">
                        ${tx("The machine presents this host key. Compare it with {command} run on the machine itself, then accept.", {
                            command: html`<span class="mono">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</span>`,
                        })}
                    </p>
                    <pre class="ssh-public-key">${scan.fingerprints.join("\n")}</pre>
                    <div class="sheet-actions">
                        <button class="button small" onClick=${() => setScan(null)}>${t("Not now")}</button>
                        <button class="button small primary" disabled=${busy !== null} onClick=${accept}>${t("Accept this key")}</button>
                    </div>
                </div>`
            }
            ${
                state === "trusted" &&
                !scan &&
                html`<div class="machine-step">
                    <p class="small">
                        ${tx(
                            "Connecting copies the app's helper program (pi-env, about 2 MB) to {path} on {name} over ssh and starts it there whenever a session works on this machine. It runs as {user}, only while connected, and is checked against its hash before every start.",
                            { path: html`<span class="mono">~/.pi/mobile/tools</span>`, name: machine.name, user: html`<span class="mono">${machine.user}</span>` },
                        )}
                    </p>
                    ${
                        catalog &&
                        html`<div class="machine-tools-pick">
                            <div class="label">${t("Also install there")}</div>
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
                                        <strong>${tool.name}</strong> ${tool.version} <span class="muted small">· ${tool.size}${tool.onlyIfMissing ? ` · ${t("only if the machine has none")}` : ""}</span>
                                        <div class="muted small">${tool.description}</div>
                                    </span>
                                </label>`,
                            )}
                        </div>`
                    }
                    <button class="button primary" disabled=${busy !== null} onClick=${connect}>
                        ${busy === "connect" ? t("Connecting…") : busy === "tools" ? t("Installing tools…") : t("Install and connect")}
                    </button>
                </div>`
            }
        </div>
        <div class="provider-actions">
            <div class="action-group">
            ${state === "new" && !scan && html`<button class="button small primary" disabled=${busy !== null} onClick=${doScan}>${busy === "scan" ? t("Scanning…") : t("Scan host key")}</button>`}
            ${
                state === "connected" &&
                html`<button
                    class="button small"
                    onClick=${() => openSheet({ type: "terminal", place: `machine:${machine.id}:${machine.remote.home}` })}
                >
                    ${t("Terminal")}
                </button>`
            }
            ${state === "connected" && html`<button class="button small" onClick=${() => openSheet({ type: "forwards", machineId: machine.id })}>${t("Ports")}</button>`}
            ${state === "connected" && html`<button class="button small" disabled=${toolsOpen} onClick=${() => setToolsOpen(true)}>${t("Install tools")}</button>`}
            ${state === "connected" && html`<button class="button small" disabled=${busy !== null} onClick=${detect}>${busy === "detect" ? t("Testing…") : t("Test")}</button>`}
            </div>
            <div class="action-group">
            ${state === "connected" && html`<button class="button small ghost" disabled=${busy !== null} onClick=${connect}>${busy === "connect" ? t("Updating…") : t("Update helper")}</button>`}
            ${key && html`<button class="button small ghost" onClick=${copyKey}>${t("Copy public key")}</button>`}
            <button class="button small ghost" onClick=${() => setEditing(true)}>${t("Edit")}</button>
            ${machine.hostKey && html`<button class="button small ghost" disabled=${busy !== null} onClick=${forget}>${t("Forget host key")}</button>`}
            <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>${t("Remove")}</button>
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

    return html`<${Sheet} title=${t("Machines")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("Other computers a session can work on. Pi's tools then run there over ssh; the conversation, its history, and your Claude sign-in stay on this phone. Each machine uses one of your SSH keys; its public half must be in the machine's {file}.", {
                file: html`<span class="mono">~/.ssh/authorized_keys</span>`,
            })}
        </p>
        ${machines === null && html`<${Loader} label=${t("Loading machines")} />`}
        ${machines !== null && machines.length === 0 && !adding && html`<p class="muted">${t("No machines yet.")}</p>`}
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
                          <${Icon} name="plus" size=${14} /> ${t("Add a machine")}
                      </button>
                  </div>`
        }
    <//>`;
}
