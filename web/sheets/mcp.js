// Settings › MCP servers (PP-528, src/server/mcp/page.ts): the owner's MCP servers. Add or change one (a command and
// where it runs, or a URL; its folders, its env with ${NAME} secrets), turn it on or off, test it for a folder (its
// tools' count), reconnect or stop it, remove it, or import an mcpServers block from Claude, Cursor or Pi. Every
// change reaches the owner's other tabs (`mcp-servers`). Laid out as the Secrets sheet.
import { useEffect, useState } from "preact/hooks";
import { api, attempt, closeSheet, store } from "../store.js";
import { Choice, html, Icon, Loader, Sheet } from "../ui.js";
import { t, tx } from "../i18n.js";

const NAME = /^[A-Za-z0-9_-]+$/;

/** `KEY=value` lines, as an object; `KEY: value` for headers. */
function pairs(text, separator) {
    return Object.fromEntries(
        text
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "")
            .map((line) => {
                const at = line.indexOf(separator);

                return at <= 0 ? [line, ""] : [line.slice(0, at).trim(), line.slice(at + separator.length).trim()];
            }),
    );
}

const lines = (text) =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

/** Where it runs, in words. */
function runsWords(server, machines) {
    if (server.kind === "http") {
        return server.runs.startsWith("machine:") ? t("over HTTP, from {machine}", { machine: machines.find((each) => each.id === server.runs.slice("machine:".length))?.name ?? server.runs }) : t("over HTTP");
    }

    if (server.runs === "phone") {
        return t("on the phone");
    }

    if (server.runs.startsWith("machine:")) {
        const id = server.runs.slice("machine:".length);

        return t("on {machine}", { machine: machines.find((each) => each.id === id)?.name ?? id });
    }

    return t("where the session works");
}

/** Its state, in words: off, changed since approved, failed, running, or ready to start. */
function stateWords(server) {
    if (!server.enabled) {
        return { text: t("Off"), tone: "muted" };
    }

    if (!server.approved) {
        return { text: t("Changed since you approved it: turn it on again to run it"), tone: "warn" };
    }

    if (server.instances.some((each) => each.state === "failed")) {
        return { text: t("Failed: reconnect it"), tone: "warn" };
    }

    const running = server.instances.filter((each) => each.state === "ready" || each.state === "starting").length;

    return running > 0 ? { text: t("Running: {n}", { n: running }), tone: "ok" } : { text: t("On, starts when a session uses it"), tone: "muted" };
}

