// Machines (src/server/machines.ts): other computers sessions can work on, over ssh with one of the app's SSH keys.
// Add one, accept its host key, approve the daemon install, test it, edit, remove. Laid out as the Providers sheet.
import { useEffect, useState } from "preact/hooks";
import { agoText, t, tx } from "../i18n.js";
import { api, attempt, closeSheet, notify, openSheet } from "../store.js";
import { Choice, copyText, html, Icon, Loader, Sheet } from "../ui.js";
import { windowsSetupScript } from "../windows-setup.js";
import { CrdConnectForm } from "../crd-connect.js";

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
 * A new team machine (PP-82), or a team machine's new name: on the team server, which makes and keeps its key. Its
 * public half then shows on its row, to put in the machine's authorized_keys.
 */
function TeamMachineForm({ machine, onDone }) {
    const [name, setName] = useState(machine?.name ?? "");
    const [where, setWhere] = useState("");
    const [busy, setBusy] = useState(false);
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                onDone(await api(machine ? `machines/${encodeURIComponent(machine.id)}` : "machines", machine ? { name } : { team: true, name, address: where }));
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="machine-form">
        ${!machine && html`<div class="label">${t("Add team machine")}</div>`}
        <div class="field">
            <div class="label">${t("Name")}</div>
            <input autofocus aria-label=${t("Machine name")} placeholder=${t("build-box")} value=${name} onInput=${(event) => setName(event.currentTarget.value)} />
        </div>
        ${
            !machine &&
            html`<div class="field">
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
            <p class="muted small">${t("The team server makes a key for it and keeps it; nobody's pi-phone gets it. Everyone it's shared with works in this one account, and can read each other's files there.")}</p>`
        }
        <div class="sheet-actions">
            <button class="button" onClick=${() => onDone(null)}>${t("Cancel")}</button>
            <button class="button primary" disabled=${busy || name.trim() === "" || (!machine && where.trim() === "")} onClick=${save}>
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

/** Chrome Remote Desktop's state (PP-263), in the app's words. */
const crdWordText = (word) => (word === "connected" ? t("connected") : word === "installed, not connected" ? t("installed, not connected") : t("not installed"));

/** A tool's version as the lists show it: Chrome Remote Desktop's is Google's current build, checked by its signer. */
const toolVersion = (tool) => (tool.signer ? t("signed by {signer}", { signer: tool.signer.replace(/^CN=/, "") }) : tool.version);

/** Where a tool stands on a machine, in a few words. */
function toolState(tool) {
    if (!tool.supported) {
        return tool.windowsOnly ? t("for Windows only, for now") : t("no build for this machine");
    }

    if (tool.crd) {
        return tool.installed ? `${t("installed, {version}", { version: tool.installed })} · ${crdWordText(tool.crd)}` : t("not installed · {size}", { size: tool.size });
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
 * ticked (but for the big ones, `optIn`: ffmpeg, HyperFrames), and Install for those ticked.
 */
function MachineToolsPanel({ machine, onClose }) {
    const [tools, setTools] = useState(null);
    const [ticked, setTicked] = useState(new Set());
    const [busy, setBusy] = useState(false);
    const path = `machines/${encodeURIComponent(machine.id)}/tools`;
    const show = (list) => {
        setTools(list);
        setTicked(new Set(list.filter((tool) => tool.offered && !tool.optIn).map((tool) => tool.id)));
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
                        <strong>${tool.name}</strong> ${toolVersion(tool)}
                        <span class="muted small"> · ${toolState(tool)}${tool.desktop ? ` · ${t("needs a desktop session on Linux")}` : ""}</span>
                        <div class="muted small">${tool.description}</div>
                    </span>
                </label>`,
            )
        }
        <p class="muted small">
            ${tx("Each is downloaded by the machine itself, checked against its pinned sha256, into {path}, and put first on bash's PATH in sessions there.", { path: html`<span class="mono">~/.pi/mobile/tools</span>` })}
        </p>
        ${
            tools?.some((tool) => tool.signer && tool.supported) &&
            html`<p class="muted small">${t("Chrome Remote Desktop is Google's own installer, downloaded by the machine from Google (not passed on by pi-phone): its address always gives Google's newest build, so it is checked by Google's signature instead of a pinned sha256, and installed with msiexec (it needs administrator rights).")}</p>`
        }
        <div class="sheet-actions">
            <button class="button small" disabled=${busy} onClick=${onClose}>${t("Close")}</button>
            <button class="button small primary" disabled=${busy || ticked.size === 0} onClick=${install}>${busy ? t("Installing…") : t("Install")}</button>
        </div>
    </div>`;
}

/**
 * Chrome Remote Desktop on one of the owner's Windows machines (PP-263): not installed, installed but not connected
 * (Connect to your Google account: Google's steps, the command and a PIN, to the machine alone), or connected (Remove,
 * after a confirmation). Read afresh as the row shows, with a quick PowerShell over the machine's connection.
 */
function CrdRow({ machine, onChanged }) {
    const [crd, setCrd] = useState(null);
    const [connecting, setConnecting] = useState(false);
    const [busy, setBusy] = useState(null);
    const path = `machines/${encodeURIComponent(machine.id)}/crd`;
    const call = (what, run) =>
        attempt(async () => {
            setBusy(what);

            try {
                await run();
            } finally {
                setBusy(null);
            }
        });

    useEffect(() => {
        api(path, {}).then(setCrd, (error) => setCrd({ problem: error.message }));
    }, [path, machine.tools?.crd]);

    const connect = (values) =>
        call("connect", async () => {
            setCrd(await api(path, { connect: values }));
            setConnecting(false);
            notify("info", t("{machine}: Chrome Remote Desktop is connected. Unlock it from the Chrome Remote Desktop app on your phone, with your PIN.", { machine: machine.name }));
        });
    const remove = () =>
        confirm(
            t(
                "Remove Chrome Remote Desktop from {name}?\n\nThe host stops, msiexec removes it, and its connection to your Google account is deleted from the machine. The machine stays in your list at remotedesktop.google.com/access, offline, until you delete it there.",
                { name: machine.name },
            ),
        ) &&
        call("remove", async () => {
            setCrd(await api(path, { remove: true }));
            onChanged();
        });

    return html`<div class="machine-crd">
        <div class="small">
            <strong>${t("Chrome Remote Desktop")}</strong>
            <span class="muted"> · ${crd === null ? t("looking…") : crd.problem ? t("unknown: {problem}", { problem: crd.problem }) : crdWordText(crd.word)}${crd?.state?.version ? ` · ${crd.state.version}` : ""}</span>
        </div>
        ${crd?.word === "not installed" && html`<div class="muted small">${t("To unlock and see this computer from your phone, tick it under Install tools.")}</div>`}
        ${
            crd?.word === "installed, not connected" &&
            (connecting
                ? html`<div class="machine-step">
                      <div class="label">${t("Connect to your Google account")}</div>
                      <${CrdConnectForm} machineName=${machine.name} busy=${busy === "connect"} onCancel=${() => setConnecting(false)} onSubmit=${connect} />
                  </div>`
                : html`<div class="sheet-actions">
                      <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>${busy === "remove" ? t("Removing…") : t("Remove Chrome Remote Desktop")}</button>
                      <button class="button small primary" disabled=${busy !== null} onClick=${() => setConnecting(true)}>${t("Connect to your Google account")}</button>
                  </div>`)
        }
        ${
            crd?.word === "connected" &&
            html`<div class="muted small">${t("Unlock and see it from the Chrome Remote Desktop app on your phone, with your PIN.")}</div>
                <div class="sheet-actions">
                    <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>${busy === "remove" ? t("Removing…") : t("Remove Chrome Remote Desktop")}</button>
                </div>`
        }
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
    // Tools to install once it connects: every tool ticked but the big ones (`optIn`), as the owner chose (they untick
    // what they don't want).
    const [catalog, setCatalog] = useState(null);
    const [wanted, setWanted] = useState(new Set());

    useEffect(() => {
        if (machine.hostKey && !machine.remote && catalog === null) {
            attempt(async () => {
                const list = (await api("machines/tools")).tools;

                setCatalog(list);
                setWanted(new Set(list.filter((tool) => !tool.optIn).map((tool) => tool.id)));
            });
        }
    }, [machine.hostKey, machine.remote]);
    // A team machine (PP-82): the team server's key (its public half here), and what this person may do with it.
    const team = machine.team;
    const manage = team?.manage === true;
    const key = team ? { name: t("the team's"), publicKey: team.publicKey } : keys.find((each) => each.id === machine.keyId);
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
            team
                ? t("Remove {name} for the whole team?\n\nEveryone's sessions there stop, and the team server deletes its key. The files on the machine stay, and the key's public half stays in its authorized_keys.", { name: machine.name })
                : t(
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
        const done = () => {
            setEditing(false);
            onChanged();
        };

        return html`<div class="provider machine">
            ${team ? html`<${TeamMachineForm} machine=${machine} onDone=${done} />` : html`<${MachineForm} machine=${machine} keys=${keys} onDone=${done} />`}
        </div>`;
    }

    const state = machine.remote ? "connected" : machine.hostKey ? "trusted" : "new";

    return html`<div class="provider machine">
        <div>
            <div>
                ${machine.name}
                ${team && html` <span class="pv-team-tag">${t("Team")}</span>`}
                ${state === "connected" && health?.ok !== false && html` <span class="ok">✓</span>`}
                ${state === "connected" && health?.ok === false && html` <span class="warn">⚠</span>`}
            </div>
            <div class="muted small mono">${address(machine)}</div>
            <div class="muted small">
                ${
                    state === "connected"
                        ? `${machine.remote.platform} ${machine.remote.arch} · pi-env ${machine.daemon} · ${t("connected {when}", { when: agoText(machine.connectedAt) })}`
                        : state === "trusted"
                          ? t("host key accepted · not connected yet")
                          : t("not connected yet")
                }
                ${team ? ` · ${t("the team's key")}` : key ? ` · ${t("key: {name}", { name: key.name })}` : ` · ${t("key missing")}`}
            </div>
            ${
                team &&
                html`<div class="muted small">
                    ${
                        manage
                            ? team.roles.length > 0
                                ? t("Roles that may use it: {roles}", { roles: team.roles.join(", ") })
                                : t("No role may use it yet: choose them in People & account › Roles.")
                            : t("The team's: set up by someone who manages the team's machines.")
                    }
                </div>`
            }
            ${team && state === "connected" && html`<div class="muted small">${tx("Your folder there: {path}", { path: html`<span class="mono">~/${team.folder}</span>` })}</div>`}
            ${
                team &&
                state === "new" &&
                (manage
                    ? html`<div class="machine-step">
                          <p class="small">${tx("Put the team's key for it in {file} of {user} on the machine, then scan its host key:", { file: html`<span class="mono">~/.ssh/authorized_keys</span>`, user: html`<span class="mono">${machine.user}</span>` })}</p>
                          <pre class="ssh-public-key">${team.publicKey}</pre>
                      </div>`
                    : html`<p class="muted small">${t("Not set up yet: someone who manages the team's machines sets it up.")}</p>`)
            }
            ${checked && html`<div class="muted small">${t("Reached: {what}", { what: checked })}</div>`}
            ${
                state === "connected" &&
                machine.tools &&
                html`<div class="muted small">${t("Tools: {list}", { list: Object.entries(machine.tools).map(([tool, version]) => `${tool} ${version}`).join(", ") })}</div>`
            }
            ${state === "connected" && !team && machine.remote.platform === "windows" && machine.remote.arch === "x64" && html`<${CrdRow} machine=${machine} onChanged=${onChanged} />`}
            ${state === "connected" && toolsOpen && html`<${MachineToolsPanel} machine=${machine} onClose=${() => { setToolsOpen(false); onChanged(); }} />`}
            ${
                // PP-230: off by default, as bash on the phone runs without asking; Pi's tool is the setting machines.askRun.
                !team &&
                html`<label class="check small machine-ask-run">
                    <input
                        type="checkbox"
                        checked=${machine.askRun === true}
                        disabled=${busy !== null}
                        onChange=${(event) => {
                            const askRun = event.currentTarget.checked;

                            call("askRun", async () => {
                                await api(`machines/${encodeURIComponent(machine.id)}`, { askRun });
                                onChanged();
                            });
                        }}
                    />
                    <span>${t("Pi asks before each command it runs here (machine_run): a card shows the command first")}</span>
                </label>`
            }
            ${
                // PP-274: how Pi's browser runs here; Pi's tool is the setting browser.machineMode. macOS comes later.
                !team &&
                state === "connected" &&
                html`<div class="machine-browser-mode small">
                    <span>${t("Pi's browser here")}</span>
                    <${Choice}
                        label=${t("Pi's browser here")}
                        value=${machine.browserMode ?? "headless"}
                        disabled=${busy !== null || machine.remote?.platform === "darwin"}
                        options=${[
                            { value: "headless", label: t("Headless (no window)") },
                            { value: "window", label: t("A window on its screen") },
                        ]}
                        onChange=${(browserMode) =>
                            browserMode !== (machine.browserMode ?? "headless") &&
                            call("browserMode", async () => {
                                await api(`machines/${encodeURIComponent(machine.id)}`, { browserMode });
                                onChanged();
                            })}
                    />
                    <span class="muted">
                        ${
                            machine.remote?.platform === "darwin"
                                ? t("A window on macOS comes later.")
                                : machine.remote?.platform === "windows"
                                  ? t("A window opens in your signed-in desktop, unlocked; it needs Chrome or Edge, not the headless machine tool. A change restarts it: its tabs close.")
                                  : t("A window needs a display (the desktop setup line in Menu › Computer control) and Chrome or Chromium, not the headless machine tool. A change restarts it: its tabs close.")
                        }
                    </span>
                </div>`
            }
            ${
                state === "connected" &&
                health !== undefined &&
                (health.ok
                    ? html`<div class="muted small">${t("Answers now (checked {when})", { when: agoText(health.at) })}</div>`
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
                (!team || manage) &&
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
                                        <strong>${tool.name}</strong> ${toolVersion(tool)} <span class="muted small">· ${tool.size}${tool.onlyIfMissing ? ` · ${t("only if the machine has none")}` : ""}${tool.desktop ? ` · ${t("needs a desktop session on Linux")}` : ""}${tool.windowsOnly ? ` · ${t("for Windows only, for now")}` : ""}</span>
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
            ${state === "new" && !scan && (!team || manage) && html`<button class="button small primary" disabled=${busy !== null} onClick=${doScan}>${busy === "scan" ? t("Scanning…") : t("Scan host key")}</button>`}
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
            ${state === "connected" && (!team || manage) && html`<button class="button small" disabled=${toolsOpen} onClick=${() => setToolsOpen(true)}>${t("Install tools")}</button>`}
            ${state === "connected" && html`<button class="button small" disabled=${busy !== null} onClick=${detect}>${busy === "detect" ? t("Testing…") : t("Test")}</button>`}
            </div>
            ${
                (!team || manage) &&
                html`<div class="action-group">
                    ${state === "connected" && html`<button class="button small ghost" disabled=${busy !== null} onClick=${connect}>${busy === "connect" ? t("Updating…") : t("Update helper")}</button>`}
                    ${key && html`<button class="button small ghost" onClick=${copyKey}>${t("Copy public key")}</button>`}
                    <button class="button small ghost" onClick=${() => setEditing(true)}>${team ? t("Rename") : t("Edit")}</button>
                    ${machine.hostKey && !team && html`<button class="button small ghost" disabled=${busy !== null} onClick=${forget}>${t("Forget host key")}</button>`}
                    <button class="button small ghost" disabled=${busy !== null} onClick=${remove}>${t("Remove")}</button>
                </div>`
            }
        </div>
    </div>`;
}

export function MachinesSheet() {
    const [machines, setMachines] = useState(null);
    const [keys, setKeys] = useState([]);
    const [adding, setAdding] = useState(false);
    // The team server's machines (PP-82): whether there are any here, and whether this person manages them.
    const [team, setTeam] = useState({ available: false, manage: false });
    const [addingTeam, setAddingTeam] = useState(false);
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
        setTeam(list.team ?? { available: false, manage: false });
        setKeys(keyList.keys);
    };
    const own = (machines ?? []).filter((machine) => !machine.team);
    const teams = (machines ?? []).filter((machine) => machine.team);
    const row = (machine) => html`<${MachineRow} key=${machine.id} machine=${machine} keys=${keys} health=${health[machine.id]} onRecheck=${recheck} onChanged=${() => attempt(load)} />`;

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
        ${machines !== null && own.length === 0 && !adding && html`<p class="muted">${teams.length > 0 ? t("No machines of your own yet.") : t("No machines yet.")}</p>`}
        ${machines !== null && own.length > 0 && html`<div class="sheet-list">${own.map(row)}</div>`}
        ${
            machines !== null &&
            team.available &&
            (teams.length > 0 || team.manage) &&
            html`<div class="label machines-team-title">${t("Team machines")}</div>
                ${teams.length > 0 ? html`<div class="sheet-list">${teams.map(row)}</div>` : html`<p class="muted small">${t("None yet. A team machine is added once for everyone, and roles say who may use it.")}</p>`}`
        }
        ${
            adding || addingTeam
                ? adding
                    ? html`<${MachineForm}
                          keys=${keys}
                          onDone=${(saved) => {
                              setAdding(false);

                              if (saved) {
                                  attempt(load);
                              }
                          }}
                      />`
                    : html`<${TeamMachineForm}
                          onDone=${(saved) => {
                              setAddingTeam(false);

                              if (saved) {
                                  attempt(load);
                              }
                          }}
                      />`
                : machines !== null &&
                  html`<div class="sheet-actions">
                      ${
                          team.available &&
                          team.manage &&
                          html`<button class="button" onClick=${() => setAddingTeam(true)}>
                              <${Icon} name="plus" size=${14} /> ${t("Add team machine")}
                          </button>`
                      }
                      <button class="button primary" onClick=${() => setAdding(true)}>
                          <${Icon} name="plus" size=${14} /> ${t("Add a machine")}
                      </button>
                  </div>`
        }
    <//>`;
}