/** The form for a new server (`server` undefined) or a change to one. */
function ServerForm({ server, machines, onDone }) {
    const entry = server?.entry ?? {};
    const [name, setName] = useState(server?.name ?? "");
    const [kind, setKind] = useState(server?.kind ?? "stdio");
    const [command, setCommand] = useState(entry.command ?? "");
    const [args, setArgs] = useState((entry.args ?? []).join("\n"));
    const [env, setEnv] = useState(Object.entries(entry.env ?? {}).map(([key, value]) => `${key}=${value}`).join("\n"));
    const [url, setUrl] = useState(entry.url ?? "");
    const [headers, setHeaders] = useState(Object.entries(entry.headers ?? {}).map(([key, value]) => `${key}: ${value}`).join("\n"));
    const [runs, setRuns] = useState(entry.runs ?? "session");
    const [folders, setFolders] = useState((entry.folders ?? []).join("\n"));
    const [description, setDescription] = useState(entry.description ?? "");
    const [askEachCall, setAskEachCall] = useState(entry.askEachCall === true);
    const [useOauth, setUseOauth] = useState(entry.oauth !== undefined);
    const [clientId, setClientId] = useState(entry.oauth?.clientId ?? "");
    const [planMode, setPlanMode] = useState(entry.planMode === true);
    const [busy, setBusy] = useState(false);
    const isNew = server === undefined;
    const ready = NAME.test(name) && (kind === "stdio" ? command.trim() !== "" : /^https?:\/\//.test(url.trim()));
    const save = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const kept = Object.fromEntries(Object.entries(entry).filter(([key]) => ["timeout", "idleMinutes", "startTimeout", "hiddenTools", "cwd", "enabled"].includes(key)));
                const common = {
                    ...kept,
                    ...(lines(folders).length === 0 ? {} : { folders: lines(folders) }),
                    ...(description.trim() === "" ? {} : { description: description.trim() }),
                    ...(askEachCall ? { askEachCall: true } : {}),
                    ...(planMode ? { planMode: true } : {}),
                };
                const next =
                    kind === "stdio"
                        ? { command: command.trim(), ...(lines(args).length === 0 ? {} : { args: lines(args) }), ...(lines(env).length === 0 ? {} : { env: pairs(env, "=") }), ...(runs === "session" ? {} : { runs }), ...common }
                        : { type: "http", url: url.trim(), ...(lines(headers).length === 0 ? {} : { headers: pairs(headers, ":") }), ...(runs.startsWith("machine:") ? { runs } : {}), ...(useOauth ? { oauth: { ...(entry.oauth ?? {}), ...(clientId.trim() === "" ? {} : { clientId: clientId.trim() }) } } : {}), ...common };

                store.set({ mcp: await api(`mcp/${encodeURIComponent(name)}`, { entry: next }, { method: "PUT" }) });
                onDone();
            } finally {
                setBusy(false);
            }
        });
    const runsOptions = [
        { value: "session", label: t("Where the session works") },
        { value: "phone", label: t("On the phone") },
        ...machines.map((machine) => ({ value: `machine:${machine.id}`, label: t("On {machine}", { machine: machine.name }) })),
    ];

    return html`<div class="secret-form mcp-form">
        ${
            isNew &&
            html`<div class="field">
                <div class="label">${t("Name")}</div>
                <input autofocus class="mono" aria-label=${t("Server name")} placeholder="gopeak" value=${name} onInput=${(event) => setName(event.currentTarget.value.replace(/[^A-Za-z0-9_-]/g, "-"))} />
                <p class="muted small">${tx("Its tools are named {pattern}.", { pattern: html`<span class="mono">mcp__${name || "name"}__…</span>` })}</p>
            </div>`
        }
        <div class="field">
            <div class="label">${t("Kind")}</div>
            <${Choice}
                label=${t("Kind")}
                value=${kind}
                options=${[
                    { value: "stdio", label: t("A command (stdio)") },
                    { value: "http", label: t("A URL (Streamable HTTP)") },
                ]}
                onChange=${setKind}
            />
        </div>
        ${
            kind === "stdio"
                ? html`<div class="field">
                          <div class="label">${t("Command")}</div>
                          <input class="mono" aria-label=${t("Command")} placeholder="npx" value=${command} onInput=${(event) => setCommand(event.currentTarget.value)} />
                      </div>
                      <div class="field">
                          <div class="label">${t("Arguments, one per line")}</div>
                          <textarea rows="3" class="mono" aria-label=${t("Arguments, one per line")} placeholder=${"-y\ngopeak@2.3.8"} value=${args} onInput=${(event) => setArgs(event.currentTarget.value)}></textarea>
                      </div>
                      <div class="field">
                          <div class="label">${t("Environment, KEY=value per line")}</div>
                          <textarea rows="2" class="mono" aria-label=${t("Environment, KEY=value per line")} placeholder=${"GODOT_PATH=~/.local/bin/godot\nAPI_KEY=${MY_SECRET}"} value=${env} onInput=${(event) => setEnv(event.currentTarget.value)}></textarea>
                      </div>
                      <div class="field">
                          <div class="label">${t("Runs")}</div>
                          <${Choice} label=${t("Runs")} value=${runs} options=${runsOptions} onChange=${setRuns} />
                      </div>`
                : html`<div class="field">
                          <div class="label">${t("URL")}</div>
                          <input class="mono" aria-label=${t("URL")} placeholder="https://example.com/mcp" value=${url} onInput=${(event) => setUrl(event.currentTarget.value)} />
                      </div>
                      <div class="field">
                          <div class="label">${t("Headers, Name: value per line")}</div>
                          <textarea rows="2" class="mono" aria-label=${t("Headers, Name: value per line")} placeholder=${"Authorization: Bearer ${MY_TOKEN}"} value=${headers} onInput=${(event) => setHeaders(event.currentTarget.value)}></textarea>
                      </div>
                      <div class="field">
                          <div class="label">${t("Reached from")}</div>
                          <${Choice}
                              label=${t("Reached from")}
                              value=${runs.startsWith("machine:") ? runs : "phone"}
                              options=${[{ value: "phone", label: t("This phone") }, ...machines.map((machine) => ({ value: `machine:${machine.id}`, label: t("{machine}, its localhost forwarded here", { machine: machine.name }) }))]}
                              onChange=${setRuns}
                          />
                      </div>
                      <div class="field">
                          <label class="check">
                              <input type="checkbox" checked=${useOauth} onChange=${(event) => setUseOauth(event.currentTarget.checked)} />
                              ${t("Sign in with OAuth")}
                          </label>
                          ${
                              useOauth &&
                              html`<input class="mono" aria-label=${t("Client ID, if the server gave you one")} placeholder=${t("Client ID, if the server gave you one")} value=${clientId} onInput=${(event) => setClientId(event.currentTarget.value)} />`
                          }
                      </div>`
        }
        <p class="muted small">${tx("Name a secret as {example}: its value goes in when the server starts, where the folder may use it.", { example: html`<span class="mono">\${NAME}</span>` })}</p>
        <div class="field">
            <div class="label">${t("Folders")}</div>
            <textarea rows="2" class="mono" aria-label=${t("Folders")} placeholder=${t("Every folder. Or one per line: /data/work/game, machine:…")} value=${folders} onInput=${(event) => setFolders(event.currentTarget.value)}></textarea>
        </div>
        <div class="field">
            <div class="label">${t("What it is for")}</div>
            <input aria-label=${t("What it is for")} placeholder=${t("Godot editor: scenes, nodes, run and screenshot")} value=${description} onInput=${(event) => setDescription(event.currentTarget.value)} />
            <label class="check">
                <input type="checkbox" checked=${askEachCall} onChange=${(event) => setAskEachCall(event.currentTarget.checked)} />
                ${t("Ask me before each call")}
            </label>
            <label class="check">
                <input type="checkbox" checked=${planMode} onChange=${(event) => setPlanMode(event.currentTarget.checked)} />
                ${t("In plan mode, trust the tools it marks read-only")}
            </label>
        </div>
        <div class="sheet-actions">
            <button class="button" onClick=${onDone}>${t("Cancel")}</button>
            <button class="button primary" disabled=${busy || !ready} onClick=${save}>${busy ? t("Saving…") : t("Save")}</button>
        </div>
    </div>`;
}

function ServerRow({ server, machines }) {
    const [editing, setEditing] = useState(false);
    const [testing, setTesting] = useState(false);
    const [folder, setFolder] = useState(server.folders[0] ?? "");
    const [tested, setTested] = useState(null);
    const [busy, setBusy] = useState(false);
    const state = stateWords(server);
    const act = (path, body, options) =>
        attempt(async () => {
            setBusy(true);

            try {
                store.set({ mcp: await api(`mcp/${encodeURIComponent(server.name)}${path}`, body, options) });
            } finally {
                setBusy(false);
            }
        });
    const test = () =>
        attempt(async () => {
            setBusy(true);

            try {
                setTested(await api(`mcp/${encodeURIComponent(server.name)}/test`, { folder }));
            } finally {
                setBusy(false);
            }
        });
    const remove = () => confirm(t("Remove the MCP server {name}?", { name: server.name })) && act("", undefined, { method: "DELETE" });
    const [pasted, setPasted] = useState("");
    const signIn = () =>
        attempt(async () => {
            setBusy(true);

            try {
                await api(`mcp/${encodeURIComponent(server.name)}/sign-in`, {});
                store.set({ mcp: await api("mcp") });
            } finally {
                setBusy(false);
            }
        });
    const finish = () => act("/sign-in/complete", { url: pasted });

    if (editing) {
        return html`<div class="provider mcp-server">
            <div>
                <div class="mono">${server.name}</div>
                <${ServerForm} server=${server} machines=${machines} onDone=${() => setEditing(false)} />
            </div>
        </div>`;
    }

    return html`<div class="provider mcp-server" data-mcp-server=${server.name}>
        <div class="mcp-server-body">
            <div class="mono">${server.name}</div>
            ${server.description !== "" && html`<div class="small">${server.description}</div>`}
            <div class="mono small mcp-command">${server.command}</div>
            <div class="muted small">
                ${runsWords(server, machines)} · ${server.folders.length === 0 ? t("every folder") : server.folders.join(", ")}${
                    server.tools === undefined ? "" : ` · ${t("{n} tools", { n: server.tools })}`
                }${server.secrets.length === 0 ? "" : ` · ${server.secrets.map((each) => `$${each}`).join(", ")}`}
            </div>
            <div class=${`small mcp-state mcp-state-${state.tone}`}>${state.text}</div>
            ${server.unpinned && html`<div class="muted small">${t("{spec} names no version: what runs can change without a new card. Pin one, such as {spec}@1.2.3.", { spec: server.unpinned })}</div>`}
            ${
                server.oauth &&
                html`<div class=${`small mcp-state mcp-state-${server.oauth.signedIn ? "ok" : "warn"}`}>${server.oauth.signedIn ? t("Signed in") : t("Not signed in")}</div>`
            }
            ${
                server.oauth?.waiting &&
                html`<div class="field mcp-sign-in">
                    <a class="button small primary" href=${server.oauth.waiting} target="_blank" rel="noopener">${t("Open the sign-in page")}</a>
                    <p class="muted small">${t("On this phone it finishes by itself. In another browser, paste the address it ended on:")}</p>
                    <input class="mono" aria-label=${t("The address the browser ended on")} placeholder="http://127.0.0.1:…/callback?code=…" value=${pasted} onInput=${(event) => setPasted(event.currentTarget.value)} />
                    <div class="sheet-actions">
                        <button class="button small" disabled=${busy || pasted.trim() === ""} onClick=${finish}>${t("Finish signing in")}</button>
                    </div>
                </div>`
            }
            ${server.instances
                .filter((each) => each.failed !== undefined)
                .map((each) => html`<div class="muted small">${each.failed}</div>`)}
            ${
                testing &&
                html`<div class="field mcp-test">
                    <div class="label">${t("Test in this folder")}</div>
                    <input class="mono" aria-label=${t("Test in this folder")} placeholder=${t("A session's folder: /data/work/game or machine:…")} value=${folder} onInput=${(event) => setFolder(event.currentTarget.value)} />
                    <div class="sheet-actions">
                        <button class="button small primary" disabled=${busy || folder.trim() === ""} onClick=${test}>${busy ? t("Testing…") : t("Test")}</button>
                    </div>
                    ${
                        tested !== null &&
                        html`<div class=${`small mcp-tested ${tested.ok ? "mcp-state-ok" : "mcp-state-warn"}`}>
                            ${tested.ok ? t("{n} tools in {seconds} s", { n: tested.tools.length, seconds: (tested.ms / 1000).toFixed(1) }) : t("It did not answer: {error}", { error: tested.error })}
                        </div>`
                    }
                </div>`
            }
        </div>
        <div class="provider-actions">
            <label class="check mcp-on">
                <input type="checkbox" aria-label=${t("On")} checked=${server.enabled && server.approved} disabled=${busy} onChange=${(event) => act("/enabled", { enabled: event.currentTarget.checked })} />
                ${t("On")}
            </label>
            <button class="button small" onClick=${() => setEditing(true)}>${t("Change")}</button>
            <button class="button small" onClick=${() => setTesting(!testing)}>${t("Test")}</button>
            ${server.oauth && html`<button class="button small" disabled=${busy} onClick=${signIn}>${t("Sign in")}</button>`}
            ${server.oauth?.signedIn && html`<button class="button small ghost" disabled=${busy} onClick=${() => act("/sign-out", {})}>${t("Sign out")}</button>`}
            ${server.instances.length > 0 && html`<button class="button small" disabled=${busy} onClick=${() => act("/reconnect", {})}>${t("Reconnect")}</button>`}
            ${server.instances.some((each) => each.state === "ready") && html`<button class="button small" disabled=${busy} onClick=${() => act("/stop", {})}>${t("Stop")}</button>`}
            <button class="button small ghost" onClick=${remove}>${t("Remove")}</button>
        </div>
    </div>`;
}

/** Paste an mcpServers block from Claude, Cursor or Pi. */
function ImportForm({ onDone }) {
    const [text, setText] = useState("");
    const [replace, setReplace] = useState(false);
    const [result, setResult] = useState(null);
    const [busy, setBusy] = useState(false);
    const run = () =>
        attempt(async () => {
            setBusy(true);

            try {
                const done = await api("mcp/import", { text, replace });

                setResult(done);
                store.set({ mcp: await api("mcp") });

                if (done.errors.length === 0) {
                    onDone();
                }
            } finally {
                setBusy(false);
            }
        });

    return html`<div class="secret-form mcp-import">
        <div class="field">
            <div class="label">${t("An mcpServers block")}</div>
            <textarea rows="6" class="mono" aria-label=${t("An mcpServers block")} placeholder=${'{"mcpServers": {"gopeak": {"command": "npx", "args": ["-y", "gopeak@2.3.8"]}}}'} value=${text} onInput=${(event) => setText(event.currentTarget.value)}></textarea>
            <label class="check">
                <input type="checkbox" checked=${replace} onChange=${(event) => setReplace(event.currentTarget.checked)} />
                ${t("Replace servers of the same name")}
            </label>
        </div>
        ${
            result !== null &&
            html`<div class="small">
                ${result.saved.length > 0 && html`<div>${t("Imported: {names}", { names: result.saved.join(", ") })}</div>`}
                ${result.errors.map((each) => html`<div class="mcp-state-warn">${each.name}: ${each.error}</div>`)}
            </div>`
        }
        <div class="sheet-actions">
            <button class="button" onClick=${onDone}>${t("Cancel")}</button>
            <button class="button primary" disabled=${busy || text.trim() === ""} onClick=${run}>${busy ? t("Importing…") : t("Import")}</button>
        </div>
    </div>`;
}

export function McpSheet() {
    const view = store.state.mcp;
    const [adding, setAdding] = useState(false);
    const [importing, setImporting] = useState(false);

    useEffect(() => {
        attempt(async () => store.set({ mcp: await api("mcp") }));
    }, []);

    return html`<${Sheet} title=${t("MCP servers")} onClose=${closeSheet}>
        <p class="muted small">
            ${tx("Programs and services that give Pi more tools. Each tool waits until Pi looks for it with {search}, and only in the folders its server serves. A command runs as you, where the session works or where you pin it; Pi asks you on a card before it adds or changes one.", { search: html`<span class="mono">tool_search</span>` })}
        </p>
        ${view === null && html`<${Loader} label=${t("Loading MCP servers")} />`}
        ${view !== null && view.servers.length === 0 && !adding && !importing && html`<p class="muted">${t("No MCP servers yet.")}</p>`}
        ${
            view !== null &&
            view.servers.length > 0 &&
            html`<div class="sheet-list">${view.servers.map((server) => html`<${ServerRow} key=${server.name} server=${server} machines=${view.machines} />`)}</div>`
        }
        ${view !== null && view.problems.map((problem) => html`<p class="small mcp-state-warn">${problem.name}: ${problem.error}</p>`)}
        ${adding && html`<${ServerForm} machines=${view?.machines ?? []} onDone=${() => setAdding(false)} />`}
        ${importing && html`<${ImportForm} onDone=${() => setImporting(false)} />`}
        ${
            !adding &&
            !importing &&
            html`<div class="sheet-actions">
                <button class="button" onClick=${() => setImporting(true)}>${t("Import JSON")}</button>
                <button class="button primary" onClick=${() => setAdding(true)}><${Icon} name="plus" size=${16} /> ${t("Add a server")}</button>
            </div>`
        }
    <//>`;
}
